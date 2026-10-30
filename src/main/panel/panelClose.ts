export type PanelPluginClose = () => Promise<void>

export interface PanelPluginCloseOwner {
  pluginId: string
  closeRuntime?: PanelPluginClose
}

/** A failed placeholder keeps its first incarnation-bound release, never a later runtime by id. */
export function rememberPanelPluginClose(
  owner: PanelPluginCloseOwner,
  capture: (pluginId: string) => PanelPluginClose
): PanelPluginClose {
  if (owner.closeRuntime) return owner.closeRuntime
  try { owner.closeRuntime = capture(owner.pluginId) }
  catch (error) { owner.closeRuntime = () => Promise.reject(error) }
  return owner.closeRuntime
}

export interface PanelPluginCleanupFailure {
  pluginId: string
  cause: unknown
}

export class PanelPluginCleanupError extends Error {
  constructor(readonly failures: PanelPluginCleanupFailure[]) {
    super(`部分组件资源未能确认释放（${failures.length} 项），请重试释放或在“设置 → 通用”查看剩余进程。`)
    this.name = 'PanelPluginCleanupError'
  }
}

/** Finish every close attempt, but never report partial resource cleanup as success. */
export async function closePanelPluginRuntimes(
  pluginIds: readonly string[],
  close: (pluginId: string) => Promise<void>
): Promise<void> {
  const ids = [...new Set(pluginIds)]
  const results = await Promise.allSettled(ids.map(id => Promise.resolve().then(() => close(id))))
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [{ pluginId: ids[index], cause: result.reason }] : [])
  if (failures.length) throw new PanelPluginCleanupError(failures)
}
