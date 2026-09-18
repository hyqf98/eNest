/**
 * pinService — 屏幕贴图窗口
 * 职责：用无边框置顶 BrowserWindow 展示截图/图片，支持拖动与滚轮缩放。
 * 被 pluginHandlers 的 pin.* 方法调用。
 */
import { BrowserWindow, ipcMain, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import { logWarn } from '@main/logs/logService'
import { resolvePreload } from '@main/window/createShellWindow'

interface PinWindow {
  id: string
  pluginId: string
  win: BrowserWindow
}

const pins = new Map<string, PinWindow>()
let pinIpcWired = false

function wirePinIpcOnce(): void {
  if (pinIpcWired) return
  pinIpcWired = true
  ipcMain.on('plugin:pin-close', (event) => {
    for (const [id, p] of pins) {
      if (!p.win.isDestroyed() && p.win.webContents.id === event.sender.id) {
        closePin(id)
        return
      }
    }
  })
}

function buildPinHtml(): string {
  // 载荷在 load 后通过 executeJavaScript 注入，避免拼进 HTML
  return `<!doctype html><html><head><meta charset="utf-8"/><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:move}
#wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
img{max-width:100%;max-height:100%;box-shadow:0 8px 28px rgba(0,0,0,.35);border-radius:2px;image-rendering:auto}
#bar{position:absolute;top:6px;right:6px;display:flex;gap:4px;opacity:0;transition:opacity .15s}
body:hover #bar{opacity:1}
button{width:22px;height:22px;border:0;border-radius:4px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;cursor:pointer}
button:hover{background:rgba(255,80,80,.9)}
</style></head><body>
<div id="wrap"><img id="img" alt=""/></div>
<div id="bar"><button id="close" title="关闭">×</button></div>
<script>
const img=document.getElementById('img');
let scale=1;
addEventListener('wheel',e=>{
  e.preventDefault();
  scale = Math.min(4, Math.max(0.2, scale * (e.deltaY>0?0.92:1.08)));
  img.style.transform='scale('+scale+')';
},{passive:false});
document.getElementById('close').onclick=()=>window.pinCtl?.close();
addEventListener('keydown',e=>{ if(e.key==='Escape') window.pinCtl?.close(); });
</script></body></html>`
}

function pinPreloadPath(): string {
  return resolvePreload('pinPreload.js')
}

/**
 * 打开贴图窗。
 * v1 仅接受 dataUrl（截图插件场景）；path 通道关闭，避免任意本地文件读取。
 */
export function openPin(payload: {
  pluginId?: string
  dataUrl?: string
  path?: string
  x?: number
  y?: number
  width?: number
  title?: string
}): { pinId: string } {
  wirePinIpcOnce()
  const dataUrl = String(payload?.dataUrl ?? '')
  if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(dataUrl)) {
    throw new Error('pin.open requires image dataUrl')
  }

  const display = screen.getPrimaryDisplay()
  const width = Math.max(80, Math.min(display.workArea.width, Math.floor(payload.width ?? 360)))
  const x = Math.floor(payload.x ?? display.workArea.x + display.workArea.width / 2 - width / 2)
  const y = Math.floor(payload.y ?? display.workArea.y + 80)

  const win = new BrowserWindow({
    width,
    height: Math.floor(width * 0.75),
    x,
    y,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: pinPreloadPath()
    }
  })

  const pinId = randomUUID()
  pins.set(pinId, {
    id: pinId,
    pluginId: String(payload.pluginId ?? ''),
    win
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  win.on('closed', () => {
    pins.delete(pinId)
  })

  void (async () => {
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(buildPinHtml())}`
    )
    if (win.isDestroyed()) return
    // JSON.stringify 安全注入；img.src 只接受已校验的 data:image URL
    await win.webContents.executeJavaScript(
      `(()=>{const img=document.getElementById('img');img.src=${JSON.stringify(dataUrl)};document.title=${JSON.stringify(String(payload.title ?? '贴图'))};})()`
    )
  })()

  return { pinId }
}

export function closePin(pinId: string, pluginId?: string): boolean {
  const p = pins.get(pinId)
  if (!p) return false
  // 仅允许关闭自己创建的贴图（pluginId 为空表示内部/宿主调用）
  if (pluginId && p.pluginId && p.pluginId !== pluginId) {
    return false
  }
  if (!p.win.isDestroyed()) p.win.destroy()
  pins.delete(pinId)
  return true
}

export function closeAllPins(pluginId?: string): number {
  let n = 0
  for (const p of [...pins.values()]) {
    if (pluginId && p.pluginId && p.pluginId !== pluginId) continue
    if (!p.win.isDestroyed()) p.win.destroy()
    pins.delete(p.id)
    n++
  }
  return n
}

export function listPins(pluginId?: string): Array<{ pinId: string }> {
  const out: Array<{ pinId: string }> = []
  for (const p of pins.values()) {
    if (pluginId && p.pluginId && p.pluginId !== pluginId) continue
    out.push({ pinId: p.id })
  }
  return out
}

export function disposePinService(): void {
  try {
    closeAllPins()
  } catch (err) {
    logWarn('pin', `dispose failed: ${(err as Error).message}`)
  }
}
