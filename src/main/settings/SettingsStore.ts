/**
 * SettingsStore — 全局设置持久化（统一数据库 enest.db）
 * 职责：设置全量（theme/general/plugins）落 {dataRoot}/data/enest.db 的 settings 表；
 *      默认路径的 settings.json 降级为「引导锚点」，只保存 general.dataRoot——
 *      因为数据库路径本身依赖 dataRoot，需要一个固定位置的指针在启动早期定位库文件。
 * 迁移：首次加载发现旧版全量 settings.json 时导入入库，并把文件重写为锚点。
 * 兜底：数据库不可用（backend=none）时回退旧版「整文件原子写」行为，设置绝不丢。
 * 被 index.ts 加载，被 shellHandlers / pluginHandlers 调用。
 * 关键依赖：kvStore（同库连接）、pathsService、sendShellEvent（主题变更推送）。
 */
import { existsSync, renameSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { nativeTheme } from 'electron'
import type {
  GeneralSettings as SharedGeneralSettings,
  PluginLaunchConfig,
  PluginLaunchSettings,
  PluginPermission,
  PluginPermissionGrant,
  ProfileSettings,
  QuickLauncherSettings,
  ThemeMode,
  ThemeTokens,
  UserProfile
} from '@shared/types/plugin'
import { getDefaultSettingsPath, setAppPathsRoot } from '@main/paths/pathsService'
import { resolveLocalUserPath } from '@main/paths/userPath'
import { kvStore } from '@main/db/sqliteService'
import { sendShellEvent } from '@main/window/createShellWindow'
import { DEFAULT_PANEL_APPEARANCE, type PersistedPanel } from '@shared/types/panel'
import { filterPermissionGrants, isBuiltinCapability } from '@shared/pluginPermissionPolicy'
import { isPluginSettingKey } from '@shared/pluginSettingsKeys'
import type { PluginShortcutBinding } from '@shared/types/shortcuts'
import { DEFAULT_PLUGIN_MEMORY_MONITOR, normalizePluginMemoryMonitor } from '@shared/types/pluginMemory'
import { emptyOpenWithRoutes, type OpenWithRoutes } from '@shared/types/openWith'
import type { AppearanceSettings, LegacyAppearanceBackup } from '@shared/types/appearance'
import { migrateAppearanceSettings, THEME_PROFILE_LEGACY, themeProfileKey } from '@shared/theme/appearance'
import { migratePluginShortcuts } from './pluginShortcutMigration'

/** 通用设置：以 shared 契约为准，保留历史 openAtLogin 扩展字段 */
export type GeneralSettings = SharedGeneralSettings & {
  openAtLogin?: boolean
  [key: string]: unknown
}

/** 平台默认呼出快捷键；多条任一成功即启用。A/B 预设都要有默认值便于设置页展示 */
export function defaultQuickHotkeys(_platform: NodeJS.Platform = process.platform): string[] {
  return ['Alt+Space', 'Control+Space']
}

export function defaultQuickLauncher(): QuickLauncherSettings {
  return { enabled: true, hotkeys: defaultQuickHotkeys() }
}

export interface SettingsData {
  theme: ThemeTokens
  appearance?: AppearanceSettings
  general: GeneralSettings
  plugins: Record<string, Record<string, unknown>>
  /** 每插件 Quick 搜索偏好（启动方式/触发词）；键 = pluginId */
  pluginLaunch: PluginLaunchSettings
  pluginShortcuts: PluginShortcutBinding[]
  /** 个人资料段（GitHub OAuth 配置 + 已连接账号；token 不在此处） */
  profile: ProfileSettings
  /** 自由面板布局；只由主进程写（renderer 写入在 shell:set-settings 被剥离）。 */
  panels: PersistedPanel[]
  /** 「打开方式」路由表（类型/scheme → pluginId）；只由主进程写。 */
  openWith: OpenWithRoutes
}

const DEFAULTS: SettingsData = {
  theme: { mode: 'light', overrides: {} },
  general: {
    locale: 'zh-CN',
    hardwareAcceleration: true,
    closeBehavior: 'minimize-tray',
    notifyPosition: 'bottom-right',
    pluginMemoryMonitor: { ...DEFAULT_PLUGIN_MEMORY_MONITOR },
    tabStyle: 'classic',
    animationLevel: 'medium',
    fontFamily: '',
    fontFamilyEn: '',
    fontSizeScale: 1,
    customFonts: [],
    sessionTabs: [],
    sessionActivePluginId: '',
    proxy: { type: 'system' },
    quickLauncher: defaultQuickLauncher(),
    splashBackground: { type: 'brand', opacity: 0.55 },
    freePanel: { enabled: false },
    panelAppearance: { ...DEFAULT_PANEL_APPEARANCE }
  },
  plugins: {},
  pluginLaunch: {},
  pluginShortcuts: [],
  profile: {},
  panels: [],
  openWith: emptyOpenWithRoutes()
}

/** settings 表中的唯一行键 */
const SETTINGS_ROW_KEY = 'app'

function appearanceInputs(data: SettingsData): unknown[] {
  const { fontFamily, fontFamilyEn, fontSizeScale, animationLevel, splashBackground, tabStyle, customFonts, dataRoot } = data.general
  return [data.appearance, data.theme, fontFamily, fontFamilyEn, fontSizeScale, animationLevel, splashBackground, tabStyle, customFonts, dataRoot]
}

/** 路由表结构校验：只保留 `ext`/`scheme` 两桶的 string→string，限制规模 */
function normalizeOpenWithRoutes(raw: unknown): OpenWithRoutes {
  const out = emptyOpenWithRoutes()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const kind of ['ext', 'scheme'] as const) {
    const bag = (raw as Record<string, unknown>)[kind]
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue
    for (const [value, pluginId] of Object.entries(bag as Record<string, unknown>)) {
      if (typeof pluginId !== 'string' || !pluginId.trim()) continue
      if (Object.keys(out[kind]).length >= 256) break
      out[kind][value] = pluginId
    }
  }
  return out
}

