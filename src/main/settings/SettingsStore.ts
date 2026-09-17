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
import { nativeTheme } from 'electron'
import type {
  GeneralSettings as SharedGeneralSettings,
  QuickLauncherSettings,
  ThemeMode,
  ThemeTokens
} from '@shared/types/plugin'
import { getDefaultSettingsPath, setAppPathsRoot } from '@main/paths/pathsService'
import { sendShellEvent } from '@main/window/createShellWindow'

/** 通用设置：以 shared 契约为准，保留历史 openAtLogin 扩展字段 */
export type GeneralSettings = SharedGeneralSettings & {
  openAtLogin?: boolean
  [key: string]: unknown
}

/** 平台默认呼出快捷键；多条任一成功即启用 */
export function defaultQuickHotkeys(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return ['Alt+Space']
  return ['Alt+Space', 'Control+Space']
}

export function defaultQuickLauncher(): QuickLauncherSettings {
  return { enabled: true, hotkeys: defaultQuickHotkeys() }
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
    closeBehavior: 'minimize-tray',
    tabStyle: 'classic',
    animationLevel: 'medium',
    fontFamily: '',
    fontFamilyEn: '',
    fontSizeScale: 1,
    customFonts: [],
    sessionTabs: [],
    sessionActivePluginId: '',
    proxy: { type: 'none' },
    quickLauncher: defaultQuickLauncher(),
    splashBackground: { type: 'brand', opacity: 0.55 }
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
      const ov = theme.overrides as Record<string, Record<string, string> | undefined>
      for (const key of ['light', 'dark'] as const) {
        if (ov[key]) {
          this.data.theme.overrides[key] = ov[key]
        }
      }
      // system 模式：preload 把 overrides 写在 system 键，这里按 nativeTheme 落到 light/dark
      if (ov.system) {
        const resolved: 'light' | 'dark' = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
        this.data.theme.overrides[resolved] = ov.system
      }
    }
    // 用 `in` 判断：显式传 undefined/null 可清除 packId / background（取消主题包/背景）
    if ('packId' in theme) this.data.theme.packId = theme.packId
    if ('background' in theme) this.data.theme.background = theme.background
    await this.persist()
    sendShellEvent({ type: 'theme-changed', mode: this.data.theme.mode })
    return this.getTheme()
  }

/** 浅合并更新 theme/general/plugins 并持久化；dataRoot 变更即时生效 */
  async setAll(partial: Partial<SettingsData>): Promise<SettingsData> {
    this.ensureLoaded()
    if (partial.theme) this.data.theme = { ...this.data.theme, ...partial.theme }
    if (partial.general) this.data.general = { ...this.data.general, ...partial.general }
    // plugins 按插件 id 合并 bag，避免整包覆盖丢失未提交的键
    if (partial.plugins) {
      for (const [id, bag] of Object.entries(partial.plugins)) {
        this.data.plugins[id] = { ...(this.data.plugins[id] ?? {}), ...(bag ?? {}) }
      }
    }
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
