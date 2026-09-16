/**
 * PluginSessionStore — 插件会话态 KV 存储
 * 职责：为每个插件维护一份主进程内存 Map，实现 storage.session.* 语义。
 * 生命周期：随应用进程存在；插件 closePlugin 时清空对应 bag，不落盘。
 * 被 pluginHandlers（读写分发）与 PluginHost（销毁清理）引用。
 * 关键依赖：无（纯内存 Map）。
 */

/** 插件会话态 KV：主进程内存，随插件销毁 / 应用退出清空，不落盘 */
const sessionStores = new Map<string, Map<string, unknown>>()

/** 获取（或惰性创建）指定插件的会话态 bag */
export function sessionBag(pluginId: string): Map<string, unknown> {
  let bag = sessionStores.get(pluginId)
  if (!bag) {
    bag = new Map()
    sessionStores.set(pluginId, bag)
  }
  return bag
}

/**
 * 清空指定插件的会话态存储（PluginHost.closePlugin 时调用）。
 * 会话数据不跨「关闭 Tab」保留，与 storage.local 的持久语义区分。
 */
export function clearPluginSession(pluginId: string): void {
  sessionStores.delete(pluginId)
}
