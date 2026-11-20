import type { BaseWindow, WebContentsView } from 'electron'

const layers = new Map<BaseWindow, Map<WebContentsView, number>>()

/** Host-owned transient surfaces must remain above native plugin content. */
export function registerTransientView(win: BaseWindow, view: WebContentsView, priority = 100): () => void {
  let entries = layers.get(win)
  if (!entries) {
    entries = new Map()
    layers.set(win, entries)
    win.once('closed', () => layers.delete(win))
  }
  entries.set(view, priority)
  const release = () => { entries?.delete(view) }
  view.webContents.once('destroyed', release)
  return release
}

export function raiseTransientViews(window?: BaseWindow, chrome: readonly WebContentsView[] = []): void {
  for (const win of window ? [window] : layers.keys()) {
    if (win.isDestroyed()) continue
    const children = win.contentView.children
    const transients = [...(layers.get(win) ?? [])].sort((left, right) => left[1] - right[1]).map(([view]) => view)
    const attached = [...chrome, ...transients].filter(view => !view.webContents.isDestroyed() && children.includes(view))
    if (attached.every((view, index) => children.at(index - attached.length) === view)) continue
    for (const view of attached) win.contentView.addChildView(view)
  }
}
