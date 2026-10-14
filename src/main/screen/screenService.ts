/**
 * screenService — 屏幕截图 / 区域选择遮罩 / 矩形录屏
 * 职责：desktopCapturer 截取、跨屏区域选择、隐藏窗 MediaRecorder 录制。
 * 被 pluginHandlers 的 screen.* 方法调用。
 * 关键依赖：electron desktopCapturer/screen/BrowserWindow/nativeImage。
 */
import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  screen,
  type IpcMainEvent
} from 'electron'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import { resolvePreload } from '@main/window/createShellWindow'
import { IpcChannels } from '@shared/types/ipc'
import type { ScreenBounds, ScreenCaptureResult } from '@shared/types/plugin'
import { logInfo, logWarn } from '@main/logs/logService'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'

type RuntimeScope = NonNullable<ReturnType<typeof getRuntimeScope>>
type RecordingResult = { path: string; size: number; durationMs: number }
type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  // Sessions may finish after their owner has gone away, with no IPC caller awaiting them.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

interface RecordSession {
  id: string
  scope: RuntimeScope
  win: BrowserWindow | null
  phase: 'starting' | 'recording' | 'stopping' | 'finished'
  startedAt: number
  stoppedAt?: number
  partFile: string
  outFile: string
  appendQueue: Promise<void>
  queuedBytes: number
  paused: boolean
  finalizing: boolean
  deadline?: ReturnType<typeof setTimeout>
  ready: Deferred<void>
  result: Deferred<RecordingResult>
  release: () => void
}

interface RegionSession {
  scope: RuntimeScope
  win: BrowserWindow | null
  result: Deferred<ScreenBounds | null>
  release: () => void
  finished: boolean
}

const RECORDING_STOP_TIMEOUT_MS = 10_000
const RECORDING_START_TIMEOUT_MS = 15_000
const MAX_QUEUED_BYTES = 8 * 1024 * 1024
const PAUSE_QUEUED_BYTES = 2 * 1024 * 1024
const RESUME_QUEUED_BYTES = 1024 * 1024
const recordSessions = new Map<string, RecordSession>()
let regionSession: RegionSession | null = null

function requireScope(pluginId: string): RuntimeScope {
  const scope = getRuntimeScope(pluginId)
  if (!scope || !scope.isCurrent() || scope.signal.aborted) {
    throw new Error('plugin runtime is closed')
  }
  return scope
}

function isCurrent(scope: RuntimeScope): boolean {
  return scope.isCurrent() && !scope.signal.aborted
}

/** Closing a runtime aborts capture immediately; detached file finalization has its own deadline. */
function ownActivity(scope: RuntimeScope, reason: string, dispose: () => void): () => void {
  const releaseActivity = scope.acquireActivity(reason)
  const removeDisposer = scope.addDisposer(dispose)
  scope.signal.addEventListener('abort', dispose, { once: true })
  let released = false
  return () => {
    if (released) return
    released = true
    scope.signal.removeEventListener('abort', dispose)
    removeDisposer()
    releaseActivity()
  }
}

function recordingsDir(): string {
  return join(getAppPaths().root, 'recordings')
}

function resolveDisplay(displayId?: number): Electron.Display {
  const displays = screen.getAllDisplays()
  if (displayId != null) {
    const hit = displays.find((d) => d.id === displayId)
    if (hit) return hit
  }
  return screen.getPrimaryDisplay()
}

function boundsToIntersect(b: ScreenBounds, dw: number, dh: number): ScreenBounds {
  const x = Math.max(0, Math.min(dw, Math.floor(b.x)))
  const y = Math.max(0, Math.min(dh, Math.floor(b.y)))
  const width = Math.max(1, Math.min(dw - x, Math.floor(b.width)))
  const height = Math.max(1, Math.min(dh - y, Math.floor(b.height)))
  return { x, y, width, height }
}

async function captureDisplayNative(display: Electron.Display): Promise<Electron.NativeImage> {
  const { size, scaleFactor } = display
  const tw = Math.max(1, Math.round(size.width * scaleFactor))
  const th = Math.max(1, Math.round(size.height * scaleFactor))
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: tw, height: th }
  })
  const sid = String(display.id)
  const source =
    sources.find((s) => s.display_id === sid) ??
    sources.find((s) => s.id.includes(sid)) ??
    sources[0]
  if (!source) throw new Error('screen capture failed: no display source')
  return source.thumbnail
}

