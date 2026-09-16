/**
 * SettingsStore — 全局设置持久化
 * 职责：读写 ~/eNest/settings.json（经 pathsService，不再用 userData），
 * 管理主题（含 packId / background）、通用设置与各插件的独立设置项。
 * 被 index.ts 加载，被 shellHandlers / pluginHandlers 调用。
 * 关键依赖：pathsService、sendShellEvent（主题变更推送）。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  GeneralSettings as SharedGeneralSettings,
  ThemeMode,
  ThemeTokens
} from '@shared/types/plugin'
import { getDefaultSettingsPath, setAppPathsRoot } from '../paths/pathsService'
import { sendShellEvent } from '../window/createShellWindow'

/** 通用设置：以 shared 契约为准，保留历史 openAtLogin 扩展字段 */
export type GeneralSettings = SharedGeneralSettings & {
  openAtLogin?: boolean
  [key: string]: unknown
}

export interface SettingsData {
  theme: ThemeTokens
  general: GeneralSettings
  plugins: Record<string, Record<string, unknown>>
}

const DEFAULTS: SettingsData = {
  theme: { mode: 'light', overrides: {} },
  general: {
    locale: 'zh-CN',
    hardwareAcceleration: true,
    closeBehavior: 'minimize-tray'
  },
  plugins: {}
}

function settingsPath(): string {
  return getDefaultSettingsPath()
}

export class SettingsStore {
  private data: SettingsData = structuredClone(DEFAULTS)
  private loaded = false

/** 从 ~/eNest/settings.json 加载设置，损坏时回退默认值；并应用 general.dataRoot 覆盖 */
  async load(): Promise<void> {
    const file = settingsPath()
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(await readFile(file, 'utf-8')) as Partial<SettingsData>
        this.data = {
          theme: { ...DEFAULTS.theme, ...raw.theme, overrides: raw.theme?.overrides ?? {} },
          general: { ...DEFAULTS.general, ...raw.general },
          plugins: { ...raw.plugins }
        }
      } catch {
        this.data = structuredClone(DEFAULTS)
      }
    }
    this.loaded = true
    // dataRoot 覆盖只影响 plugins/data/themes/database，settings 始终写默认路径
    setAppPathsRoot(this.data.general.dataRoot ?? null)
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.data = structuredClone(DEFAULTS)
  }

  getAll(): SettingsData {
    this.ensureLoaded()
    return structuredClone(this.data)
  }

  getTheme(): ThemeTokens {
    this.ensureLoaded()
    return structuredClone(this.data.theme)
  }

/** 更新主题 mode / overrides / packId / background，持久化后推送 theme-changed */
  async setTheme(theme: Partial<ThemeTokens>): Promise<ThemeTokens> {
    this.ensureLoaded()
    if (theme.mode) this.data.theme.mode = theme.mode as ThemeMode
    if (theme.overrides) {
      for (const key of ['light', 'dark'] as const) {
        if (theme.overrides[key]) {
          this.data.theme.overrides[key] = theme.overrides[key]
        }
      }
    }
    if (theme.packId !== undefined) this.data.theme.packId = theme.packId
    if (theme.background !== undefined) this.data.theme.background = theme.background
    await this.persist()
    sendShellEvent({ type: 'theme-changed', mode: this.data.theme.mode })
    return this.getTheme()
  }

/** 浅合并更新 theme/general/plugins 并持久化；dataRoot 变更即时生效 */
  async setAll(partial: Partial<SettingsData>): Promise<SettingsData> {
    this.ensureLoaded()
    if (partial.theme) this.data.theme = { ...this.data.theme, ...partial.theme }
    if (partial.general) this.data.general = { ...this.data.general, ...partial.general }
    if (partial.plugins) this.data.plugins = { ...this.data.plugins, ...partial.plugins }
    if (partial.general && 'dataRoot' in partial.general) {
      setAppPathsRoot(this.data.general.dataRoot ?? null)
    }
    await this.persist()
    return this.getAll()
  }

  getPluginSettings(pluginId: string): Record<string, unknown> {
    this.ensureLoaded()
    return structuredClone(this.data.plugins[pluginId] ?? {})
  }

/** 写入单个插件的设置项，自动创建插件设置对象 */
  async setPluginSetting(pluginId: string, key: string, value: unknown): Promise<void> {
    this.ensureLoaded()
    if (!this.data.plugins[pluginId]) this.data.plugins[pluginId] = {}
    this.data.plugins[pluginId][key] = value
    await this.persist()
  }

  private async persist(): Promise<void> {
    const file = settingsPath()
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(this.data, null, 2), 'utf-8')
  }
}

export const settingsStore = new SettingsStore()