function validateBackgroundEffectSelection(value: unknown): void {
  if (value !== undefined && (typeof value !== 'string' || value.length > 1024
    || !value.trim() || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new Error('invalid background effect')
  }
}

function anchorPath(): string {
  return getDefaultSettingsPath()
}

/** 锚点（或旧版全量文件）里除 dataRoot 外是否还有实质内容 */
function isLegacyFullSettings(raw: Partial<SettingsData> | null): boolean {
  if (!raw) return false
  if (raw.theme !== undefined) return true
  if (raw.plugins !== undefined && Object.keys(raw.plugins).length > 0) return true
  if (raw.pluginLaunch !== undefined || raw.pluginShortcuts !== undefined) return true
  if (raw.panels !== undefined && raw.panels.length > 0) return true
  const generalKeys = Object.keys(raw.general ?? {})
  return generalKeys.some((k) => k !== 'dataRoot')
}

/** 写引导锚点：只含 dataRoot（为空时写空对象占位，避免误判为旧版全量） */
function writeAnchor(dataRoot: string | null | undefined): void {
  try {
    const file = anchorPath()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    const body = dataRoot ? { general: { dataRoot } } : {}
    writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf-8')
    renameSync(tmp, file)
  } catch (err) {
    console.error('[enest] settings anchor write failed', err)
  }
}

/** 读锚点 / 旧版全量文件；损坏或不存在返回 null */
function readAnchorOrLegacy(): Partial<SettingsData> | null {
  const file = anchorPath()
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Partial<SettingsData>
  } catch {
    return null
  }
}

/** 确保 settings 表存在并读取行；库不可用返回 null */
function readSettingsRow(): Partial<SettingsData> | null {
  const db = kvStore.getDatabase()
  if (!db) return null
  try {
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_ROW_KEY) as { value: string } | undefined
    if (!row) return null
    return JSON.parse(row.value) as Partial<SettingsData>
  } catch (err) {
    console.error('[enest] settings row read failed', err)
    return null
  }
}

/** upsert 设置行；库不可用返回 false */
function writeSettingsRow(data: SettingsData): boolean {
  const db = kvStore.getDatabase()
  if (!db) return false
  try {
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(SETTINGS_ROW_KEY, JSON.stringify(data))
    return true
  } catch (err) {
    console.error('[enest] settings row write failed', err)
    return false
  }
}