/** 截取指定显示器的全部或局部区域，返回 PNG dataURL */
export async function captureScreen(opts?: {
  displayId?: number
  bounds?: ScreenBounds
}): Promise<ScreenCaptureResult> {
  const display = resolveDisplay(opts?.displayId)
  let image = await captureDisplayNative(display)
  const size = image.getSize()
  if (opts?.bounds) {
    const crop = boundsToIntersect(opts.bounds, size.width, size.height)
    image = image.crop({ x: crop.x, y: crop.y, width: crop.width, height: crop.height })
  }
  const cropped = image.getSize()
  return {
    dataUrl: image.toDataURL(),
    width: cropped.width,
    height: cropped.height
  }
}

function finishRegion(session: RegionSession, bounds: ScreenBounds | null, error?: Error): void {
  if (session.finished) return
  session.finished = true
  if (regionSession === session) regionSession = null
  session.release()
  if (session.win && !session.win.isDestroyed()) session.win.destroy()
  if (error) session.result.reject(error)
  else session.result.resolve(bounds)
}

/** 打开全屏区域选择遮罩；用户确认返回设备像素 bounds，取消返回 null */
export function selectRegion(pluginId: string): Promise<ScreenBounds | null> {
  const scope = requireScope(pluginId)
  if (regionSession) finishRegion(regionSession, null)
  const session: RegionSession = {
    scope, win: null, result: deferred<ScreenBounds | null>(), release: () => {}, finished: false
  }
  regionSession = session
  session.release = ownActivity(scope, 'screen region selection', () => finishRegion(session, null))
  void (async () => {
    try {
      const display = screen.getPrimaryDisplay()
      const shot = await captureDisplayNative(display)
      if (session.finished || !isCurrent(scope)) return finishRegion(session, null)
      const { width, height } = shot.getSize()
      const win = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        fullscreen: true,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: resolvePreload('regionOverlayPreload.js')
        }
      })
      session.win = win
      win.setAlwaysOnTop(true, 'screen-saver')
      if (process.platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      }
      win.once('closed', () => finishRegion(session, null))
      win.webContents.once('render-process-gone', () => finishRegion(session, null))
      win.webContents.once('preload-error', (_event, _path, error) => finishRegion(session, null, error))
      await win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(buildRegionHtml(shot.toDataURL(), width, height))}`
      )
      if (session.finished || !isCurrent(scope)) return finishRegion(session, null)
      win.showInactive()
      win.focus()
    } catch (error) {
      finishRegion(session, null, error as Error)
    }
  })()
  return session.result.promise
}

function buildRegionHtml(dataUrl: string, imgW: number, imgH: number): string {
  // 冻结截图 + 拖拽矩形；preload 收结果
  return `<!doctype html><html><head><meta charset="utf-8"/><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;cursor:crosshair;user-select:none}
