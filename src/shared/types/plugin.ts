/** 插件权限白名单键 */
export type PluginPermission =
  | 'clipboard.read'
  | 'clipboard.write'
  | 'clipboard.readImage'
  | 'clipboard.writeImage'
  | 'clipboard.history'
  | 'screen.capture'
  | 'screen.record'
  | 'pin.create'
  | 'net.fetch'
  | 'shell.openExternal'
  | 'storage.local'
  | 'notify'
  | 'ui.setTitle'
  | 'ui.setIcon'
  | 'ui.setBadge'
  | 'ui.resize'
  | 'ui.toast'
  | 'settings.register'
  | 'settings.page'
  | 'hotkey'
  | 'contribute'
  | 'vault.write'
  | 'ssh.session'
  | 'ssh.exec'
  | 'ssh.sftp'
  | 'db.connect'
  | 'db.query'
  | 'db.schema'

/**
 * 权限白名单全列表（与 PluginPermission 联合类型一一对应）。
 * 运行时 manifest 校验用；新增权限时同步：联合类型 + 此常量 +
 * eNest_plugin/docs/plugin-manifest.schema.json 的 permissions 枚举。
 */
export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'clipboard.read',
  'clipboard.write',
  'clipboard.readImage',
  'clipboard.writeImage',
  'clipboard.history',
  'screen.capture',
  'screen.record',
  'pin.create',
  'net.fetch',
  'shell.openExternal',
  'storage.local',
  'notify',
  'ui.setTitle',
  'ui.setIcon',
  'ui.setBadge',
  'ui.resize',
  'ui.toast',
  'settings.register',
  'settings.page',
  'hotkey',
  'contribute',
  'vault.write',
  'ssh.session',
  'ssh.exec',
  'ssh.sftp',
  'db.connect',
  'db.query',
  'db.schema'
]

/** 壳子支持的界面语言（settings.general.locale / enest.i18n） */
export type AppLocale = 'zh-CN' | 'en-US'

/** 屏幕区域（设备像素，相对 capture 的 display） */
export interface ScreenBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 截图结果：PNG dataURL */
export interface ScreenCaptureResult {
  dataUrl: string
  width: number
  height: number
}

/** 剪贴板历史条目（list 不含完整二进制；get 返回完整字段） */
export interface ClipboardHistoryEntry {
  id: string
  type: 'text' | 'image'
  /** 文本截断或图片尺寸摘要，用于列表展示 */
  preview: string
  text?: string
  hasImage?: boolean
  width?: number
  height?: number
  ts: number
  pinned: boolean
  bytes?: number
}

/** 主进程 → 渲染层：剪贴板历史变更（当前插件可订阅） */
export interface ClipboardHistoryChangedPayload {
  type: 'clipboard-history-changed'
  entryId: string
  entryType: 'text' | 'image'
}

export interface PluginFeature {
  code: string
  explain?: string
  cmds: string[]
}

/** 插件宿主 Chrome 模式：default 标准条 / minimal 细条 / none 无条（全幅内容） */
export type PluginChromeMode = 'default' | 'minimal' | 'none'

/** 插件页面背景：opaque 自绘底色 / transparent 透出壳子背景 */
export type PluginBackgroundMode = 'transparent' | 'opaque'

/** 插件偏好的配色：light/dark 强制，auto 跟随壳子主题 */
export type PluginPreferredColorScheme = 'light' | 'dark' | 'auto'

/**
 * plugin.json `ui` 段（全部可选，缺省见 DEFAULT_PLUGIN_UI）。
 * 插件可保留自有 HTML/CSS/Canvas/WebGL，壳子负责 chrome 高度、主题 token 与背景透明。
 */
export interface PluginUiConfig {
  chrome: PluginChromeMode
  /** 为 true 时壳子向插件页注入 CSS 变量并推送主题变更 */
  themeAware: boolean
  background: PluginBackgroundMode
  preferredColorScheme: PluginPreferredColorScheme
}

/** ui 缺省：chrome=none（全幅渲染，无插件名条）、themeAware=true、background=opaque、preferredColorScheme=auto */
export const DEFAULT_PLUGIN_UI: PluginUiConfig = {
  // 插件页完全由插件自身渲染；壳子不再叠「名称 + URL」顶栏（对齐 uTools）
  chrome: 'none',
  themeAware: true,
  background: 'opaque',
  preferredColorScheme: 'auto'
}