export class SettingsStore {
  private data: SettingsData = structuredClone(DEFAULTS)
  private loaded = false
  private pluginLaunchRevision = 0
  private appearanceInputRevision = 0
  /** 库不可用时的文件回退模式（保持旧行为：全量写 settings.json） */
  private fileFallback = false
  /** 防抖持久化句柄；写路径统一 schedulePersist()，退出前 flushNow() 兜底 */
  private persistTimer: NodeJS.Timeout | null = null
  private static PERSIST_DEBOUNCE_MS = 200

  /**
   * 启动加载：
   * 1) 读锚点/旧版文件 → 用 dataRoot 定位并初始化统一库；
   * 2) 优先读库内 settings 行；库为空且旧文件是全量 → 首次迁移入库并把文件降级为锚点；
   * 3) dataRoot 以最终数据为准再校正一次路径。
   */
  async load(): Promise<void> {
    const raw = readAnchorOrLegacy()
    const legacyFull = isLegacyFullSettings(raw)
    const legacyRoot = (raw?.general?.dataRoot as string | undefined) ?? null

    // 1) 用锚点（或旧文件）里的 dataRoot 先定位数据库
    setAppPathsRoot(legacyRoot)
    await kvStore.initDatabase()

    // 2) 库内行优先；首次迁移旧全量文件
    let stored: Partial<SettingsData> | null = readSettingsRow()
    if (!stored && legacyFull && raw) {
      stored = raw
      if (writeSettingsRow(this.mergeDefaults(raw))) {
        // 入库成功后把旧文件降级为锚点，避免下次重复导入
        writeAnchor(legacyRoot)
      }
    }
    this.data = this.mergeDefaults(stored)
    this.loaded = true
    this.pluginLaunchRevision++

    // 3) 最终 dataRoot 校正（库内值可能与锚点不同步）
    setAppPathsRoot((this.data.general.dataRoot as string | undefined) ?? null)

    // 库不可用：回退全量文件模式（保持可用性优先）
    this.fileFallback = kvStore.getBackend() !== 'sqlite'
    if (this.fileFallback && legacyFull && raw) {
      // 库不可用时继续沿用旧文件内容
      this.data = this.mergeDefaults(raw)
    }
    this.appearanceInputRevision++
    // Persist removal of legacy hotkey fields before registering the migrated bindings.
    if (Object.values((this.fileFallback ? raw : stored)?.pluginLaunch ?? {})
      .some(config => config && Object.hasOwn(config, 'hotkey'))) this.flushNow()
  }