#bg{position:fixed;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none}
#dim{position:fixed;inset:0;background:rgba(0,0,0,.35);pointer-events:none}
#sel{position:fixed;border:1px solid #5b8cff;box-shadow:0 0 0 9999px rgba(0,0,0,.45);display:none;pointer-events:none}
#hint{position:fixed;left:12px;bottom:12px;color:#fff;font:12px/1.4 system-ui,sans-serif;background:rgba(0,0,0,.55);padding:6px 10px;border-radius:6px;pointer-events:none}
</style></head><body>
<img id="bg" src="${dataUrl}" alt=""/>
<div id="sel"></div>
<div id="hint">拖拽选择区域 · Enter 确认 · Esc 取消</div>
<script>
const imgW=${imgW}, imgH=${imgH};
let sx=0,sy=0,ex=0,ey=0,dragging=false;
const sel=document.getElementById('sel');
function draw(){
  const x=Math.min(sx,ex), y=Math.min(sy,ey), w=Math.abs(ex-sx), h=Math.abs(ey-sy);
  sel.style.display = (dragging||w>2||h>2)?'block':'none';
  sel.style.left=x+'px'; sel.style.top=y+'px'; sel.style.width=w+'px'; sel.style.height=h+'px';
}
function deviceBounds(){
  const dprX=imgW/innerWidth, dprY=imgH/innerHeight;
  const x=Math.round(Math.min(sx,ex)*dprX), y=Math.round(Math.min(sy,ey)*dprY);
  const w=Math.round(Math.abs(ex-sx)*dprX), h=Math.round(Math.abs(ey-sy)*dprY);
  return {x,y,width:Math.max(1,w),height:Math.max(1,h)};
}
addEventListener('mousedown',e=>{sx=ex=e.clientX;sy=ey=e.clientY;dragging=true;draw()});
addEventListener('mousemove',e=>{if(!dragging)return;ex=e.clientX;ey=e.clientY;draw()});
addEventListener('mouseup',e=>{
  ex=e.clientX;ey=e.clientY;dragging=false;draw();
  const b=deviceBounds();
  if(b.width>3&&b.height>3) window.regionOverlay?.confirm(b);
});
addEventListener('keydown',e=>{
  if(e.key==='Escape') window.regionOverlay?.cancel();
  if(e.key==='Enter'){
    const b=deviceBounds();
    if(b.width>3&&b.height>3) window.regionOverlay?.confirm(b);
  }
});
</script></body></html>`
}

function wireRegionIpcOnce(): void {
  if (ipcMain.listenerCount(IpcChannels.PluginRegionConfirm) > 0) return
  const resolveRegion = (event: IpcMainEvent): RegionSession | null => {
    const session = regionSession
    return session && !session.finished && isCurrent(session.scope) && session.win &&
      !session.win.isDestroyed() && session.win.webContents === event.sender &&
      event.senderFrame === session.win.webContents.mainFrame ? session : null
  }
  ipcMain.on(IpcChannels.PluginRegionConfirm, (event: IpcMainEvent, bounds: ScreenBounds) => {
    const session = resolveRegion(event)
    if (!session) return
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
        bounds.width < 1 || bounds.height < 1) {
      finishRegion(session, null)
      return
    }
    finishRegion(session, {
      x: Math.max(0, Math.floor(bounds.x)), y: Math.max(0, Math.floor(bounds.y)),
      width: Math.max(1, Math.floor(bounds.width)), height: Math.max(1, Math.floor(bounds.height))
    })
  })
  ipcMain.on(IpcChannels.PluginRegionCancel, (event: IpcMainEvent) => {
    const session = resolveRegion(event)
    if (session) finishRegion(session, null)
  })
}

function buildRecorderHtml(sourceId: string, withAudio: boolean, crop: ScreenBounds): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><style>
html,body{margin:0;background:transparent;overflow:hidden}
video{position:fixed;left:-9999px;top:0}
</style></head><body>
<video id="v" muted playsinline></video>
<script>
const sourceId=${JSON.stringify(sourceId)};
const withAudio=${withAudio ? 'true' : 'false'};
const crop=${JSON.stringify(crop)};
let recorder=null, raw=null, out=null, raf=0, frame=0, stopped=false, failed=false;
let chunks=Promise.resolve(), pendingBytes=0;
const v=document.getElementById('v');
function releaseCapture(){
  cancelAnimationFrame(raf);
  if(frame&&v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(frame);
  if(raw) raw.getTracks().forEach(t=>t.stop());
  if(out) out.getTracks().forEach(t=>t.stop());
  v.srcObject=null;
}
function fail(error){
  if(failed)return;
  failed=true;stopped=true;
  try{if(recorder&&recorder.state!=='inactive')recorder.stop()}catch{}
  releaseCapture();
  window.recorderBridge?.failed(String(error?.message||error));
}
function stop(){
  if(stopped)return;
  stopped=true;
  try{if(recorder&&recorder.state!=='inactive')recorder.stop()}catch(e){fail(e)}
  // End desktop/audio acquisition now; only already encoded chunks may drain afterwards.
  releaseCapture();
}
window.recorderCtl={
  stop, cancel:stop,
  pause(){if(!stopped&&recorder?.state==='recording')recorder.pause()},
  resume(){if(!stopped&&recorder?.state==='paused')recorder.resume()}
};
async function boot(){
  try{
    const videoConstraint={mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:sourceId,
      maxWidth:4096,maxHeight:4096,maxFrameRate:30}};
    try{
      raw=await navigator.mediaDevices.getUserMedia({
        audio:withAudio?{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:sourceId}}:false,
        video:videoConstraint
      });
    }catch(error){
      if(stopped) return;
      if(!withAudio)throw error;
      raw=await navigator.mediaDevices.getUserMedia({video:videoConstraint});
      window.recorderBridge?.audioUnavailable(String(error?.message||error));
    }
    if(stopped){releaseCapture();return}
    v.srcObject=raw;
    await v.play();
    if(stopped){releaseCapture();return}
    const cw=Math.max(1,crop.width|0),ch=Math.max(1,crop.height|0);
    const canvas=document.createElement('canvas');
    canvas.width=cw;canvas.height=ch;
    const ctx=canvas.getContext('2d');
    if(!ctx)throw new Error('recording canvas unavailable');
    const tick=()=>{
      if(stopped)return;
      try{ctx.drawImage(v,crop.x,crop.y,cw,ch,0,0,cw,ch)}catch{}
      if(v.requestVideoFrameCallback)frame=v.requestVideoFrameCallback(tick);
      else raf=requestAnimationFrame(tick);
    };
    tick();
    out=canvas.captureStream(30);
    for(const track of raw.getAudioTracks())out.addTrack(track);
    const mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ?'video/webm;codecs=vp8,opus':'video/webm';
    recorder=new MediaRecorder(out,{mimeType:mime,videoBitsPerSecond:4_000_000});
    recorder.ondataavailable=(event)=>{
      if(failed||!event.data?.size)return;
      const blob=event.data;
      if(pendingBytes+blob.size>${MAX_QUEUED_BYTES})return fail(new Error('recording chunk queue exceeded limit'));
      pendingBytes+=blob.size;
      // Blob conversion is asynchronous: serialize it before sending, including the final chunk.
      chunks=chunks.then(async()=>{
        if(failed)return;
        const buf=await blob.arrayBuffer();
        if(!failed)window.recorderBridge?.chunk(buf);
      }).catch(fail).finally(()=>{pendingBytes-=blob.size});
    };
    recorder.onerror=(event)=>fail(event.error||new Error('media recorder failed'));
    recorder.onstop=()=>{
      stopped=true;releaseCapture();
      void chunks.then(()=>{if(!failed)window.recorderBridge?.stopped()}).catch(fail);
    };
    recorder.start(250);
    window.recorderBridge?.started();
  }catch(error){fail(error)}
}
void boot();
</script></body></html>`
}

