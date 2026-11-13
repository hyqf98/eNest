/**
 * scrollActivity —— 滚动条"只在滚动时出现"控制器
 *
 * CSS 没有"元素是否正在滚动"这种状态（overflow: overlay 已在 Chromium 114 移除，
 * scroll-state() 只提供 stuck/snapped/scrollable），所以要由这里补一个滚动活动信号：
 * 监听文档级 scroll（capture，scroll 不冒泡但能拿到目标元素），
 * 给声明了 `data-scrollbar="auto-hide"` 的滚动容器打 `data-scrolling`，
 * 停止滚动 IDLE_MS 后移除。样式层把 thumb 的可见性挂到该属性上。
 *
 * 只挂一次 document 监听，代价与滚动容器数量无关；未声明该属性的滚动区不受影响，
 * 所以插件页与宿主注入的滚动条样式保持原样。
 */
const IDLE_MS = 900

interface State { timer?: ReturnType<typeof setTimeout> }
const states = new WeakMap<Element, State>()

function mark(element: Element): void {
  let state = states.get(element)
  if (!state) { state = {}; states.set(element, state) }
  element.setAttribute('data-scrolling', '')
  clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    state.timer = undefined
    element.removeAttribute('data-scrolling')
  }, IDLE_MS)
}

let installed = false

/** 幂等安装；shell 与 home 两个入口都会调用，只真正挂一次。 */
export function installScrollActivity(): void {
  if (installed) return
  installed = true
  document.addEventListener('scroll', event => {
    // scroll 事件的 target 就是被滚动的元素本身，无需再向上找。
    const element = event.target
    if (element instanceof Element && element.matches('[data-scrollbar="auto-hide"]')) mark(element)
  }, { capture: true, passive: true })
}
