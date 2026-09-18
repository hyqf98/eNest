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
  QuickLauncherSettings,
  ThemeMode,
  ThemeTokens
} from '@shared/types/plugin'
import { getDefaultSettingsPath, setAppPathsRoot } from '@main/paths/pathsService'
import { kvStore } from '@main/db/sqliteService'
import { sendShellEvent } from '@main/window/createShellWindow'

/** 通用设置：以 shared 契约为准，保留历史 openAtLogin 扩展字段 */
export type GeneralSettings = SharedGeneralSettings & {
  openAtLogin?: boolean
  [key: string]: unknown
}

/** 平台默认呼出快捷键；多条任一成功即启用。A/B 预设都要有默认值便于设置页展示 */
export function defaultQuickHotkeys(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return ['Alt+Space', 'Control+Space']
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

/** settings 表中的唯一行键 */
const SETTINGS_ROW_KEY = 'app'

function anchorPath(): string {
  return getDefaultSettingsPath()
}

/** 锚点（或旧版全量文件）里除 dataRoot 外是否还有实质内容 */
function isLegacyFullSettings(raw: Partial<SettingsData> | null): boolean {
  if (!raw) return false
  if (raw.theme !== undefined) return true
  if (raw.plugins !== undefined && Object.keys(raw.plugins).length > 0) return true
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

    // 3) 最终 dataRoot 校正（库内值可能与锚点不同步）
    setAppPathsRoot((this.data.general.dataRoot as string | undefined) ?? null)

    // 库不可用：回退全量文件模式（保持可用性优先）
    this.fileFallback = kvStore.getBackend() !== 'sqlite'
    if (this.fileFallback && legacyFull && raw) {
      // 库不可用时继续沿用旧文件内容
      this.data = this.mergeDefaults(raw)
    }
  }

  /** 合并默认值与存量数据（浅合并，theme.overrides 单独保底） */
  private mergeDefaults(raw: Partial<SettingsData> | null): SettingsData {
    if (!raw) return structuredClone(DEFAULTS)
    return {
      theme: { ...DEFAULTS.theme, ...raw.theme, overrides: raw.theme?.overrides ?? {} },
      general: { ...DEFAULTS.general, ...raw.general },
      plugins: { ...raw.plugins }
    }
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
    const prevRoot = this.data.general.dataRoot as string | undefined
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
    // dataRoot 变更：锚点立即更新，并把设置行预写到新根的库，避免下次启动读到空库
    const nextRoot = this.data.general.dataRoot as string | undefined
    if (nextRoot !== prevRoot && !this.fileFallback) {
      writeAnchor(nextRoot)
      this.migrateRowToNewRoot(nextRoot)
    }
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

  /** 落盘：库模式写 settings 行（WAL 自带持久化保证）；回退模式沿用整文件原子写 */
  private persistNow(): void {
    try {
      if (this.fileFallback || !writeSettingsRow(this.data)) {
        if (this.fileFallback) {
          // 库不可用兜底：全量写文件（旧行为）
          const file = anchorPath()
          mkdirSync(dirname(file), { recursive: true })
          const tmp = `${file}.tmp`
          writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
          renameSync(tmp, file)
          return
        }
        // 库意外不可用（运行中掉线）：临时回退文件，下次启动仍优先读库
        console.warn('[enest] settings db write failed, fallback to file this round')
        const file = anchorPath()
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
        renameSync(tmp, file)
      }
    } catch (err) {
      console.error('[enest] settings persist failed', err)
    }
  }

  private async persist(): Promise<void> {
    // 兼容旧调用点：内部改为防抖；紧急一致性场景用 flushNow()
    this.schedulePersist()
  }
}

export const settingsStore = new SettingsStore()