/** 将 manifest.ui（可缺省/可残缺）归一为完整 PluginUiConfig，非法值回退默认 */
export function resolvePluginUi(ui?: Partial<PluginUiConfig> | null): PluginUiConfig {
  return {
    // 壳子默认无顶栏；仅当显式 minimal 时保留细条（兼容历史插件）
    chrome: ui?.chrome === 'minimal' ? 'minimal' : 'none',
    themeAware: ui?.themeAware !== false,
    background:
      ui?.background === 'transparent' ? 'transparent' : DEFAULT_PLUGIN_UI.background,
    preferredColorScheme:
      ui?.preferredColorScheme === 'light' || ui?.preferredColorScheme === 'dark'
        ? ui.preferredColorScheme
        : DEFAULT_PLUGIN_UI.preferredColorScheme
  }
}

/**
 * 插件呈现形态：
 * - mini：命令面板（Quick 小窗）优先；骨架阶段打开时仍进主窗 Tab
 * - panel：主壳子大插件 Tab（终端/数据库等），缺省
 */
export type PluginForm = 'mini' | 'panel'

// —— 插件贡献点（Contribution Points，插槽化架构）——

/** 贡献点 schema 版本；与壳子 ContributionRegistry 支持版本不匹配时拒绝注册 */
export const CONTRIB_SCHEMA_VERSION = '1'

/**
 * Quick 搜索 provider 贡献（运行时注册，manifest 不声明）：
 * 插件经 enest.contribute.registerQuickProvider({ id, explain }) 注册后，
 * Quick 搜索时主进程向插件 webContents 推 quick-query，插件回传结果项。
 */
export interface QuickProviderContribution {
  /** provider id（插件内唯一；全局键 = `${pluginId}:${id}`） */
  id: string
  /** 展示名 / 用途说明（搜索命中 provider 项时的副标题） */
  explain?: string
  /** 贡献点 schema 版本；缺省视为当前版本 */
  schemaVersion?: string
}

/** 设置 section 贡献项形状（与 PluginSettingsBridge 的 SettingsSection item 对齐） */
export interface SettingsSectionContributionItem {
  key: string
  /**
   * 控件类型：text / switch / select / number / boolean / slider / color / page。
   * - slider 需 min/max/step；color 渲染颜色输入；page 为 stretch（本期仅声明）。
   * - 非法类型渲染层回退 text。
   */
  type: string
  label: string
  default?: unknown
  options?: Array<{ label: string; value: unknown }>
  /** type=slider：范围与步长 */
  min?: number
  max?: number
  step?: number
}

/** 声明式设置 section（manifest.contributes.settings；持久化，重启即显示） */
export interface SettingsSectionContribution {
  id: string
  title: string
  items: SettingsSectionContributionItem[]
  /** 贡献点 schema 版本；缺省视为当前版本 */
  schemaVersion?: string
}

/** 首页卡片贡献（manifest.contributes.homeCards；市场页首页「插件扩展」区块） */
export interface HomeCardContribution {
  id: string
  title: string
  /** 单字符 glyph（缺省用插件名首字） */
  glyph?: string
  /** 主题色（缺省回退插件色） */
  color?: string
  /** 说明文案 */
  explain?: string
  /** 点击打开插件时透传的 feature code */
  openCode?: string
  /** 贡献点 schema 版本；缺省视为当前版本 */
  schemaVersion?: string
}

/** 左侧轨道入口贡献（orb 模式；本期仅数据层，渲染消费见交接说明） */
export interface RailEntryContribution {
  id: string
  /** 单字符 glyph（圆点图标内容） */
  glyph: string
  /** 主题色 */
  color?: string
  /** 悬停标题 */
  title?: string
  /** 点击打开插件时透传的 feature code */
  openCode?: string
  /** 贡献点 schema 版本；缺省视为当前版本 */
  schemaVersion?: string
}

/**
 * 插件贡献点声明（manifest.contributes + 运行时注册统一形状）。
 * - settings / homeCards / railEntries / themePacks：声明式，Registry scan 时入库；
 * - quickProviders：运行时注册（provider 逻辑在插件 webContents 内，不可序列化）。
 */
export interface PluginContributes {
  /** Quick 搜索 provider：注册异步查询入口（运行时注册，manifest 不声明） */
  quickProviders?: QuickProviderContribution[]
  /** 设置 section（声明式，持久化，重启即显示） */
  settings?: SettingsSectionContribution[]
  /** 首页卡片 */
  homeCards?: HomeCardContribution[]
  /** 左侧轨道入口（orb 模式） */
  railEntries?: RailEntryContribution[]
  /** 主题包（并入统一语义，等价现有 theme.register） */
  themePacks?: ThemePack[]
}

/** 贡献点插槽名（contributions 表 slot 字段枚举） */
export type ContributionSlot = 'settings' | 'home-cards' | 'rail-entries' | 'theme-packs'

