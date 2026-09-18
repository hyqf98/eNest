/**
 * mockData — 无主进程时的本地插件注册表与持久化
 * 提供市场插件样例、分类列表、localStorage 持久化的安装状态 / 主题 / 设置。
 * 仅被 shellApi 的 mock 实现与 MarketPage 的 CATEGORIES 使用。
 * 依赖：@shared/types/plugin。
 */
import type { BackgroundConfig, PluginSummary, SplashBackgroundConfig, ThemeMode } from '@shared/types/plugin'
import { DEFAULT_PLUGIN_UI } from '@shared/types/plugin'

const DEFAULT_INSTALLED: string[] = []

/** 市场样例插件目录（mock 数据源）；ui 统一补默认值 */
export const MARKET_PLUGINS: PluginSummary[] = (
  [
    {
      id: 'com.enest.screen-assistant',
      name: '屏幕助手',
      author: 'eNest Labs',
      description: '矩形截图、矩形录屏（可选声音）与截图贴到屏幕。',
      version: '1.0.0',
      installs: '9.6k',
      category: '媒体',
      color: '#38bdf8',
      glyph: '▣',
      permissions: [
        'screen.capture',
        'screen.record',
        'pin.create',
        'clipboard.writeImage',
        'storage.local',
        'ui.setTitle',
        'ui.toast',
      ],
      installed: false,
    },
    {
      id: 'com.enest.clipboard',
      name: '粘贴板',
      author: 'eNest Labs',
      description: '剪贴板历史、图片回显与快速选中回写。',
      version: '1.0.0',
      installs: '12.4k',
      category: '效率',
      color: '#5b8cff',
      glyph: 'C',
      permissions: [
        'clipboard.read',
        'clipboard.write',
        'clipboard.readImage',
        'clipboard.writeImage',
        'clipboard.history',
        'storage.local',
        'ui.setTitle',
        'ui.toast',
      ],
      installed: false,
    },
    {
      id: 'com.enest.translate',
      name: '翻译',
      author: 'Lingua',
      description: '谷歌翻译引擎，自动检测语言，一键复制译文。',
      version: '1.0.0',
      installs: '15.2k',
      category: '效率',
      color: '#f5a524',
      glyph: '文',
      permissions: [
        'net.fetch',
        'clipboard.read',
        'clipboard.write',
        'storage.local',
        'ui.setTitle',
        'ui.toast',
      ],
      installed: false,
    },
  ] as Array<Omit<PluginSummary, 'ui'> & { ui?: PluginSummary['ui'] }>
).map((p) => ({ ...p, ui: p.ui ?? { ...DEFAULT_PLUGIN_UI } }))

/** 市场分类筛选项（含「全部」） */
export const CATEGORIES = ['全部', '效率', '媒体', '开发', '设计'] as const

const INSTALLED_KEY = 'enest.installed.v1'
const DISABLED_KEY = 'enest.disabled.v1'
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

function readDisabledIds(): string[] {
  try {
    const raw = localStorage.getItem(DISABLED_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function writeDisabledIds(ids: string[]): void {
  localStorage.setItem(DISABLED_KEY, JSON.stringify(ids))
}

/** 本地插件注册表：按 localStorage 中的已安装 id 列表过滤样例插件，并合并启用状态 */
export const mockRegistry = {
  readInstalledIds,
  writeInstalledIds,
  getPlugins(): PluginSummary[] {
    const ids = readInstalledIds()
    const disabled = new Set(readDisabledIds())
    return MARKET_PLUGINS.map((p) => ({
      ...p,
      installed: ids.includes(p.id),
      enabled: !disabled.has(p.id),
    }))
  },
  install(id: string): PluginSummary | undefined {
    const ids = readInstalledIds()
    if (!ids.includes(id)) writeInstalledIds([...ids, id])
    return this.getPlugins().find((p) => p.id === id)
  },
  uninstall(id: string): void {
    writeInstalledIds(readInstalledIds().filter((x) => x !== id))
    this.setEnabled(id, true)
  },
  setEnabled(id: string, enabled: boolean): PluginSummary | undefined {
    const disabled = new Set(readDisabledIds())
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    writeDisabledIds([...disabled])
    return this.getPlugins().find((p) => p.id === id)
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

/** Tab 呈现方式 */
export type TabStyle = 'classic' | 'orb'

/** 动画效果强度 */
export type AnimationLevel = 'low' | 'medium' | 'high'

/** 通用设置（契约：locale / hardwareAcceleration / dataRoot? / closeBehavior / tabStyle / animationLevel） */
export interface GeneralSettingsData {
  locale?: 'zh-CN' | 'en-US'
  hardwareAcceleration?: boolean
  dataRoot?: string
  /** 与 @shared GeneralSettings 对齐：minimize-tray | quit */
  closeBehavior?: 'minimize-tray' | 'quit'
  tabStyle?: TabStyle
  animationLevel?: AnimationLevel
  openAtLogin?: boolean
  /** 当前界面中文/默认字体 CSS font-family */
  fontFamily?: string
  /** 英文/Latin 优先字体栈；有值时 --font = en + cjk 拼接 */
  fontFamilyEn?: string
  /** 界面字号倍率（0.9 / 1.0 / 1.15 / 1.3） */
  fontSizeScale?: number
  /** 已上传自定义字体元数据 */
  customFonts?: { id: string; name: string; family: string; fileName: string }[]
  /** 会话恢复：上次打开的插件 Tab */
  sessionTabs?: Array<{ pluginId: string; title?: string }>
  /** 会话恢复：上次激活的插件 id */
  sessionActivePluginId?: string
  /** 网络代理；none/缺省 = 直连 */
  proxy?: { type: 'none' | 'http' | 'socks5' | 'custom'; host?: string; port?: number; url?: string }
  /** 启动 Splash 背景；缺省 brand = 默认品牌色 */
  splashBackground?: SplashBackgroundConfig
  [key: string]: unknown
}

/**
 * 壳子设置数据形状 — 与主进程 SettingsData 对齐（theme/general/plugins）。
 * 保留扁平字段以兼容既有 mock 读取方。
 */
export interface ShellSettingsData {
  theme?: { mode: ThemeMode; overrides?: Record<string, Record<string, string>>; packId?: string; background?: BackgroundConfig }
  general?: GeneralSettingsData
  plugins?: Record<string, Record<string, unknown>>
  /** @deprecated mock 兼容扁平字段 */
  launchAtLogin?: boolean
  closeBehavior?: 'minimize-tray' | 'quit'
  devMode?: boolean
  autoDevTools?: boolean
}

/** 设置默认值（含契约 general 字段） */
export const DEFAULT_SETTINGS: ShellSettingsData = {
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
    splashBackground: { type: 'brand', opacity: 0.55 },
  },
  launchAtLogin: true,
  closeBehavior: 'minimize-tray',
  devMode: true,
  autoDevTools: false,
}

/** 读取 mock 设置（localStorage，缺省回落 DEFAULT_SETTINGS，general 做浅合并 + 历史值归一） */
export function readMockSettings(): ShellSettingsData {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<ShellSettingsData>
      const general = { ...DEFAULT_SETTINGS.general, ...saved.general }
      // 历史 localStorage 可能存 'tray'，归一到共享契约 'minimize-tray'
      if ((general.closeBehavior as string | undefined) === 'tray') {
        general.closeBehavior = 'minimize-tray'
      }
      const flat = saved.closeBehavior
      return {
        ...DEFAULT_SETTINGS,
        ...saved,
        general,
        closeBehavior: general.closeBehavior === 'quit' || flat === 'quit' ? 'quit' : 'minimize-tray',
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
