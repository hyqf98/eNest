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
import { kvStore } from '@main/db/sqliteService'
import { sendShellEvent } from '@main/window/createShellWindow'
import { normalizeSearchText } from '@shared/search'
import { filterPermissionGrants, isBuiltinCapability } from '@shared/pluginPermissionPolicy'
import { isPluginSettingKey } from '@shared/pluginSettingsKeys'
import type { PluginShortcutBinding } from '@shared/types/shortcuts'
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
  general: GeneralSettings
  plugins: Record<string, Record<string, unknown>>
  /** 每插件 Quick 搜索偏好（启动方式/触发词）；键 = pluginId */
  pluginLaunch: PluginLaunchSettings
  pluginShortcuts: PluginShortcutBinding[]
  /** 个人资料段（GitHub OAuth 配置 + 已连接账号；token 不在此处） */
  profile: ProfileSettings
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
  plugins: {},
  pluginLaunch: {},
  pluginShortcuts: [],
  profile: {}
}

/** settings 表中的唯一行键 */
const SETTINGS_ROW_KEY = 'app'

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
    // Persist removal of legacy hotkey fields before registering the migrated bindings.
    if (Object.values((this.fileFallback ? raw : stored)?.pluginLaunch ?? {})
      .some(config => config && Object.hasOwn(config, 'hotkey'))) this.flushNow()
  }

  /** 合并默认值与存量数据（浅合并，theme.overrides 单独保底） */
  private mergeDefaults(raw: Partial<SettingsData> | null): SettingsData {
    if (!raw) return structuredClone(DEFAULTS)
    const migrated = migratePluginShortcuts(raw.pluginLaunch, raw.pluginShortcuts)
    return {
      theme: { ...DEFAULTS.theme, ...raw.theme, overrides: raw.theme?.overrides ?? {} },
      general: { ...DEFAULTS.general, ...raw.general },
      plugins: { ...raw.plugins },
      pluginLaunch: migrated.pluginLaunch,
      pluginShortcuts: migrated.pluginShortcuts,
      profile: { ...DEFAULTS.profile, ...raw.profile }
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.data = structuredClone(DEFAULTS)
  }

  getAll(): SettingsData {
    this.ensureLoaded()
    return structuredClone(this.data)
  }

  getQuickLauncherSettings(): QuickLauncherSettings {
    this.ensureLoaded()
    return structuredClone(this.data.general.quickLauncher ?? defaultQuickLauncher())
  }

  /** 同步更新狭窄的 Quick 状态，避免搜索/启动复制所有插件设置。 */
  recordQuickUse(id: string, query: string | undefined, maxRecent: number): void {
    this.ensureLoaded()
    const quick = this.data.general.quickLauncher ??= defaultQuickLauncher()
    const previous = quick.recent ?? []
    const count = previous.find(entry => entry.id === id)?.count ?? 0
    quick.recent = [{ id, ts: Date.now(), count: count + 1 }, ...previous.filter(entry => entry.id !== id)]
      .slice(0, maxRecent)
    const normalized = normalizeSearchText(query ?? '')
    // Long content belongs to the invoked plugin, not the query-preference store.
    if (normalized && normalized.length <= 32) {
      quick.queryPreferences = [{ query: normalized, id }, ...(quick.queryPreferences ?? [])
        .filter(entry => entry.query !== normalized)].slice(0, 100)
    }
    this.schedulePersist()
  }

  /** Small appearance snapshot for native plugin documents; excludes history, grants and window state. */
  getPluginAppearance(): Pick<GeneralSettings, 'fontFamily' | 'fontFamilyEn' | 'fontSizeScale' | 'animationLevel' | 'customFonts'> {
    this.ensureLoaded()
    const { fontFamily, fontFamilyEn, fontSizeScale, animationLevel, customFonts } = this.data.general
    return { fontFamily, fontFamilyEn, fontSizeScale, animationLevel, customFonts: structuredClone(customFonts ?? []) }
  }

  getPluginLaunchRevision(): number { return this.pluginLaunchRevision }

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
    this.commitShortcutSettings({ ...this.data, pluginShortcuts: structuredClone(bindings) })
  }

  /** Quick's native key and saved selection must commit as one user operation. */
  setQuickHotkeys(config: { enabled: boolean; hotkeys: string[]; activeHotkey: string }): void {
    this.ensureLoaded()
    this.commitShortcutSettings({ ...this.data, general: {
      ...this.data.general,
      quickLauncher: { ...this.data.general.quickLauncher, ...structuredClone(config) }
    } })
  }

  private commitShortcutSettings(next: SettingsData): void {
    // Native registration and persisted configuration form one user operation.
    // Do not acknowledge a save that a deferred writer could silently lose.
    if (this.fileFallback) {
      const file = anchorPath()
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
      renameSync(tmp, file)
    } else if (!writeSettingsRow(next)) {
      // Falling back to the anchor here would be misleading: the next boot gives
      // an existing database row priority over that file. Keep the old binding.
      throw new Error('快捷键设置写入失败，已保留原配置；请检查数据目录是否可写')
    }
    this.data = next
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null }
  }

  getTheme(): ThemeTokens {
    this.ensureLoaded()
    return structuredClone(this.data.theme)
  }

  /** 更新主题 mode / overrides / packId / background，持久化后推送 theme-changed */
  async setTheme(theme: Partial<ThemeTokens>): Promise<ThemeTokens> {
    validateBackgroundEffectSelection(theme.backgroundEffect)
    if (theme.backgroundSource !== undefined && theme.backgroundSource !== 'user' && theme.backgroundSource !== 'pack') {
      throw new Error('invalid background source')
    }
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
    if ('backgroundSource' in theme) this.data.theme.backgroundSource = theme.backgroundSource
    if ('backgroundEffect' in theme) this.data.theme.backgroundEffect = theme.backgroundEffect
    if (this.data.theme.backgroundSource === 'pack') delete this.data.theme.background
    else if ('background' in theme) this.data.theme.background = theme.background
    this.schedulePersist()
    sendShellEvent({ type: 'theme-changed', mode: this.data.theme.mode })
    return this.getTheme()
  }

  /** 浅合并更新 theme/general/plugins 并持久化；dataRoot 变更即时生效 */
  async setAll(partial: Partial<Omit<SettingsData, 'general'>> & { general?: Partial<GeneralSettings> }): Promise<SettingsData> {
    validateBackgroundEffectSelection(partial.theme?.backgroundEffect)
    this.ensureLoaded()
    const prevRoot = this.data.general.dataRoot as string | undefined
    if (partial.theme) this.data.theme = { ...this.data.theme, ...partial.theme }
    if (partial.general) this.data.general = { ...this.data.general, ...partial.general }
    // plugins 按插件 id 合并 bag，避免整包覆盖丢失未提交的键
    if (partial.plugins) {
      for (const [id, bag] of Object.entries(partial.plugins)) {
        this.data.plugins[id] = { ...(this.data.plugins[id] ?? {}), ...(bag ?? {}) }
      }
    }
    // pluginLaunch 按插件 id 合并（null = 删除该插件配置）
    if (partial.pluginLaunch) {
      this.pluginLaunchRevision++
      for (const [id, cfg] of Object.entries(partial.pluginLaunch)) {
        if (cfg === null) delete this.data.pluginLaunch[id]
        else {
          const { hotkey: _legacyHotkey, ...preferences } = cfg
          this.data.pluginLaunch[id] = { ...(this.data.pluginLaunch[id] ?? {}), ...preferences }
        }
      }
    }
    // profile 浅合并（githubClientId 等；user 字段由 githubAuthService 经 setProfileUser 管理）
    if (partial.profile) {
      const { user: _incomingUser, ...rest } = partial.profile
      this.data.profile = { ...this.data.profile, ...rest, user: this.data.profile.user }
    }
    if (partial.general && 'dataRoot' in partial.general) {
      setAppPathsRoot(this.data.general.dataRoot ?? null)
    }
    this.schedulePersist()
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

  /** 写入单个插件的设置项，自动创建插件设置对象 */
  async setPluginSetting(pluginId: string, key: string, value: unknown): Promise<void> {
    if (!isPluginSettingKey(key)) throw new Error('reserved plugin settings key')
    this.ensureLoaded()
    if (!this.data.plugins[pluginId]) this.data.plugins[pluginId] = {}
    this.data.plugins[pluginId][key] = value
    this.schedulePersist()
  }

  /** 卸载时移除插件设置与宿主授权，重装同一 ID 必须重新授权。 */
  async removePluginSettings(pluginId: string): Promise<void> {
    this.ensureLoaded()
    if (!Object.hasOwn(this.data.plugins, pluginId)) return
    delete this.data.plugins[pluginId]
    this.schedulePersist()
    sendShellEvent({ type: 'permission-grants-changed', pluginId, grants: {} })
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

  /** 触发防抖持久化；所有写路径（setTheme/setAll/setPluginSetting/…）统一走这里 */
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