  /** 合并默认值与存量数据（浅合并，theme.overrides 单独保底） */
  private mergeDefaults(raw: Partial<SettingsData> | null): SettingsData {
    raw ??= {}
    const migrated = migratePluginShortcuts(raw.pluginLaunch, raw.pluginShortcuts)
    const migratedAppearance = migrateAppearanceSettings(raw.appearance, {
      theme: raw.theme ?? structuredClone(DEFAULTS.theme),
      general: this.legacyAppearanceGeneral(raw.general ?? {})
    })
    const general = { ...DEFAULTS.general, ...raw.general }
    Reflect.deleteProperty(general, 'themeSetupComplete')
    return {
      theme: { ...DEFAULTS.theme, ...raw.theme, overrides: raw.theme?.overrides ?? {} },
      appearance: migratedAppearance,
      general,
      plugins: { ...raw.plugins },
      pluginLaunch: migrated.pluginLaunch,
      pluginShortcuts: migrated.pluginShortcuts,
      profile: { ...DEFAULTS.profile, ...raw.profile },
      panels: Array.isArray(raw.panels) ? raw.panels : [],
      openWith: normalizeOpenWithRoutes(raw.openWith)
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.data = structuredClone(DEFAULTS)
  }

  getAll(): SettingsData {
    this.ensureLoaded()
    return structuredClone(this.data)
  }

  getPluginMemoryMonitorSettings() {
    this.ensureLoaded()
    return normalizePluginMemoryMonitor(this.data.general.pluginMemoryMonitor)
  }

  getLocale(): GeneralSettings['locale'] {
    this.ensureLoaded()
    return this.data.general.locale
  }

  getQuickLauncherSettings(): QuickLauncherSettings {
    this.ensureLoaded()
    return structuredClone(this.data.general.quickLauncher ?? defaultQuickLauncher())
  }

  /** Small appearance snapshot for native plugin documents; excludes history, grants and window state. */
  getPluginAppearance(): Pick<GeneralSettings, 'fontFamily' | 'fontFamilyEn' | 'fontSizeScale' | 'animationLevel' | 'customFonts'> {
    this.ensureLoaded()
    const { fontFamily, fontFamilyEn, fontSizeScale, animationLevel, customFonts } = this.data.general
    return { fontFamily, fontFamilyEn, fontSizeScale, animationLevel, customFonts: structuredClone(customFonts ?? []) }
  }

  getPluginLaunchRevision(): number { return this.pluginLaunchRevision }

  getAppearanceInputRevision(): number { return this.appearanceInputRevision }

  /** 写入/清除已连接账号（githubAuthService 专用；事件由服务侧发布） */
  setProfileUser(user: UserProfile | null): void {
    this.ensureLoaded()
    if (user) this.data.profile.user = user
    else delete this.data.profile.user
    this.schedulePersist()
  }

  getPluginLaunchSettings(): PluginLaunchSettings {
    this.ensureLoaded()
    return structuredClone(this.data.pluginLaunch ?? {})
  }

  getPluginLaunchConfig(id: string): PluginLaunchConfig | undefined {
    this.ensureLoaded()
    return structuredClone(this.data.pluginLaunch?.[id])
  }

  getPluginShortcuts(): PluginShortcutBinding[] {
    this.ensureLoaded()
    return structuredClone(this.data.pluginShortcuts)
  }

  /** Shortcut service only: generic settings updates cannot change native registrations. */
  setPluginShortcuts(bindings: PluginShortcutBinding[]): void {
    this.ensureLoaded()
    this.commitSettings({ ...this.data, pluginShortcuts: structuredClone(bindings) })
  }

  /** Quick's native key and saved selection must commit as one user operation. */
  setQuickHotkeys(config: { enabled: boolean; hotkeys: string[]; activeHotkey: string }): void {
    this.ensureLoaded()
    this.commitSettings({ ...this.data, general: {
      ...this.data.general,
      quickLauncher: { ...this.data.general.quickLauncher, ...structuredClone(config) }
    } })
  }

  setPanelHotkey(accelerator: string): void {
    this.ensureLoaded()
    this.commitSettings({ ...this.data, general: { ...this.data.general, panelHotkey: accelerator } })
    sendShellEvent({ type: 'settings-changed', generalKeys: ['panelHotkey'] })
  }

  /** Confirmed shortcut replacement persists both owners in the same durable write. */
  setShortcutConfiguration(bindings: PluginShortcutBinding[], quick?: { enabled: boolean; hotkeys: string[]; activeHotkey: string }): void {
    this.ensureLoaded()
    this.commitSettings({ ...this.data, pluginShortcuts: structuredClone(bindings),
      ...(quick ? { general: { ...this.data.general,
        quickLauncher: { ...this.data.general.quickLauncher, ...structuredClone(quick) }
      } } : {}) })
  }

  private commitSettings(next: SettingsData): void {
    // Save acknowledgements and the persisted configuration form one user operation.
    // Do not acknowledge a save that a deferred writer could silently lose.
    if (this.fileFallback) {
      const file = anchorPath()
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
      renameSync(tmp, file)
    } else if (!writeSettingsRow(next)) {
      // Falling back to the anchor here would be misleading: the next boot gives
      // an existing database row priority over that file. Keep the old configuration.
      throw new Error('设置写入失败，已保留原配置；请检查数据目录是否可写')
    }
    if (!isDeepStrictEqual(appearanceInputs(this.data), appearanceInputs(next))) this.appearanceInputRevision++
    this.data = next
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null }
  }

  getTheme(): ThemeTokens {
    this.ensureLoaded()
    return structuredClone(this.data.theme)
  }

  private legacyAppearanceGeneral(general: Partial<GeneralSettings>): LegacyAppearanceBackup['general'] {
    const { fontFamily, fontFamilyEn, fontSizeScale, animationLevel, splashBackground, tabStyle } = general
    return structuredClone({ fontFamily, fontFamilyEn, fontSizeScale, animationLevel, splashBackground, tabStyle })
  }

