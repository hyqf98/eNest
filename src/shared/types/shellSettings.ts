import type { BackgroundConfig, PluginWindowGeometry, SessionTabRef, SplashBackgroundConfig, ThemeMode } from './plugin'

/** Tab 呈现方式 */
export type TabStyle = 'classic' | 'orb'

/** 动画效果强度 */
export type AnimationLevel = 'low' | 'medium' | 'high'

/** 通用设置（契约：locale / hardwareAcceleration / dataRoot? / closeBehavior / notifyPosition / tabStyle / animationLevel） */
export interface GeneralSettingsData {
  locale?: 'zh-CN' | 'en-US'
  hardwareAcceleration?: boolean
  dataRoot?: string
  /** 与 @shared GeneralSettings 对齐：minimize-tray | quit */
  closeBehavior?: 'minimize-tray' | 'quit'
  /** 与 @shared GeneralSettings 对齐：center | bottom-right */
  notifyPosition?: 'center' | 'bottom-right'
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
  sessionTabs?: SessionTabRef[]
  mainWindowState?: PluginWindowGeometry
  /** 会话恢复：上次激活的插件 id */
  sessionActivePluginId?: string
  /** 网络代理；none/缺省 = 直连 */
  proxy?: { type: 'system' | 'none' | 'http'; host?: string; port?: number }
  /** 启动 Splash 背景；缺省 brand = 默认品牌色 */
  splashBackground?: SplashBackgroundConfig
  [key: string]: unknown
}

/**
 * 壳子设置数据形状 — 与主进程 SettingsData 对齐（theme/general/plugins）。
 * 保留扁平字段以兼容既有 mock 读取方。
 */
export interface ShellSettingsData {
  theme?: { mode: ThemeMode; overrides?: Record<string, Record<string, string>>; packId?: string; background?: BackgroundConfig; backgroundSource?: 'user' | 'pack'; backgroundEffect?: string }
  general?: GeneralSettingsData
  plugins?: Record<string, Record<string, unknown>>
  /** 每插件快捷启动配置表（键 = pluginId）；读取用，写入走 setPluginLaunch */
  pluginLaunch?: Record<string, import('@shared/types/plugin').PluginLaunchConfig>
  pluginShortcuts?: import('@shared/types/shortcuts').PluginShortcutBinding[]
  quick?: { enabled?: boolean; hotkeys?: string[]; activeHotkey?: string }
  /** 个人资料段（GitHub OAuth 配置 + 已连接账号；与主进程 SettingsData.profile 对齐） */
  profile?: { githubClientId?: string; user?: import('@shared/types/plugin').UserProfile }
  /** @deprecated mock 兼容扁平字段 */
  launchAtLogin?: boolean
  closeBehavior?: 'minimize-tray' | 'quit'
  devMode?: boolean
  autoDevTools?: boolean
}
