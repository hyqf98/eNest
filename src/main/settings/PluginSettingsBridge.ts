/**
 * PluginSettingsBridge — 插件设置注入桥
 * 职责：管理插件注册的设置 section 与运行时值，变更时向壳子推送 settings-sections 事件。
 * 持久化（插槽化架构修复「重启即失」）：
 *  - section 声明写入 ContributionRegistry 的 contributions 表（slot='settings'），
 *    listAll() 优先读表 —— 重启后插件未打开也能显示声明式 section；
 *  - 运行值仍走 settingsStore（settings.json plugins 段，现有机制），bridge 内存值仅兜底。
 * 被 pluginHandlers（settings.register/get/set）、shellHandlers（ShellGetSettingsSections）调用。
 * 关键依赖：createShellWindow.sendShellEvent、ContributionRegistry、settingsStore。
 */
import { sendShellEvent } from '@main/window/createShellWindow'
import { contributionRegistry } from '@main/contrib/ContributionRegistry'
import { settingsStore } from '@main/settings/SettingsStore'
import type { SettingsSectionContribution } from '@shared/types/plugin'
import { logWarn } from '@main/logs/logService'

export interface SettingsSectionItem {
  key: string
  type: string
  label: string
  default?: unknown
  options?: Array<{ label: string; value: unknown }>
  /** type=slider：范围与步长（渲染层消费） */
  min?: number
  max?: number
  step?: number
}

export interface SettingsSection {
  id: string
  title: string
  pluginId: string
  items: SettingsSectionItem[]
}

export class PluginSettingsBridge {
  private values = new Map<string, Record<string, unknown>>()

  /**
   * 注册插件设置 section（同 id 覆盖）：
   * 1. 声明（含 items schema）落 contributions 表（slot='settings'）——持久化，重启回显；
   * 2. 首次注册时用 items 的 default 初始化运行时值，已持久化值优先回填。
   */
  register(pluginId: string, section: Omit<SettingsSection, 'pluginId'>): void {
    if (!pluginId || !section?.id || !section.title) {
      logWarn('settings-bridge', 'register rejected: invalid section')
      return
    }
    const items = Array.isArray(section.items) ? section.items : []
    contributionRegistry.registerManifestContributes(pluginId, {
      settings: [
        {
          id: section.id,
          title: section.title,
          items: items.map((item) => ({
            key: item?.key ?? '',
            type: item?.type ?? 'text',
            label: item?.label ?? item?.key ?? '',
            default: item?.default,
            options: item?.options,
            min: item?.min,
            max: item?.max,
            step: item?.step
          }))
        }
      ]
    })

    if (!this.values.has(pluginId)) {
      const persisted = settingsStore.getPluginSettings(pluginId)
      const defaults: Record<string, unknown> = {}
      for (const item of items) {
        if (item?.key) {
          defaults[item.key] =
            item.key in persisted ? persisted[item.key] : item.default
        }
      }
      this.values.set(pluginId, defaults)
    }
    this.emit()
  }

  /** 运行时注销（插件主动调用场景少，卸载走 unregisterBySource） */
  unregister(pluginId: string): void {
    contributionRegistry.unregisterBySource(pluginId)
    this.values.delete(pluginId)
    this.emit()
  }

  /**
   * 全部 section：优先读 contributions 表（声明式 + 运行时注册统一入表），
   * 表不可用（sqlite 初始化失败）时降级为空列表。重启后插件未打开也在此拿到声明。
   */
  listAll(): SettingsSection[] {
    return contributionRegistry
      .listSlot<SettingsSectionContribution>('settings')
      .filter((row) => row.data && Array.isArray(row.data.items))
      .map((row) => ({
        id: row.id,
        title: row.data.title,
        pluginId: row.source,
        items: row.data.items as SettingsSectionItem[]
      }))
  }

  get(pluginId: string, key: string): unknown {
    return this.values.get(pluginId)?.[key]
  }

  set(pluginId: string, key: string, value: unknown): void {
    const bag = this.values.get(pluginId)
    if (!bag) return
    bag[key] = value
  }

  private emit(): void {
    sendShellEvent({ type: 'settings-sections', sections: this.listAll() })
    // settings-sections 与 contributions-changed(slot=settings) 同源；后者供通用插槽消费方刷新
    sendShellEvent({ type: 'contributions-changed', slot: 'settings', source: '*' })
  }
}

export const pluginSettingsBridge = new PluginSettingsBridge()