function destroyRecorder(session: RecordSession): void {
  const win = session.win
  session.win = null
  if (win && !win.isDestroyed()) win.destroy()
}

/** The only terminal transition. Identity is per session, so old cleanup cannot touch a new runtime. */
function finishRecording(session: RecordSession, result?: RecordingResult, error?: Error): void {
  if (session.phase === 'finished') return
  session.phase = 'finished'
  clearTimeout(session.deadline)
  session.release()
  recordSessions.delete(session.id)
  destroyRecorder(session)
  const failure = error ?? new Error('recording ended before it was ready')
  session.ready.reject(failure)
  if (result) session.result.resolve(result)
  else {
    session.result.reject(failure)
    logWarn('screen', `recording ${session.id}: ${failure.message}`)
    // A pending initial write/append cannot be cancelled by promises. Remove its file after it settles.
    void session.appendQueue.catch(() => {}).then(() => rm(session.partFile, { force: true })).catch(() => {})
  }
}

function controlRecorder(session: RecordSession, method: 'stop' | 'pause' | 'resume'): void {
  const win = session.win
  if (!win || win.isDestroyed()) {
    finishRecording(session, undefined, new Error('recorder window destroyed'))
    return
  }
  void win.webContents.executeJavaScript(
    `if(!window.recorderCtl)throw new Error('recorder not ready');window.recorderCtl.${method}()`
  ).catch((error: Error) => finishRecording(session, undefined, error))
}

function requestStop(session: RecordSession): void {
  if (session.phase === 'finished' || session.phase === 'stopping') return
  if (session.phase === 'starting') {
    finishRecording(session, undefined, new Error('recording stopped during startup'))
    return
  }
  session.phase = 'stopping'
  session.stoppedAt = Date.now()
  clearTimeout(session.deadline)
  session.deadline = setTimeout(() => {
    finishRecording(session, undefined, new Error('recording stop timeout'))
  }, RECORDING_STOP_TIMEOUT_MS)
  controlRecorder(session, 'stop')
}