/** 运行时读取贡献项时附加的来源信息 */
export interface SourcedContribution<T> {
  /** 贡献来源插件 id */
  source: string
  /** 插槽内 id */
  id: string
  data: T
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  logo?: string
  main: string
  settings?: string
  engines?: { enest?: string }
  permissions?: PluginPermission[]
  window?: { minWidth?: number; minHeight?: number }
  features?: PluginFeature[]
  development?: { main?: string }
  /** UI 集成配置；缺省等价 DEFAULT_PLUGIN_UI */
  ui?: Partial<PluginUiConfig>
  /** 打开形态；缺省 panel（主窗 Tab） */
  form?: PluginForm
  /** 贡献点声明（插槽化架构）：settings/homeCards/railEntries/themePacks */
  contributes?: PluginContributes
}

/** 命令面 / 设置使用的插件 form 归一 */
export function resolvePluginForm(form?: string | null): PluginForm {
  return form === 'mini' ? 'mini' : 'panel'
}

/** 市场/已安装列表使用的插件摘要 */
export interface PluginSummary {
  id: string
  name: string
  version: string
  description: string
  author: string
  category: string
  installs: string
  color: string
  glyph: string
  /** 图标 URL：已安装插件为 enest://plugin/{id}/{logo}，远程市场为 registry 条目的 icon URL；缺省回退 glyph 色块 */
  icon?: string
  permissions: PluginPermission[]
  installed: boolean
  /** 是否启用；缺省/undefined 视为 true。禁用时 openPlugin 拒绝，Quick 索引排除 */
  enabled?: boolean
  /** 远程市场存在更高版本时的版本号（已安装插件才有） */
  latestVersion?: string
  rootPath?: string
  devUrl?: string
  /** 开发态插件（开发者控制台加载，未复制到 userData） */
  dev?: boolean
  /** 已归一的 UI 配置（供壳子 chrome / 主题注入使用） */
  ui: PluginUiConfig
  /** 已归一的打开形态；缺省 panel */
  form?: PluginForm
  /**
   * manifest 贡献点声明透传（已安装插件才有；渲染层消费 homeCards 等，
   * 声明式注册不依赖插件运行）。
   */
  contributes?: PluginContributes
}

/** 市场安装结果：sample 本地同步安装 / remote 已入队下载 */
export type MarketInstallMode = 'sample' | 'remote' | 'already'

export interface MarketInstallResult {
  ok: boolean
  mode?: MarketInstallMode
  /** remote 模式的队列任务 id（进度经 install-progress 推送） */
  jobId?: string
  name?: string
  error?: string
}

export interface PluginTab {
  id: string
  pluginId: string
  title: string
  color: string
  glyph: string
}

export type ShellView = 'home' | 'settings' | 'dev' | 'plugin'

/** 主题模式：浅色 / 深色 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system'

/** 背景类型：无 / 纯色 / 静态图 / 动效视频（mp4/webm，类 Wallpaper Engine） */
export type BackgroundType = 'none' | 'color' | 'image' | 'video'

export interface BackgroundConfig {
  type: BackgroundType
  /** color: hex；image/video: 本地绝对路径或 enest:// 资源 URL */
  value: string
  /** 0–1，视频/图片透明度 */
  opacity: number
  /** cover | contain */
  fit: 'cover' | 'contain'
}

/** 可由主题插件动态注册的主题包 */
export interface ThemePack {
  id: string
  name: string
  /** 来源插件 id，内置为 'enest.builtin' */
  source: string
  mode: ThemeMode
  tokens: Record<string, string>
  background?: BackgroundConfig
}

export interface ThemeTokens {
  mode: ThemeMode
  overrides: Partial<Record<'light' | 'dark', Record<string, string>>>
  /** 当前激活的自定义主题包 id；空则用 mode + overrides */
  packId?: string
  background?: BackgroundConfig
}

/** Tab 呈现方式：classic 顶栏条 / orb 左侧悬浮圆形轨道 */
export type TabStyle = 'classic' | 'orb'

/** 动画效果强度：low 几乎无动画 / medium 默认 / high 加强动效 */
export type AnimationLevel = 'low' | 'medium' | 'high'

/** 自定义字体元数据（二进制另存：Electron 写 ~/eNest/fonts/，mock 存 localStorage dataURL） */
export interface CustomFontMeta {
  id: string
  /** 显示名，通常取自文件名去掉扩展名 */
  name: string
  /** FontFace family 名（不含引号） */
  family: string
  /** 磁盘文件名（含扩展名）；mock 下与 id 对应的 localStorage 键后缀 */
  fileName: string
}

/** 代理类型：直连 / HTTP / SOCKS5 / 自定义 URL（scheme://[user:pass@]host:port） */
export type ProxyType = 'none' | 'http' | 'socks5' | 'custom'

