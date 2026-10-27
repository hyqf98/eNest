/**
 * useDuplicatePluginNotice — 通用重复安装提示（不按插件 ID 特判）
 * 同一 name + category 出现多个已安装启用插件时（典型：发布者改名后旧 id 包残留，
 * 两个插件会争抢相同 Quick 命令与设置分区），提示用户移除旧版本。
 * 仅提示，不自动禁用/卸载；同一重复集合每次运行只提醒一次。
 * 依赖：shellStore.plugins、notifyService。
 */
import { useEffect, useRef } from 'react'
import type { PluginSummary } from '@shared/types/plugin'
import { useShellStore } from '@renderer/stores/shellStore'
import { notify } from '@renderer/services/notifyService'

/** 已安装且启用、非开发态的插件才参与重复检测。 */
function isLiveInstallation(plugin: PluginSummary): boolean {
  return plugin.installed === true && plugin.dev !== true && plugin.enabled !== false
}

export function duplicateInstallationGroups(plugins: PluginSummary[]): Array<{ name: string; ids: string[] }> {
  const byKey = new Map<string, { name: string; ids: string[] }>()
  for (const plugin of plugins) {
    if (!isLiveInstallation(plugin)) continue
    const name = plugin.name.trim()
    if (!name) continue
    const key = `${name}\u0000${plugin.category.trim()}`
    const group = byKey.get(key)
    if (group) { if (!group.ids.includes(plugin.id)) group.ids.push(plugin.id) }
    else byKey.set(key, { name, ids: [plugin.id] })
  }
  return [...byKey.values()].filter(group => group.ids.length > 1)
}

/** 已提醒过的重复集合签名；跨 plugins-changed 刷新保持一次性。 */
const notified = new Set<string>()

export function useDuplicatePluginNotice(enabled: boolean): void {
  const plugins = useShellStore((s) => s.plugins)
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
  }, [])
  useEffect(() => {
    if (!enabled || plugins.length === 0) return
    for (const group of duplicateInstallationGroups(plugins)) {
      const signature = [...group.ids].sort().join(',')
      if (notified.has(signature)) continue
      notified.add(signature)
      notify.warn(`检测到重复安装：「${group.name}」同时存在 ${group.ids.length} 个插件（${group.ids.join('、')}）。两者会争抢相同的快捷入口与设置项，请在插件目录或设置中移除旧版本。`)
    }
  }, [enabled, plugins])
}