  /** Keep V1 fields current without overriding the migrated V2 mode authority. */
  getAppearanceSettings(): AppearanceSettings {
    this.ensureLoaded()
    const legacy = { theme: this.getTheme(), general: this.legacyAppearanceGeneral(this.data.general) }
    const settings = migrateAppearanceSettings(this.data.appearance, legacy)
    settings.legacy = legacy
    return settings
  }

  /** No success state or revision is exposed before the durable write succeeds. */
  commitAppearanceSettings(appearance: AppearanceSettings): void {
    this.ensureLoaded()
    const next = { ...this.data, appearance: structuredClone(appearance) }
    this.commitSettings(next)
  }

  /** Revoke a font and its exact selections in one durable write; keep all other profiles. */
  commitAppearanceFontRemoval(fontId: string, family: string, fontFields: Record<string, string[]>): void {
    this.ensureLoaded()
    const matches = (value: unknown): value is string => typeof value === 'string' && value.split(',')
      .some(part => part.trim().replace(/^(["'])(.*)\1$/, '$2') === family)
    const fonts = this.data.general.customFonts ?? []
    if (!family || !fonts.some(font => font.id === fontId && font.family === family)) throw new Error('Font library changed; refresh before editing')
    const appearance = structuredClone(this.getAppearanceSettings())
    for (const [profileKey, profile] of Object.entries(appearance.profiles)) {
      for (const key of fontFields[profileKey] ?? []) if (matches(profile.values[key])) delete profile.values[key]
    }
    const general = { ...this.data.general, customFonts: fonts.filter(font => font.id !== fontId) }
    if (matches(general.fontFamily)) general.fontFamily = ''
    if (matches(general.fontFamilyEn)) general.fontFamilyEn = ''
    appearance.revision++
    appearance.legacy = { ...appearance.legacy, general: this.legacyAppearanceGeneral(general) }
    this.commitSettings({ ...this.data, general, appearance })
    sendShellEvent({ type: 'settings-changed', generalKeys: ['customFonts', 'fontFamily', 'fontFamilyEn'] })
  }

  /** The workspace receives descriptors, not permission to replace a settings bag. */
  commitGeneralPreferences(patch: Partial<Pick<GeneralSettings, 'locale' | 'hardwareAcceleration' | 'closeBehavior' | 'notifyPosition'>>): void {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(patch))) throw new Error('Invalid general preferences')
    const descriptors = Object.getOwnPropertyDescriptors(patch)
    const allowed = new Set(['locale', 'hardwareAcceleration', 'closeBehavior', 'notifyPosition'])
    for (const key of Reflect.ownKeys(patch)) {
      if (typeof key !== 'string' || !allowed.has(key) || !('value' in descriptors[key])) throw new Error('Invalid general preference key')
      const value: unknown = descriptors[key].value
      if (key === 'locale' ? value !== 'zh-CN' && value !== 'en-US'
        : key === 'hardwareAcceleration' ? typeof value !== 'boolean'
          : key === 'closeBehavior' ? value !== 'quit' && value !== 'minimize-tray'
            : value !== 'center' && value !== 'bottom-right') throw new Error('Invalid general preference value')
    }
    if (!Object.keys(patch).length) return
    this.ensureLoaded()
    const next = { ...this.data, general: { ...this.data.general, ...patch } }
    this.commitSettings(next)
    sendShellEvent({ type: 'settings-changed', generalKeys: Object.keys(patch) })
  }

  /** 更新主题 mode / overrides / packId / background，持久化后推送 theme-changed */
  async setTheme(theme: Partial<ThemeTokens>): Promise<ThemeTokens> {
    validateBackgroundEffectSelection(theme.backgroundEffect)
    if (theme.mode !== undefined && !['light', 'dark', 'system'].includes(theme.mode)) {
      throw new Error('invalid theme mode')
    }
    if (theme.backgroundSource !== undefined && theme.backgroundSource !== 'user' && theme.backgroundSource !== 'pack') {
      throw new Error('invalid background source')
    }
    this.ensureLoaded()
    const appearance = this.getAppearanceSettings()
    const nextTheme = structuredClone(this.data.theme)
    if (theme.mode) {
      nextTheme.mode = theme.mode as ThemeMode
      appearance.mode = nextTheme.mode
    }
    if (theme.overrides) {
      const ov = theme.overrides as Record<string, Record<string, string> | undefined>
      const legacyProfile = appearance.profiles[themeProfileKey(THEME_PROFILE_LEGACY)]
      for (const key of ['light', 'dark'] as const) {
        if (ov[key]) {
          nextTheme.overrides[key] = structuredClone(ov[key])
          legacyProfile.colors[key] = structuredClone(ov[key])
        }
      }
      // system 模式：preload 把 overrides 写在 system 键，这里按 nativeTheme 落到 light/dark
      if (ov.system) {
        const resolved: 'light' | 'dark' = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
        nextTheme.overrides[resolved] = structuredClone(ov.system)
        legacyProfile.colors[resolved] = structuredClone(ov.system)
      }
    }
    // 用 `in` 判断：显式传 undefined/null 可清除 packId / background（取消主题包/背景）
    if ('packId' in theme) nextTheme.packId = theme.packId
    if ('backgroundSource' in theme) nextTheme.backgroundSource = theme.backgroundSource
    if ('backgroundEffect' in theme) nextTheme.backgroundEffect = theme.backgroundEffect
    if (nextTheme.backgroundSource === 'pack') delete nextTheme.background
    else if ('background' in theme) nextTheme.background = structuredClone(theme.background)
    appearance.legacy = { ...appearance.legacy, theme: structuredClone(nextTheme) }
    this.commitSettings({ ...this.data, theme: nextTheme, appearance })
    sendShellEvent({ type: 'theme-changed', mode: this.data.theme.mode })
    return this.getTheme()
  }

  /** 浅合并更新 theme/general/plugins 并持久化；dataRoot 变更即时生效 */
  async setAll(partial: Partial<Omit<SettingsData, 'general'>> & { general?: Partial<GeneralSettings> }): Promise<SettingsData> {
    // openWith 路由表主进程独占（renderer 写入一律剥离；写入走 openWith:* 通道）
    if ('openWith' in partial) {
      const { openWith: _openWith, ...rest } = partial
      partial = rest
    }
    validateBackgroundEffectSelection(partial.theme?.backgroundEffect)
    if (partial.general && Object.hasOwn(partial.general, 'pluginMemoryMonitor')) {
      const value = partial.general.pluginMemoryMonitor
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.enabled !== 'boolean' || typeof value.alertsEnabled !== 'boolean'
        || !Number.isInteger(value.warningThresholdMiB) || value.warningThresholdMiB < 128 || value.warningThresholdMiB > 8192) {
        throw new Error('invalid plugin memory monitor preferences')
      }
      partial = { ...partial, general: { ...partial.general, pluginMemoryMonitor: normalizePluginMemoryMonitor(value) } }
    }
    if (partial.general && 'dataRoot' in partial.general) {
      const root = partial.general.dataRoot
      if (root != null && typeof root !== 'string') throw new Error('数据目录必须是本地路径')
      // Normalize before mutating settings, and persist an absolute path for future launches.
      partial = { ...partial, general: { ...partial.general,
        dataRoot: root?.trim() ? resolveLocalUserPath(root.trim(), { baseDir: process.cwd() }) : undefined
      } }
    }
    this.ensureLoaded()
    const previousAppearance = appearanceInputs(this.data)
    const next = this.data
    const prevRoot = this.data.general.dataRoot as string | undefined
    if (partial.theme) next.theme = { ...next.theme, ...partial.theme }
    if (partial.general) {
      next.general = { ...next.general, ...partial.general }
      Reflect.deleteProperty(next.general, 'themeSetupComplete')
    }
    // plugins 按插件 id 合并 bag，避免整包覆盖丢失未提交的键
    if (partial.plugins) {
      for (const [id, bag] of Object.entries(partial.plugins)) {
        next.plugins[id] = { ...(next.plugins[id] ?? {}), ...(bag ?? {}) }
      }
    }
    // pluginLaunch 按插件 id 合并（null = 删除该插件配置）
    if (partial.pluginLaunch) {
      for (const [id, cfg] of Object.entries(partial.pluginLaunch)) {
        if (cfg === null) delete next.pluginLaunch[id]
        else {
          const { hotkey: _legacyHotkey, ...preferences } = cfg
          next.pluginLaunch[id] = { ...(next.pluginLaunch[id] ?? {}), ...preferences }
        }
      }
    }
    // profile 浅合并（githubClientId 等；user 字段由 githubAuthService 经 setProfileUser 管理）
    if (partial.profile) {
      const { user: _incomingUser, ...rest } = partial.profile
      next.profile = { ...next.profile, ...rest, user: next.profile.user }
    }
    // panels 整体替换：面板布局是主进程独占的完整快照，逐条合并会留下已删面板。
    if (partial.panels) next.panels = structuredClone(partial.panels)
    if (!isDeepStrictEqual(previousAppearance, appearanceInputs(next))) this.appearanceInputRevision++
    this.schedulePersist()
    if (partial.pluginLaunch) this.pluginLaunchRevision++
    if (partial.general && 'dataRoot' in partial.general) {
      setAppPathsRoot(this.data.general.dataRoot ?? null)
    }
    // dataRoot 变更：锚点立即更新，并把设置行预写到新根的库，避免下次启动读到空库
    const nextRoot = this.data.general.dataRoot as string | undefined
    if (nextRoot !== prevRoot && !this.fileFallback) {
      writeAnchor(nextRoot)
      this.migrateRowToNewRoot(nextRoot)
    }
    if (partial.theme) sendShellEvent({ type: 'theme-changed', mode: this.data.theme.mode })
    const generalKeys = Object.keys(partial.general ?? {})
    if (generalKeys.length) sendShellEvent({ type: 'settings-changed', generalKeys })
    return this.getAll()
  }

  getPluginSettings(pluginId: string): Record<string, unknown> {
    this.ensureLoaded()
    return structuredClone(Object.fromEntries(
      Object.entries(this.data.plugins[pluginId] ?? {}).filter(([key]) => isPluginSettingKey(key))
    ))
  }

  /** Commit before publishing the value; a failed write keeps the last confirmed settings. */
  async setPluginSetting(pluginId: string, key: string, value: unknown): Promise<void> {
    if (!isPluginSettingKey(key)) throw new Error('reserved plugin settings key')
    this.ensureLoaded()
    const plugins = { ...this.data.plugins, [pluginId]: {
      ...this.data.plugins[pluginId], [key]: structuredClone(value)
    } }
    this.commitSettings({ ...this.data, plugins })
  }

  /** 卸载时移除插件设置与宿主授权，重装同一 ID 必须重新授权。 */
  async removePluginSettings(pluginId: string): Promise<void> {
    this.ensureLoaded()
    if (!Object.hasOwn(this.data.plugins, pluginId)) return
    delete this.data.plugins[pluginId]
    this.schedulePersist()
    sendShellEvent({ type: 'permission-grants-changed', pluginId, grants: {} })
  }

  // —— 「打开方式」路由表（主进程独占；renderer 只读投影）——

  getOpenWithRoutes(): OpenWithRoutes {
    this.ensureLoaded()
    return structuredClone(this.data.openWith)
  }

  /** 写入一条路由（同键覆盖） */
  async setOpenWithRoute(kind: 'ext' | 'scheme', value: string, pluginId: string): Promise<OpenWithRoutes> {
    this.ensureLoaded()
    if (!value || !pluginId) throw new Error('invalid openWith route')
    this.data.openWith[kind][value] = pluginId
    this.schedulePersist()
    return this.getOpenWithRoutes()
  }

  /** 移除一条路由（幂等） */
  async clearOpenWithRoute(kind: 'ext' | 'scheme', value: string): Promise<OpenWithRoutes> {
    this.ensureLoaded()
    if (Object.hasOwn(this.data.openWith[kind], value)) {
      delete this.data.openWith[kind][value]
      this.schedulePersist()
    }
    return this.getOpenWithRoutes()
  }

  /** 卸载/禁用插件：清掉指向它的全部路由 */
  async removeOpenWithRoutesForPlugin(pluginId: string): Promise<void> {
    this.ensureLoaded()
    let changed = false
    for (const kind of ['ext', 'scheme'] as const) {
      for (const [value, target] of Object.entries(this.data.openWith[kind])) {
        if (target === pluginId) {
          delete this.data.openWith[kind][value]
          changed = true
        }
      }
    }
    if (changed) this.schedulePersist()
  }

  // —— 运行时权限授权（壳层三态；存 plugins[pluginId].permissionGrants）——

  /** 基础能力始终可用；敏感权限未设置缺省 'ask'。旧基础能力拒绝值不再生效。 */
  getPermissionGrant(pluginId: string, perm: PluginPermission): PluginPermissionGrant {
    if (isBuiltinCapability(perm)) return 'allow'
    this.ensureLoaded()
    const bag = this.data.plugins[pluginId] as
      | { permissionGrants?: Partial<Record<PluginPermission, PluginPermissionGrant>> }
      | undefined
    const grant = bag?.permissionGrants?.[perm]
    return grant === 'allow' || grant === 'deny' ? grant : 'ask'
  }

  /** 写入单项授权并防抖持久化 */
  async setPermissionGrant(
    pluginId: string,
    perm: PluginPermission,
    grant: PluginPermissionGrant
  ): Promise<void> {
    if (isBuiltinCapability(perm)) throw new Error('built-in capabilities do not require user consent')
    this.ensureLoaded()
    const bag = (this.data.plugins[pluginId] ??= {}) as {
      permissionGrants?: Partial<Record<PluginPermission, PluginPermissionGrant>>
    }
    bag.permissionGrants = { ...filterPermissionGrants(bag.permissionGrants), [perm]: grant }
    this.schedulePersist()
    sendShellEvent({ type: 'permission-grants-changed', pluginId, grants: this.getPermissionGrants(pluginId) })
  }

  /** 仅返回敏感权限的授权表；未设置的敏感项语义为 'ask'。 */
  getPermissionGrants(
    pluginId: string
  ): Partial<Record<PluginPermission, PluginPermissionGrant>> {
    this.ensureLoaded()
    const bag = this.data.plugins[pluginId] as
      | { permissionGrants?: Partial<Record<PluginPermission, PluginPermissionGrant>> }
      | undefined
    return filterPermissionGrants(bag?.permissionGrants)
  }

  /** 写入单插件快捷启动配置；null = 删除该插件条目 */
  async setPluginLaunch(
    pluginId: string,
    config: PluginLaunchConfig | null
  ): Promise<void> {
    this.ensureLoaded()
    this.pluginLaunchRevision++
    if (!this.data.pluginLaunch) this.data.pluginLaunch = {}
    if (config === null) delete this.data.pluginLaunch[pluginId]
    else {
      const { hotkey: _legacyHotkey, ...preferences } = config
      this.data.pluginLaunch[pluginId] = preferences
    }
    this.schedulePersist()
  }

  /** dataRoot 变更时把设置行预写到新根的 enest.db（独立短连接，写完即关） */
  private migrateRowToNewRoot(newRoot: string | undefined): void {
    if (!newRoot) return
    try {
      const dbPath = join(newRoot, 'data', 'enest.db')
      mkdirSync(dirname(dbPath), { recursive: true })
      const db = new DatabaseSync(dbPath)
      db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(SETTINGS_ROW_KEY, JSON.stringify(this.data))
      db.close()
    } catch (err) {
      console.error('[enest] settings row migrate to new dataRoot failed', err)
    }
  }

  /** 普通偏好防抖持久化；需要确认成功的外观、快捷键和插件设置使用同步提交。 */
  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, SettingsStore.PERSIST_DEBOUNCE_MS)
  }

  /** 立即落盘（应用退出钩子调用；同时清掉挂起的防抖） */
  flushNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persistNow()
  }

  /** 落盘：库模式写 settings 行（WAL 自带持久化保证）；回退/失败沿用整文件原子写 */
  private persistNow(): void {
    try {
      if (this.fileFallback || !writeSettingsRow(this.data)) {
        // 库不可用兜底（fileFallback）或库意外掉线：全量写文件
        // （下次启动仍优先读库；fileFallback 是长期回退，掉线是单轮回退）
        if (!this.fileFallback) {
          console.warn('[enest] settings db write failed, fallback to file this round')
        }
        const file = anchorPath()
        mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
        renameSync(tmp, file)
      }
    } catch (err) {
      console.error('[enest] settings persist failed', err)
    }
  }
}

export const settingsStore = new SettingsStore()