async function finalizeRecording(session: RecordSession): Promise<void> {
  if (session.finalizing || session.phase === 'finished') return
  session.finalizing = true
  // The renderer has stopped acquisition; close it before disk IO, which may take longer.
  if (session.phase !== 'stopping') {
    session.phase = 'stopping'
    session.stoppedAt = Date.now()
    clearTimeout(session.deadline)
    session.deadline = setTimeout(() => {
      finishRecording(session, undefined, new Error('recording stop timeout'))
    }, RECORDING_STOP_TIMEOUT_MS)
  }
  destroyRecorder(session)
  try {
    await session.appendQueue
    if (isFinished(session)) return
    await rename(session.partFile, session.outFile)
    // A timeout may have fired while rename/stat was in flight. Never publish that partial result.
    if (isFinished(session)) {
      await rm(session.outFile, { force: true })
      return
    }
    const info = await stat(session.outFile)
    if (isFinished(session)) {
      await rm(session.outFile, { force: true })
      return
    }
    finishRecording(session, {
      path: session.outFile, size: info.size,
      durationMs: (session.stoppedAt ?? Date.now()) - session.startedAt
    })
  } catch (error) {
    await rm(session.outFile, { force: true }).catch(() => {})
    finishRecording(session, undefined, error as Error)
  }
}

function isFinished(session: RecordSession): boolean {
  return session.phase === 'finished'
}

function wireRecorderIpcOnce(): void {
  if (ipcMain.listenerCount(IpcChannels.PluginRecorderStarted) > 0) return
  const resolveSession = (event: IpcMainEvent): RecordSession | undefined => {
    for (const session of recordSessions.values()) {
      if (session.win && !session.win.isDestroyed() && session.win.webContents === event.sender &&
          event.senderFrame === session.win.webContents.mainFrame) {
        return session
      }
    }
    return undefined
  }
  ipcMain.on(IpcChannels.PluginRecorderStarted, (event) => {
    const session = resolveSession(event)
    if (!session || session.phase !== 'starting') return
    if (!isCurrent(session.scope)) {
      finishRecording(session, undefined, new Error('plugin runtime is closed'))
      return
    }
    clearTimeout(session.deadline)
    session.phase = 'recording'
    session.startedAt = Date.now()
    session.ready.resolve()
    logInfo('screen', `recording started ${session.id}`)
  })
  ipcMain.on(IpcChannels.PluginRecorderFailed, (event, message: string) => {
    const session = resolveSession(event)
    if (session) finishRecording(session, undefined, new Error(`screen record failed: ${message}`))
  })
  ipcMain.on(IpcChannels.PluginRecorderAudioUnavailable, (event, message: string) => {
    if (resolveSession(event)) logWarn('screen', `system audio unavailable: ${message}`)
  })
  ipcMain.on(IpcChannels.PluginRecorderChunk, (event, buf: ArrayBuffer) => {
    const session = resolveSession(event)
    if (!session || session.finalizing || !(buf instanceof ArrayBuffer)) return
    if (buf.byteLength + session.queuedBytes > MAX_QUEUED_BYTES) {
      finishRecording(session, undefined, new Error('recording disk queue exceeded limit'))
      return
    }
    const chunk = Buffer.from(buf)
    session.queuedBytes += chunk.byteLength
    if (!session.paused && session.phase === 'recording' && session.queuedBytes >= PAUSE_QUEUED_BYTES) {
      session.paused = true
      controlRecorder(session, 'pause')
    }
    session.appendQueue = session.appendQueue.then(async () => {
      if (isFinished(session)) return
      await appendFile(session.partFile, chunk)
    }).catch((error: Error) => {
      finishRecording(session, undefined, error)
    }).finally(() => {
      session.queuedBytes -= chunk.byteLength
      if (session.paused && session.phase === 'recording' && session.queuedBytes < RESUME_QUEUED_BYTES) {
        session.paused = false
        controlRecorder(session, 'resume')
      }
    })
  })
  ipcMain.on(IpcChannels.PluginRecorderStopped, (event) => {
    const session = resolveSession(event)
    if (session) void finalizeRecording(session)
  })
}

