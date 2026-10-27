/**
 * PluginSettingsBridge — 插件设置注入桥
 * 职责：管理插件注册的设置 section 与运行时值，变更时向壳子推送 settings-sections 事件。
 * 持久化（插槽化架构修复「重启即失」）：
 *  - section 声明写入 ContributionRegistry 的 contributions 表（slot='settings'），
 *    listAll() 优先读表 —— 重启后插件未打开也能显示声明式 section；
 *  - 运行值仍走 settingsStore 的 plugins 段，bridge 内存值仅兜底。
 * 被 pluginHandlers（settings.register/get/set）、shellHandlers（ShellGetSettingsSections）调用。
 * 关键依赖：createShellWindow.sendShellEvent、ContributionRegistry、settingsStore。
 */
import { sendShellEvent } from '@main/window/createShellWindow'
import { contributionRegistry } from '@main/contrib/ContributionRegistry'
import { settingsStore } from '@main/settings/SettingsStore'
import { CONTRIB_SCHEMA_VERSION, type SettingsSectionContribution } from '@shared/types/plugin'
import type { ShellSettingsSection } from '@shared/types/shell'
import { logWarn } from '@main/logs/logService'
import { isPluginSettingKey } from '@shared/pluginSettingsKeys'

export class PluginSettingsBridge {
  private values = new Map<string, Record<string, unknown>>()

  /**
   * 注册插件设置 section（同 id 覆盖）：
   * 1. 声明（含 items schema）落 contributions 表（slot='settings'）——持久化，重启回显；
   * 2. 首次注册时用 items 的 default 初始化运行时值，已持久化值优先回填。
   */
  register(pluginId: string, section: SettingsSectionContribution): void {
    if (!pluginId || !section?.id || !section.title) {
      logWarn('settings-bridge', 'register rejected: invalid section')
      return
    }
    if (section.schemaVersion !== undefined && section.schemaVersion !== CONTRIB_SCHEMA_VERSION) {
      throw new Error('unsupported settings schema version')
    }
    const items = Array.isArray(section.items) ? section.items.filter(item => isPluginSettingKey(item?.key)) : []
    contributionRegistry.registerSettingsSection(pluginId, {
      id: section.id,
      title: section.title,
      schemaVersion: section.schemaVersion,
      items: items.map((item) => ({
        key: item?.key ?? '',
        type: item?.type ?? 'text',
        shareWithThemes: item.shareWithThemes === true,
        label: item?.label ?? item?.key ?? '',
        entry: item?.entry,
        default: item?.default,
        options: item?.options,
        min: item?.min,
        max: item?.max,
        step: item?.step
      }))
    })

    if (!this.values.has(pluginId)) {
      const persisted = settingsStore.getPluginSettings(pluginId)
      const defaults: Record<string, unknown> = {}
      for (const item of items) {
        if (item?.key && item.type !== 'page') {
          defaults[item.key] =
            Object.hasOwn(persisted, item.key) ? persisted[item.key] : item.default
        }
      }
      this.values.set(pluginId, defaults)
    }
    this.emit()
  }

  /** 运行时注销（插件主动调用场景少，卸载走 unregisterBySource） */
  unregister(pluginId: string): void {
    contributionRegistry.unregisterSettingsSections(pluginId)
    this.values.delete(pluginId)
    this.emit()
  }

  /**
   * 全部 section：优先读 contributions 表（声明式 + 运行时注册统一入表），
   * 表不可用（sqlite 初始化失败）时降级为空列表。重启后插件未打开也在此拿到声明。
   */
  listAll(): ShellSettingsSection[] {
    return contributionRegistry
      .listSlot<SettingsSectionContribution>('settings')
      .filter((row) => row.data && Array.isArray(row.data.items))
      .map((row) => ({
        id: row.id,
        title: row.data.title,
        pluginId: row.source,
        items: row.data.items.filter(item => isPluginSettingKey(item?.key))
      }))
  }

  get(pluginId: string, key: string): unknown {
    if (!isPluginSettingKey(key)) return undefined
    const bag = this.values.get(pluginId)
    if (bag && Object.hasOwn(bag, key)) return bag[key]
    for (const section of this.listAll()) {
      if (section.pluginId !== pluginId) continue
      const item = section.items.find(item => item.key === key && item.type !== 'page')
      if (item) return item.default
    }
    return undefined
  }

  /** A page contribution is an action, never a persisted preference value. */
  isWritableKey(pluginId: string, key: string): boolean {
    return isPluginSettingKey(key) && this.listAll().some(section => section.pluginId === pluginId
      && section.items.some(item => item.key === key && item.type !== 'page'))
  }

  set(pluginId: string, key: string, value: unknown): void {
    if (!isPluginSettingKey(key)) throw new Error('reserved plugin settings key')
    const bag = this.values.get(pluginId) ?? {}
    bag[key] = value
    this.values.set(pluginId, bag)
  }

  private emit(): void {
    sendShellEvent({ type: 'settings-sections', sections: this.listAll() })
    // settings-sections 与 contributions-changed(slot=settings) 同源；后者供通用插槽消费方刷新
    sendShellEvent({ type: 'contributions-changed', slot: 'settings', source: '*' })
  }
}

export const pluginSettingsBridge = new PluginSettingsBridge()
