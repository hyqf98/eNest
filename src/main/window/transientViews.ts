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

export function raiseTransientViews(window?: BaseWindow): void {
  for (const [win, entries] of layers) {
    if (window && window !== win || win.isDestroyed()) continue
    const attached = [...entries].sort((a, b) => a[1] - b[1]).map(([view]) => view)
      .filter(view => !view.webContents.isDestroyed() && win.contentView.children.includes(view))
    if (attached.every((view, index) => win.contentView.children.at(index - attached.length) === view)) continue
    for (const view of attached) {
      if (view.webContents.isDestroyed() || !win.contentView.children.includes(view)) continue
      win.contentView.removeChildView(view)
      win.contentView.addChildView(view)
    }
  }
}
