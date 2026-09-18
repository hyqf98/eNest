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
  nativeImage,
  screen,
  type IpcMainEvent
} from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import { resolvePreload } from '@main/window/createShellWindow'
import type { ScreenBounds, ScreenCaptureResult } from '@shared/types/plugin'
import { logInfo, logWarn } from '@main/logs/logService'

interface RecordSession {
  id: string
  win: BrowserWindow
  withAudio: boolean
  startedAt: number
  outFile: string
  /** 串行化分片写入，保证 webm 时序 */
  appendQueue: Promise<void>
  resolving?: {
    resolve: (v: { path: string; size: number; durationMs: number }) => void
    reject: (e: Error) => void
  }
  cancelling?: boolean
}

const recordSessions = new Map<string, RecordSession>()
let regionOverlay: BrowserWindow | null = null
let regionResolver:
  | { resolve: (b: ScreenBounds | null) => void; reject: (e: Error) => void }
  | null = null

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

function closeRegionOverlay(): void {
  if (!regionOverlay) return
  const w = regionOverlay
  regionOverlay = null
  if (!w.isDestroyed()) w.destroy()
}

/** 打开全屏区域选择遮罩；用户确认返回设备像素 bounds，取消返回 null */
export function selectRegion(): Promise<ScreenBounds | null> {
  if (regionOverlay) {
    closeRegionOverlay()
    regionResolver?.resolve(null)
    regionResolver = null
  }

  return new Promise<ScreenBounds | null>((resolve, reject) => {
    regionResolver = { resolve, reject }
    void (async () => {
      try {
        const display = screen.getPrimaryDisplay()
        const shot = await captureDisplayNative(display)
        const dataUrl = shot.toDataURL()
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
        regionOverlay = win
        win.setAlwaysOnTop(true, 'screen-saver')
        if (process.platform === 'darwin') {
          win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
        }

        win.once('closed', () => {
          if (regionOverlay === win) {
            regionOverlay = null
            regionResolver?.resolve(null)
            regionResolver = null
          }
        })

        await win.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(buildRegionHtml(dataUrl, width, height))}`
        )
        win.showInactive()
        win.focus()
      } catch (err) {
        regionResolver = null
        reject(err as Error)
      }
    })()
  })
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
  if (ipcMain.listenerCount('plugin:region-confirm') > 0) return
  const isRegionSender = (event: IpcMainEvent): boolean =>
    !!regionOverlay &&
    !regionOverlay.isDestroyed() &&
    regionOverlay.webContents.id === event.sender.id

  ipcMain.on('plugin:region-confirm', (e: IpcMainEvent, bounds: ScreenBounds) => {
    if (!isRegionSender(e)) return
    closeRegionOverlay()
    const r = regionResolver
    regionResolver = null
    if (!r) return
    if (
      !bounds ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      bounds.width < 1 ||
      bounds.height < 1
    ) {
      r.resolve(null)
      return
    }
    r.resolve({
      x: Math.max(0, Math.floor(bounds.x)),
      y: Math.max(0, Math.floor(bounds.y)),
      width: Math.max(1, Math.floor(bounds.width)),
      height: Math.max(1, Math.floor(bounds.height))
    })
  })
  ipcMain.on('plugin:region-cancel', (e: IpcMainEvent) => {
    if (!isRegionSender(e)) return
    closeRegionOverlay()
    const r = regionResolver
    regionResolver = null
    r?.resolve(null)
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
let recorder=null;
async function boot(){
  const audioConstraint = withAudio
    ? { mandatory: { chromeMediaSource: 'system', chromeMediaSourceId: sourceId } }
    : false;
  const videoConstraint = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      maxWidth: 4096,
      maxHeight: 4096,
      maxFrameRate: 30
    }
  };
  let raw;
  try {
    raw = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: videoConstraint });
  } catch (e1) {
    try {
      raw = await navigator.mediaDevices.getUserMedia({ video: videoConstraint });
      window.recorderBridge?.audioUnavailable(String(e1?.message || e1));
    } catch (e2) {
      window.recorderBridge?.failed(String(e2?.message || e2));
      return;
    }
  }
  const v = document.getElementById('v');
  v.srcObject = raw;
  await v.play();
  const cw = Math.max(1, crop.width|0), ch = Math.max(1, crop.height|0);
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  let raf = 0;
  const tick = () => {
    try {
      ctx.drawImage(v, crop.x, crop.y, cw, ch, 0, 0, cw, ch);
    } catch {}
    raf = requestAnimationFrame(tick);
  };
  tick();
  const out = canvas.captureStream(30);
  for (const t of raw.getAudioTracks()) out.addTrack(t);
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm';
  recorder = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) {
      e.data.arrayBuffer().then((buf) => window.recorderBridge?.chunk(buf));
    }
  };
  recorder.onstop = () => {
    cancelAnimationFrame(raf);
    raw.getTracks().forEach(t => t.stop());
    out.getTracks().forEach(t => t.stop());
    window.recorderBridge?.stopped();
  };
  recorder.start(250);
  window.__enestRecorderReady = true;
  window.recorderBridge?.started();
}
window.recorderCtl = {
  stop() { try { recorder?.stop(); } catch {} },
  cancel() { try { recorder?.stop(); } catch {} }
};
boot();
</script></body></html>`
}

function wireRecorderIpcOnce(): void {
  if (ipcMain.listenerCount('plugin:recorder-started') > 0) return

  const resolveSession = (event: IpcMainEvent): RecordSession | null => {
    for (const s of recordSessions.values()) {
      if (s.win.webContents.id === event.sender.id) return s
    }
    return null
  }

  ipcMain.on('plugin:recorder-started', (e) => {
    const s = resolveSession(e)
    if (s) logInfo('screen', `recording started ${s.id}`)
  })
  ipcMain.on('plugin:recorder-failed', (e, message: string) => {
    const s = resolveSession(e)
    if (!s) return
    s.resolving?.reject(new Error(`screen record failed: ${message}`))
    s.resolving = undefined
    if (!s.win.isDestroyed()) s.win.destroy()
    recordSessions.delete(s.id)
  })
  ipcMain.on('plugin:recorder-audio-unavailable', (e, message: string) => {
    logWarn('screen', `system audio unavailable: ${message}`)
  })
  ipcMain.on('plugin:recorder-chunk', (e, buf: ArrayBuffer) => {
    const s = resolveSession(e)
    if (!s || s.cancelling) return
    const chunk = Buffer.from(buf)
    s.appendQueue = s.appendQueue.then(async () => {
      try {
        await mkdir(recordingsDir(), { recursive: true })
        await appendFile(join(recordingsDir(), `${s.id}.part`), chunk)
      } catch (err) {
        logWarn('screen', `append chunk failed: ${(err as Error).message}`)
      }
    })
  })
  ipcMain.on('plugin:recorder-stopped', (e) => {
    const s = resolveSession(e)
    if (!s) return
    void (async () => {
      const part = join(recordingsDir(), `${s.id}.part`)
      const out = join(recordingsDir(), `${s.id}.webm`)
      try {
        // 等待在途分片全部落盘后再 rename
        await s.appendQueue
        if (s.cancelling) {
          await rm(part, { force: true })
          s.resolving?.reject(new Error('recording cancelled'))
        } else {
          await rename(part, out)
          const st = await stat(out)
          s.resolving?.resolve({
            path: out,
            size: st.size,
            durationMs: Date.now() - s.startedAt
          })
        }
      } catch (err) {
        await rm(part, { force: true }).catch(() => {})
        s.resolving?.reject(err as Error)
      } finally {
        s.resolving = undefined
        if (!s.win.isDestroyed()) s.win.destroy()
        recordSessions.delete(s.id)
      }
    })()
  })
}

/** 开始矩形录屏；产物 webm 写入 ~/eNest/recordings/ */
export async function startRecording(opts?: {
  bounds?: ScreenBounds
  withAudio?: boolean
  displayId?: number
}): Promise<{ sessionId: string }> {
  wireRecorderIpcOnce()
  if (recordSessions.size > 0) throw new Error('recording already in progress')

  const display = resolveDisplay(opts?.displayId)
  const full = await captureDisplayNative(display)
  const fullSize = full.getSize()
  const crop = opts?.bounds
    ? boundsToIntersect(opts.bounds, fullSize.width, fullSize.height)
    : { x: 0, y: 0, width: fullSize.width, height: fullSize.height }

  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
  const sid = String(display.id)
  const source =
    sources.find((s) => s.display_id === sid) ??
    sources.find((s) => s.id.includes(sid)) ??
    sources[0]
  if (!source) throw new Error('screen record failed: no display source')

  const sessionId = randomUUID()
  const withAudio = opts?.withAudio === true

  const win = new BrowserWindow({
    show: false,
    width: Math.max(200, crop.width),
    height: Math.max(120, crop.height),
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: resolvePreload('recorderPreload.js')
    }
  })

  const session: RecordSession = {
    id: sessionId,
    win,
    withAudio,
    startedAt: Date.now(),
    outFile: join(recordingsDir(), `${sessionId}.webm`),
    appendQueue: Promise.resolve()
  }
  recordSessions.set(sessionId, session)
  // 预创建 part，避免无分片时 rename 失败
  await mkdir(recordingsDir(), { recursive: true })
  await writeFile(join(recordingsDir(), `${sessionId}.part`), '')

  await win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(buildRecorderHtml(source.id, withAudio, crop))}`
  )

  return { sessionId }
}

/** 停止录制并落盘；返回绝对路径 */
export function stopRecording(sessionId: string): Promise<{
  path: string
  size: number
  durationMs: number
}> {
  const s = recordSessions.get(sessionId)
  if (!s) throw new Error(`recording session not found: ${sessionId}`)
  if (s.resolving) throw new Error('recording already stopping')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.resolving = undefined
      if (!s.win.isDestroyed()) s.win.destroy()
      recordSessions.delete(sessionId)
      reject(new Error('recording stop timeout'))
    }, 10_000)

    s.resolving = {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (err) => {
        clearTimeout(timer)
        reject(err)
      }
    }

    if (s.win.isDestroyed()) {
      clearTimeout(timer)
      s.resolving = undefined
      recordSessions.delete(sessionId)
      reject(new Error('recorder window destroyed'))
      return
    }

    // recorder 未就绪时主动 failed，避免静默挂起
    void s.win.webContents
      .executeJavaScript(
        `(function(){if(!window.recorderCtl||!window.__enestRecorderReady){window.recorderBridge?.failed('recorder not ready');return}window.recorderCtl.stop()})()`
      )
      .catch(() => {
        clearTimeout(timer)
        s.resolving = undefined
        recordSessions.delete(sessionId)
        reject(new Error('recorder window not ready'))
      })
  })
}

export function cancelRecording(sessionId: string): boolean {
  const s = recordSessions.get(sessionId)
  if (!s) return false
  s.cancelling = true
  if (!s.win.isDestroyed()) {
    void s.win.webContents.executeJavaScript('window.recorderCtl?.cancel()').catch(() => {
      s.win.destroy()
      recordSessions.delete(sessionId)
      s.resolving?.reject(new Error('recording cancelled'))
    })
  }
  return true
}

export function disposeScreenService(): void {
  closeRegionOverlay()
  for (const s of recordSessions.values()) {
    s.cancelling = true
    if (!s.win.isDestroyed()) s.win.destroy()
    s.resolving?.reject(new Error('app quit'))
  }
  recordSessions.clear()
}

// 懒注册区域遮罩 IPC
wireRegionIpcOnce()

/** 导出供测试：hash 避免重复解析同一帧（预留） */
export function frameHash(dataUrl: string): string {
  return createHash('sha1').update(dataUrl).digest('hex').slice(0, 16)
}

/** 将 dataURL 写入 recordings（截图像缓存，可选） */
export async function saveCaptureDataUrl(dataUrl: string, name?: string): Promise<string> {
  await mkdir(recordingsDir(), { recursive: true })
  const file = join(recordingsDir(), name ?? `${randomUUID()}.png`)
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '')
  await writeFile(file, Buffer.from(b64, 'base64'))
  return file
}
