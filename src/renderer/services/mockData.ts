/**
 * mockData — 无主进程时的本地插件注册表与持久化
 * 提供市场插件样例、分类列表、localStorage 持久化的安装状态 / 主题 / 设置。
 * 仅被 shellApi 的 mock 实现与 MarketPage 的 CATEGORIES 使用。
 * 依赖：@shared/types/plugin。
 */
import type { BackgroundConfig, PluginSummary, ThemeMode } from '@shared/types/plugin'
import { DEFAULT_PLUGIN_UI } from '@shared/types/plugin'

const DEFAULT_INSTALLED = ['com.enest.clipboard', 'com.enest.json']

/** 市场样例插件目录（mock 数据源）；ui 统一补默认值 */
export const MARKET_PLUGINS: PluginSummary[] = (
  [
    {
      id: 'com.enest.clipboard',
      name: '剪贴板历史',
      author: 'eNest Labs',
      description: '本地加密保存剪贴板历史，支持搜索、置顶与一键粘贴。',
      version: '1.2.0',
      installs: '12.4k',
      category: '效率',
      color: '#5b8cff',
      glyph: 'C',
      permissions: ['clipboard.read', 'clipboard.write', 'storage.local'],
      installed: true,
    },
    {
      id: 'com.enest.json',
      name: 'JSON 工坊',
      author: 'Northwind',
      description: '格式化、校验、路径查询与类型生成，开发者日常利器。',
      version: '0.9.3',
      installs: '8.1k',
      category: '开发',
      color: '#3ddc97',
      glyph: '{ }',
      permissions: ['clipboard.read', 'clipboard.write'],
      installed: true,
    },
    {
      id: 'com.enest.color',
      name: '取色器',
      author: 'PixelNest',
      description: '屏幕取色、调色板管理与设计 Token 导出。',
      version: '2.0.1',
      installs: '6.7k',
      category: '设计',
      color: '#a78bfa',
      glyph: '◈',
      permissions: ['storage.local'],
      installed: false,
    },
    {
      id: 'com.enest.translate',
      name: '划词翻译',
      author: 'Lingua',
      description: '多引擎划词与段落翻译，支持术语表与历史回看。',
      version: '1.5.2',
      installs: '15.2k',
      category: '效率',
      color: '#f5a524',
      glyph: '文',
      permissions: ['clipboard.read', 'notify'],
      installed: false,
    },
    {
      id: 'com.enest.todo',
      name: '轻清单',
      author: 'DailyKit',
      description: '全局快捷键唤起的极简待办，本地优先，支持插件设置注入。',
      version: '1.0.4',
      installs: '4.3k',
      category: '效率',
      color: '#ff5c7a',
      glyph: '✓',
      permissions: ['storage.local', 'notify', 'settings.register'],
      installed: false,
    },
    {
      id: 'com.enest.snippet',
      name: '代码片段库',
      author: 'DevNest',
      description: '跨语言片段管理、变量占位与快速插入。',
      version: '0.8.0',
      installs: '3.9k',
      category: '开发',
      color: '#38bdf8',
      glyph: '/',
      permissions: ['clipboard.write', 'storage.local'],
      installed: false,
    },
    {
      id: 'com.enest.canvas-demo',
      name: 'Canvas 动效演示',
      author: 'eNest',
      description: '演示统一 UI 标准：全幅 chrome=none、主题感知与透明背景 Canvas。',
      version: '1.0.0',
      installs: '1.2k',
      category: '开发',
      color: '#22d3ee',
      glyph: '◎',
      permissions: ['ui.setTitle'],
      installed: false,
      ui: {
        chrome: 'none',
        themeAware: true,
        background: 'transparent',
        preferredColorScheme: 'auto',
      },
    },
  ] as Array<Omit<PluginSummary, 'ui'> & { ui?: PluginSummary['ui'] }>
).map((p) => ({ ...p, ui: p.ui ?? { ...DEFAULT_PLUGIN_UI } }))

/** 市场分类筛选项（含「全部」） */
export const CATEGORIES = ['全部', '效率', '开发', '设计'] as const

const INSTALLED_KEY = 'enest.installed.v1'
const THEME_KEY = 'enest.theme.v1'
const SETTINGS_KEY = 'enest.settings.v1'

