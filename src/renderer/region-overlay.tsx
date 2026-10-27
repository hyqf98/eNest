/**
 * region-overlay — 全屏框选交互（每显示器一份）
 * 职责：绘制遮罩与选区矩形，把最终选区（本显示器本地 DIP）上报主进程。
 * 关键约束：不引入 React（只有一个指针交互，原生 DOM 更轻、首帧更快）；
 *          遮罩用超大 box-shadow 实现，不额外铺 DOM 层。
 */
import './region-overlay.css'

interface RegionApi {
  confirm(rect: { x: number; y: number; width: number; height: number }): void
  cancel(): void
}

declare global {
  interface Window { enestRegion?: RegionApi }
}

const params = new URLSearchParams(location.search)
const minWidth = Number(params.get('minWidth')) || 320
const minHeight = Number(params.get('minHeight')) || 240
const displayWidth = Number(params.get('width')) || window.innerWidth
const displayHeight = Number(params.get('height')) || window.innerHeight

const root = document.getElementById('root')
if (!root) throw new Error('region overlay root missing')

root.innerHTML = `
  <div class="region-hint" role="status">
    <span class="region-hint-title">拖动框选自由面板区域</span>
    <span class="region-hint-sub">Esc 取消 · 松开鼠标确认 · 最小 ${minWidth}×${minHeight}</span>
  </div>
  <div class="region-size" aria-live="polite"></div>
  <div class="region-box" hidden></div>
`

const hint = root.querySelector<HTMLElement>('.region-hint')!
const sizeLabel = root.querySelector<HTMLElement>('.region-size')!
const box = root.querySelector<HTMLElement>('.region-box')!

let origin: { x: number; y: number } | null = null
let current: { x: number; y: number; width: number; height: number } | null = null

function normalize(ax: number, ay: number, bx: number, by: number) {
  const x = Math.max(0, Math.min(ax, bx))
  const y = Math.max(0, Math.min(ay, by))
  const width = Math.min(displayWidth, Math.max(ax, bx)) - x
  const height = Math.min(displayHeight, Math.max(ay, by)) - y
  return { x, y, width, height }
}

function paint(): void {
  if (!current) {
    box.hidden = true
    sizeLabel.textContent = ''
    return
  }
  box.hidden = false
  box.style.transform = `translate3d(${current.x}px, ${current.y}px, 0)`
  box.style.width = `${current.width}px`
  box.style.height = `${current.height}px`
  const valid = current.width >= minWidth && current.height >= minHeight
  box.dataset.valid = String(valid)
  sizeLabel.textContent = `${Math.round(current.width)} × ${Math.round(current.height)}${valid ? '' : ' · 太小'}`
  sizeLabel.style.transform = `translate3d(${Math.max(8, Math.min(displayWidth - 120, current.x))}px, ${Math.max(8, current.y - 30)}px, 0)`
}

function reset(): void {
  origin = null
  current = null
  hint.hidden = false
  paint()
}

function finish(): void {
  const rect = current
  reset()
  if (!rect || rect.width < minWidth || rect.height < minHeight) return
  window.enestRegion?.confirm({
    x: Math.round(rect.x), y: Math.round(rect.y),
    width: Math.round(rect.width), height: Math.round(rect.height)
  })
}

window.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  origin = { x: event.clientX, y: event.clientY }
  current = { x: origin.x, y: origin.y, width: 0, height: 0 }
  hint.hidden = true
  paint()
})

window.addEventListener('pointermove', event => {
  if (!origin) return
  current = normalize(origin.x, origin.y, event.clientX, event.clientY)
  paint()
})

window.addEventListener('pointerup', event => {
  if (!origin) return
  // 用抬手坐标再算一次：快速拖动时最后一个 pointermove 可能落后于实际位置。
  current = normalize(origin.x, origin.y, event.clientX, event.clientY)
  finish()
})

window.addEventListener('pointercancel', () => reset())

window.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    reset()
    window.enestRegion?.cancel()
  } else if (event.key === 'Enter' && current) {
    finish()
  }
})

// 右键视为取消；不要监听 blur —— 多显示器时每个屏幕各有一个 overlay，
// 焦点在它们之间切换会让其余 overlay 收到 blur，从而误取消整次框选。
window.addEventListener('contextmenu', event => {
  event.preventDefault()
  window.enestRegion?.cancel()
})

paint()