/** 开始矩形录屏。启动中占位，避免多个调用跨 await 创建多个录制窗口。 */
export async function startRecording(pluginId: string, opts?: {
  bounds?: ScreenBounds
  withAudio?: boolean
  displayId?: number
}): Promise<{ sessionId: string }> {
  const scope = requireScope(pluginId)
  wireRecorderIpcOnce()
  if ([...recordSessions.values()].some((session) => session.phase === 'starting' || session.phase === 'recording')) {
    throw new Error('recording already in progress')
  }
  const id = randomUUID()
  const session: RecordSession = {
    id, scope, win: null, phase: 'starting', startedAt: Date.now(),
    partFile: join(recordingsDir(), `${id}.part`), outFile: join(recordingsDir(), `${id}.webm`),
    appendQueue: Promise.resolve(), queuedBytes: 0, paused: false, finalizing: false,
    ready: deferred<void>(), result: deferred<RecordingResult>(), release: () => {}
  }
  recordSessions.set(id, session)
  session.release = ownActivity(scope, 'screen recording', () => requestStop(session))
  session.deadline = setTimeout(() => {
    finishRecording(session, undefined, new Error('recording startup timeout'))
  }, RECORDING_START_TIMEOUT_MS)
  void (async () => {
    try {
      const display = resolveDisplay(opts?.displayId)
      const width = Math.max(1, Math.round(display.size.width * display.scaleFactor))
      const height = Math.max(1, Math.round(display.size.height * display.scaleFactor))
      const crop = opts?.bounds ? boundsToIntersect(opts.bounds, width, height) : { x: 0, y: 0, width, height }
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      if (isFinished(session) || !isCurrent(scope)) return requestStop(session)
      const sid = String(display.id)
      const source = sources.find((item) => item.display_id === sid) ?? sources.find((item) => item.id.includes(sid)) ?? sources[0]
      if (!source) throw new Error('screen record failed: no display source')
      session.appendQueue = mkdir(recordingsDir(), { recursive: true }).then(async () => {
        if (!isFinished(session)) await writeFile(session.partFile, '')
      })
      await session.appendQueue
      if (isFinished(session) || !isCurrent(scope)) return requestStop(session)
      const win = new BrowserWindow({
        show: false, width: Math.max(200, crop.width), height: Math.max(120, crop.height),
        frame: false, skipTaskbar: true,
        webPreferences: {
          contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
          preload: resolvePreload('recorderPreload.js')
        }
      })
      session.win = win
      win.once('closed', () => {
        if (session.win === win) finishRecording(session, undefined, new Error('recorder window closed'))
      })
      win.webContents.once('render-process-gone', () => {
        finishRecording(session, undefined, new Error('recorder renderer exited'))
      })
      win.webContents.once('preload-error', (_event, _path, error) => {
        finishRecording(session, undefined, new Error(`recorder preload failed: ${error.message}`))
      })
      // data: pages have an opaque, insecure origin and no mediaDevices. A local
      // transient document provides a secure context without relaxing the sandbox.
      const htmlFile = join(recordingsDir(), `.${id}.html`)
      try {
        await writeFile(htmlFile, buildRecorderHtml(source.id, opts?.withAudio === true, crop))
        if (isFinished(session) || !isCurrent(scope)) return requestStop(session)
        await win.loadFile(htmlFile)
      } finally {
        await rm(htmlFile, { force: true })
      }
      if (!isCurrent(scope)) requestStop(session)
    } catch (error) {
      finishRecording(session, undefined, error as Error)
    }
  })()
  await session.ready.promise
  return { sessionId: id }
}

function ownedRecording(pluginId: string, sessionId: string): RecordSession | undefined {
  const scope = requireScope(pluginId)
  const session = recordSessions.get(sessionId)
  if (session && session.scope !== scope) throw new Error('recording belongs to another plugin runtime')
  return session
}

/** 停止录制并落盘；重复停止共享同一次收尾。 */
export function stopRecording(pluginId: string, sessionId: string): Promise<RecordingResult> {
  const session = ownedRecording(pluginId, sessionId)
  if (!session) throw new Error(`recording session not found: ${sessionId}`)
  requestStop(session)
  return session.result.promise
}

export function cancelRecording(pluginId: string, sessionId: string): boolean {
  const session = ownedRecording(pluginId, sessionId)
  if (!session) return false
  finishRecording(session, undefined, new Error('recording cancelled'))
  return true
}

export function disposeScreenService(): void {
  if (regionSession) finishRegion(regionSession, null)
  for (const session of recordSessions.values()) {
    finishRecording(session, undefined, new Error('app quit'))
  }
}

wireRegionIpcOnce()

/** Shutdown joins already detached saves; each recording owns a 10 second deadline. */
export async function finishRecordingsForShutdown(): Promise<void> {
  if (regionSession) finishRegion(regionSession, null)
  await Promise.allSettled([...recordSessions.values()].map((session) => (requestStop(session), session.result.promise)))
}
