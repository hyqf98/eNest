/**
 * PluginSettingsBridge — 插件设置注入桥
 * 职责：管理插件注册的设置 section 与运行时值，变更时向壳子推送 settings-sections 事件。
 * 被 pluginHandlers（settings.register/get/set）调用。
 * 关键依赖：createShellWindow.sendShellEvent（事件推送）。
 */
import { sendShellEvent } from '../window/createShellWindow'

export interface SettingsSectionItem {
  key: string
  type: string
  label: string
  default?: unknown
  options?: Array<{ label: string; value: unknown }>
}

export interface SettingsSection {
  id: string
  title: string
  pluginId: string
  items: SettingsSectionItem[]
}

export class PluginSettingsBridge {
  private sections = new Map<string, SettingsSection[]>()
  private values = new Map<string, Record<string, unknown>>()

/** 注册插件设置 section（同 id 覆盖），首次注册时用 items 的 default 初始化运行时值 */
  register(pluginId: string, section: Omit<SettingsSection, 'pluginId'>): void {
    const list = this.sections.get(pluginId) ?? []
    const merged: SettingsSection = { ...section, pluginId }
    const idx = list.findIndex((s) => s.id === section.id)
    if (idx >= 0) list[idx] = merged
    else list.push(merged)
    this.sections.set(pluginId, list)

    if (!this.values.has(pluginId)) {
      const defaults: Record<string, unknown> = {}
      for (const item of section.items) {
        if (item.default !== undefined) defaults[item.key] = item.default
      }
      this.values.set(pluginId, defaults)
    }
    this.emit()
  }

  unregister(pluginId: string): void {
    this.sections.delete(pluginId)
    this.values.delete(pluginId)
    this.emit()
  }

  listAll(): SettingsSection[] {
    return [...this.sections.values()].flat()
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
  }
}

export const pluginSettingsBridge = new PluginSettingsBridge()