/** 代理配置；type=none 或缺省表示直连 */
export interface ProxyConfig {
  type: ProxyType
  /** http/socks5 主机名或 IP */
  host?: string
  /** http/socks5 端口 */
  port?: number
  /** custom：完整代理 URL，如 socks5://127.0.0.1:1080 或 http://user:pass@host:8080 */
  url?: string
}

/** Quick 最近使用一条记录 */
export interface QuickRecentEntry {
  /** 命令 id，如 `app:<path>` / `plugin:<id>:<code>` / `action:<action>` */
  id: string
  /** 最近一次使用时间戳（ms） */
  ts: number
  /** 累计使用次数 */
  count: number
}

/** 全局呼出快捷启动小窗的设置 */
export interface QuickLauncherSettings {
  /** 是否启用全局热键；false 时不注册 */
  enabled: boolean
  /** 可选 accelerator 列表（设置页预设槽位展示用） */
  hotkeys: string[]
  /** 当前唯一生效的 accelerator；空/缺失时回退 hotkeys[0] */
  activeHotkey?: string
  /** 最近使用命令（按 ts 倒序，截断 20）；缺省 = 尚未记录 */
  recent?: QuickRecentEntry[]
}

/** 启动 Splash 背景类型：brand 品牌色 / none 主题色 / image 自定义图 */
export type SplashBackgroundType = 'brand' | 'none' | 'image'

/** 启动 Splash 背景配置 */
export interface SplashBackgroundConfig {
  type: SplashBackgroundType
  /** image：本地绝对路径或 enest:// 资源 URL */
  value?: string
  /** 0–1，自定义图透明度 */
  opacity?: number
}

/** 会话恢复：单条已打开插件 Tab 的轻量引用 */
export interface SessionTabRef {
  pluginId: string
  /** 显示名缓存；恢复时以已安装插件最新 name 为准 */
  title?: string
}

/** 允许的界面字号档（相对基准 14px 的倍率） */
export const FONT_SIZE_SCALES = [0.9, 1.0, 1.15, 1.3] as const
export type FontSizeScale = (typeof FONT_SIZE_SCALES)[number]

/** 设置 → 通用（保持轻量） */
export interface GeneralSettings {
  locale: 'zh-CN' | 'en-US'
  /** 关闭 GPU 加速；变更需重启生效 */
  hardwareAcceleration: boolean
  /** 数据根目录，默认 ~/eNest；可覆盖 */
  dataRoot?: string
  closeBehavior: 'minimize-tray' | 'quit'
  /** Tab 样式；变更即时生效 */
  tabStyle?: TabStyle
  /** 动画效果强度；变更即时生效 */
  animationLevel?: AnimationLevel
  /** 当前界面中文/默认字体 CSS font-family；空/缺省用 tokens.css 默认 --font 栈 */
  fontFamily?: string
  /** 英文/Latin 优先字体栈；有值时 --font = en + cjk 拼接。缺省行为与仅用 fontFamily 一致 */
  fontFamilyEn?: string
  /** 界面字号倍率（0.9 / 1.0 / 1.15 / 1.3）；缺省 1.0，写 --font-size-base */
  fontSizeScale?: number
  /** 已上传的自定义字体元数据列表 */
  customFonts?: CustomFontMeta[]
  /** 会话恢复：上次打开的插件 Tab 列表（仅插件，不含壳子页） */
  sessionTabs?: SessionTabRef[]
  /** 会话恢复：上次激活的插件 id；空/缺失则回首页 */
  sessionActivePluginId?: string
  /** 网络代理；缺省/none 为直连，变更经 session.setProxy 即时生效 */
  proxy?: ProxyConfig
  /** 快捷启动（Quick 小窗）配置 */
  quickLauncher?: QuickLauncherSettings
  /** 启动 Splash 背景；缺省 = brand 品牌色 */
  splashBackground?: SplashBackgroundConfig
}

export interface AppPaths {
  root: string
  plugins: string
  data: string
  themes: string
  settings: string
  database: string
}

// —— 插件生命周期（对标 uTools onPluginEnter / onPluginOut）——

/** openPlugin 可选进入载荷：code 对应 feature 指令，payload 为任意透传数据 */
export interface PluginEnterPayload {
  code?: string
  payload?: unknown
}

/** 关闭原因：用户关 Tab / 卸载插件 / 应用退出 */
export type PluginCloseReason = 'tab-close' | 'uninstall' | 'app-quit'

/**
 * 主进程 → 插件 webContents 的生命周期消息（通道 plugin:lifecycle）。
 * enter/out 成对出现以便插件 pause/resume；beforeClose 可 ack；destroy 为尽力而为。
 */
export type PluginLifecycleMessage =
  | { event: 'enter'; tabId: string; code?: string; payload?: unknown }
  | { event: 'out'; isKill: false }
  | { event: 'beforeClose'; reason: PluginCloseReason }
  | { event: 'destroy' }