function readInstalledIds(): string[] {
  try {
    const raw = localStorage.getItem(INSTALLED_KEY)
    return raw ? (JSON.parse(raw) as string[]) : [...DEFAULT_INSTALLED]
  } catch {
    return [...DEFAULT_INSTALLED]
  }
}

function writeInstalledIds(ids: string[]): void {
  localStorage.setItem(INSTALLED_KEY, JSON.stringify(ids))
}

/** 本地插件注册表：按 localStorage 中的已安装 id 列表过滤样例插件 */
export const mockRegistry = {
  readInstalledIds,
  writeInstalledIds,
  getPlugins(): PluginSummary[] {
    const ids = readInstalledIds()
    return MARKET_PLUGINS.map((p) => ({ ...p, installed: ids.includes(p.id) }))
  },
  install(id: string): PluginSummary | undefined {
    const ids = readInstalledIds()
    if (!ids.includes(id)) writeInstalledIds([...ids, id])
    return this.getPlugins().find((p) => p.id === id)
  },
  uninstall(id: string): void {
    writeInstalledIds(readInstalledIds().filter((x) => x !== id))
  },
  getById(id: string): PluginSummary | undefined {
    return this.getPlugins().find((p) => p.id === id)
  },
}

/** mock 主题持久化形状（含 system 模式 / 主题包 id / 背景媒体） */
export interface MockThemeData {
  mode: ThemeMode
  overrides: Partial<Record<'light' | 'dark', Record<string, string>>>
  packId?: string
  background?: BackgroundConfig
}

/** 从 localStorage 读取 mock 主题（mode + overrides + packId + background） */
export function readMockTheme(): MockThemeData {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<MockThemeData>
      const mode: ThemeMode =
        saved.mode === 'dark' || saved.mode === 'system' || saved.mode === 'light'
          ? saved.mode
          : 'light'
      return {
        mode,
        overrides: saved.overrides ?? {},
        packId: saved.packId,
        background: saved.background,
      }
    }
  } catch {
    /* ignore */
  }
  return { mode: 'light', overrides: {} }
}

/** 将 mock 主题写回 localStorage */
export function writeMockTheme(data: MockThemeData): void {
  localStorage.setItem(THEME_KEY, JSON.stringify(data))
}

/** 通用设置（契约：locale / hardwareAcceleration / dataRoot? / closeBehavior） */
export interface GeneralSettingsData {
  locale?: 'zh-CN' | 'en-US'
  hardwareAcceleration?: boolean
  dataRoot?: string
  closeBehavior?: 'tray' | 'quit'
  openAtLogin?: boolean
  [key: string]: unknown
}

/**
 * 壳子设置数据形状 — 与主进程 SettingsData 对齐（theme/general/plugins）。
 * 保留扁平字段以兼容既有 mock 读取方。
 */
export interface ShellSettingsData {
  theme?: { mode: 'light' | 'dark'; overrides?: Record<string, Record<string, string>> }
  general?: GeneralSettingsData
  plugins?: Record<string, Record<string, unknown>>
  /** @deprecated mock 兼容扁平字段 */
  launchAtLogin?: boolean
  closeBehavior?: 'tray' | 'quit'
  devMode?: boolean
  autoDevTools?: boolean
}

/** 设置默认值（含契约 general 字段） */
export const DEFAULT_SETTINGS: ShellSettingsData = {
  general: {
    locale: 'zh-CN',
    hardwareAcceleration: true,
    closeBehavior: 'tray',
  },
  launchAtLogin: true,
  closeBehavior: 'tray',
  devMode: true,
  autoDevTools: false,
}

/** 读取 mock 设置（localStorage，缺省回落 DEFAULT_SETTINGS，general 做浅合并） */
export function readMockSettings(): ShellSettingsData {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<ShellSettingsData>
      return {
        ...DEFAULT_SETTINGS,
        ...saved,
        general: { ...DEFAULT_SETTINGS.general, ...saved.general },
      }
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS, general: { ...DEFAULT_SETTINGS.general } }
}

/** 写入 mock 设置到 localStorage */
export function writeMockSettings(data: ShellSettingsData): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(data))
}
