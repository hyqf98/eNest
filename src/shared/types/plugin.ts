/** 宿主能力标识；基础能力直接可用，敏感能力需在 manifest 声明并取得用户授权。 */
export type PluginPermission =
  | 'clipboard.read'
  | 'clipboard.write'
  | 'clipboard.readImage'
  | 'clipboard.writeImage'
  | 'clipboard.history'
  | 'clipboard.paste'
  | 'timer.background'
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
  | 'mw.connect'
  | 'mw.query'
  | 'mw.admin'
  | 'dsh.connect'
  | 'dsh.chat'
  | 'dsh.admin'
  | 'net.socket'
  | 'lan.share'
  | 'fs.rename'
  | 'fs.read'
  | 'fs.write'
  | 'sys.control'
  | 'ssh.agent'
  | 'config.agent.read'
  | 'config.agent.write'
  | 'sys.inspect'
  | 'theme'

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
  'clipboard.paste',
  'timer.background',
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
  'db.schema',
  'mw.connect',
  'mw.query',
  'mw.admin',
  'dsh.connect',
  'dsh.chat',
  'dsh.admin',
  'net.socket',
  'lan.share',
  'fs.rename',
  'fs.read',
  'fs.write',
  'sys.control',
  'ssh.agent',
  'config.agent.read',
  'config.agent.write',
  'sys.inspect',
  'theme'
]

/**
 * 敏感权限授权三态（壳层用户决策，持久化于 SettingsStore.plugins 段）：
 * - allow：静默放行
 * - ask：调用时由主进程原生对话框确认（敏感权限缺省值）
 * - deny：静默拒绝；基础能力不受此授权表控制
 */
export type PluginPermissionGrant = 'allow' | 'ask' | 'deny'

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
  type: 'text' | 'image' | 'files'
  files?: import('./plugin-tools').ClipboardFile[]
  sourceApp?: import('./plugin-tools').ClipboardSourceApp
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

/** 声明式内容处理指令；字符串指令继续保持兼容。 */
export type PluginFeatureCommand = string
  | { type: 'regex'; label: string; match?: string; regex?: string; minLength?: number }
  | { type: 'over'; label: string; exclude?: string; minLength?: number; maxLength?: number }

export interface PluginFeature {
  code: string
  explain?: string
  cmds: PluginFeatureCommand[]
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
 * 插件布局模式，与宿主窗口位置分离：
 * - quick：Quick 小窗内嵌，渲染在输入框下方（小窗适配样式）
 * - shell：主窗大窗 Tab（桌面适配样式）
 * 不再有「大小插件」类型区分：同一插件两种入口样式并存，
 * 壳子启动时经 URL ?mode= / onEnter 载荷 / getLaunchMode() 传给插件，插件自选渲染样式。
 * 拖出独立窗口保留原模式；收回 Quick / 主窗时才切换为接收位置的模式。
 */
export type PluginLaunchMode = 'quick' | 'shell'

/**
 * 每插件「快捷启动」用户配置（settings.pluginLaunch[pluginId]）：
 * Quick 搜索启动方式覆盖项与自定义触发词。
 */
export interface PluginLaunchConfig {
  /**
   * 启动方式覆盖：quick 小窗启动 / shell 大窗启动；
   * 缺省 = 跟随入口（Quick 打开进小窗，主窗打开进大窗）。插件快捷键使用各自的 mode。
   */
  mode?: PluginLaunchMode
  /** @deprecated 只读取旧数据迁移；新绑定保存在 pluginShortcuts。 */
  hotkey?: string
  /** 自定义触发词：并入 Quick 搜索索引，与 manifest features[].cmds 等权 */
  aliases?: string[]
}

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
   * 控件类型（10 种）：text / string / switch / boolean / bool / select /
   * number / slider / color / page。
   * - string/bool 为 text/switch 的别名（对齐插件侧声明习惯）；
   * - slider 需 min/max/step；color 渲染颜色输入；page 打开插件内独立设置页。
   * - 非法类型渲染层回退 text。
   */
  type: string
  label: string
  /** type=page：打开本插件并发送入口事件；缺省 code=settings。 */
  entry?: { code: string; payload?: unknown }
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
  description: string
  author?: string
  /** Standard runtime-relative icon path: assets/market/icon.svg. */
  icon: 'assets/market/icon.svg'
  /** 市场分类；与插件仓库 registry.json 的 category 一致 */
  category?: string
  /** 插件主页，市场详情展示 */
  homepage?: string
  /** 插件仓库生成市场索引时使用的展示元数据 */
  market: {
    featured?: boolean
    tags?: string[]
    /** 有序截图，最多 8 张；包内 assets/market/screenshots 相对路径，首张为首页封面 */
    screenshots: string[]
    /** Runtime-relative Markdown document in the packaged static assets. */
    readme: 'assets/market/README.md'
  }
  main: 'index.html'
  engines?: { enest?: string }
  /**
   * 网络能力声明（可选）：
   * - allowInsecure: true 时 net.fetch 允许明文 http:// URL（含重定向逐跳）；
   *   缺省 false 仅 https。PluginInstaller 安装时校验形状，运行时按 manifest 读取。
   */
  net?: { allowInsecure?: boolean }
  permissions?: PluginPermission[]
  /** 兼容旧插件的内容尺寸建议（CSS px）；Quick 使用固定视口，仅随屏幕工作区缩小，主窗由用户控制。 */
  window?: { width?: number; height?: number; minWidth?: number; minHeight?: number }
  features?: PluginFeature[]
  development?: { main?: string }
  /** UI 集成配置；缺省等价 DEFAULT_PLUGIN_UI */
  ui?: Partial<PluginUiConfig>
  /** 贡献点声明（插槽化架构）：settings/homeCards/railEntries/themePacks */
  contributes?: PluginContributes
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
  /** 图标 URL：已安装插件为 enest://plugin/{id}/{icon}，远程市场为 registry 条目的 icon URL；缺省回退 glyph 色块 */
  icon?: string
  /** 已解析的有序截图 URL；首张为首页封面，旧插件缺省无截图 */
  screenshots?: string[]
  /** Version-matched Markdown resource URL. */
  readmeUrl?: string
  /** Same-version packaged Markdown image attachment map, keyed by relative path. */
  readmeImages?: Record<string, string>
  /** 插件市场推荐标记 */
  featured?: boolean
  permissions: PluginPermission[]
  installed: boolean
  /** 是否启用；缺省/undefined 视为 true。禁用时 openPlugin 拒绝，Quick 索引排除 */
  enabled?: boolean
  /** 远程市场存在更高版本时的版本号（已安装插件才有） */
  latestVersion?: string
  rootPath?: string
  devUrl?: string
  /** Source preview maps assets/* to public/assets/*; false previews built output. */
  devSource?: boolean
  /** Original source folder, also retained when previewing its dist directory. */
  sourcePath?: string
  /** 开发态插件（开发者控制台加载，未复制到 userData） */
  dev?: boolean
  /** 已归一的 UI 配置（供壳子 chrome / 主题注入使用） */
  ui: PluginUiConfig
  /**
   * manifest 贡献点声明透传（已安装插件才有；渲染层消费 homeCards 等，
   * 声明式注册不依赖插件运行）。
   */
  contributes?: PluginContributes
}

/** Developer registration. An empty URL explicitly selects static source preview. */
export interface DevPluginLoadOptions {
  url?: string
  preview?: 'source' | 'dist'
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
  /** Package icon URL; null explicitly selects the runtime glyph override. */
  icon?: string | null
  /** Runtime badge text, empty when cleared. */
  badge?: string
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

/** 宿主提供的背景动效与启动 Logo 编排。插件不能注入脚本或 shader。 */
export type BackgroundEffectPreset = 'fold' | 'aurora' | 'orbit' | 'ripple' | 'tunnel'

export interface BackgroundEffectBase {
  /** 主题包内唯一的安全短 ID（字母开头，最多 48 字符）。 */
  id: string
  name: string
  description?: string
  /** 启动 Logo 的编排；未指定时由宿主按背景选择。 */
  logoStyle?: BackgroundEffectPreset
}

export type BackgroundEffectDefinition = BackgroundEffectBase & (
  | {
    renderer: 'preset'
    preset: BackgroundEffectPreset
    /** 三个六位 hex 颜色：背景主色、次色、高光色。 */
    colors?: [string, string, string]
    /** 速度倍率，0.25–2；缺省为 1。 */
    speed?: number
  }
  | {
    renderer: 'video'
    /** 仅允许本插件 enest://plugin/<id>/assets/... 的 mp4/webm。 */
    video: string
    /** 本插件的 png/jpeg/webp/avif/gif 静态封面。 */
    poster?: string
  }
)

/** 可由主题插件动态注册的主题包 */
export interface ThemePack {
  id: string
  name: string
  /** 来源插件 id，内置为 'enest.builtin' */
  source: string
  mode: ThemeMode
  tokens: Record<string, string>
  background?: BackgroundConfig
  /** 最多 8 个声明式动效；随主题包来源注册、禁用和卸载。 */
  backgroundEffects?: BackgroundEffectDefinition[]
}

export interface ThemeTokens {
  mode: ThemeMode
  overrides: Partial<Record<'light' | 'dark', Record<string, string>>>
  /** 当前激活的自定义主题包 id；空则用 mode + overrides */
  packId?: string
  background?: BackgroundConfig
  /** user 为用户自选；pack 从当前主题包派生。旧版未标记值保留，不能推定来源。 */
  backgroundSource?: 'user' | 'pack'
  /** 全局背景动效选择；内置默认 tunnel，none 关闭，插件项使用宿主生成的命名空间 ID。 */
  backgroundEffect?: string
}

/** Tab 呈现方式：classic 顶栏条 / orb 左侧悬浮圆形轨道 */
export type TabStyle = 'classic' | 'orb'

/** 动画效果强度：low 几乎无动画 / medium 默认 / high 加强动效 */
export type AnimationLevel = 'low' | 'medium' | 'high'

/** 自定义字体元数据（二进制另存：Electron 写 ~/.eNest/fonts/，mock 存 localStorage dataURL） */
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
  /** 每个标准化搜索词上次选择的命令；有界保存最近 100 项。 */
  queryPreferences?: Array<{ query: string; id: string }>
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

/** Native window history uses screen DIP, with normal bounds even when maximized. */
export interface PluginWindowGeometry {
  bounds: { x: number; y: number; width: number; height: number }
  maximized?: boolean
  minimized?: boolean
  alwaysOnTop?: boolean
}

export interface DetachedWindowSession extends PluginWindowGeometry {
  mode: PluginLaunchMode
}

/** 会话恢复：单条已打开插件的轻量引用；缺省仍为主窗口 Tab。 */
export interface SessionTabRef {
  pluginId: string
  /** 显示名缓存；恢复时以已安装插件最新 name 为准 */
  title?: string
  detached?: DetachedWindowSession
}

/** 允许的界面字号档（相对基准 14px 的倍率） */
export const FONT_SIZE_SCALES = [0.9, 1.0, 1.15, 1.3] as const
export type FontSizeScale = (typeof FONT_SIZE_SCALES)[number]

/** 设置 → 通用（保持轻量） */
export interface GeneralSettings {
  locale: 'zh-CN' | 'en-US'
  /** 关闭 GPU 加速；变更需重启生效 */
  hardwareAcceleration: boolean
  /** 数据根目录，默认 ~/.eNest；可覆盖 */
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
  /** 会话恢复：未关闭的主窗 Tab / 独立窗插件（不含壳子页和临时 Quick）。 */
  sessionTabs?: SessionTabRef[]
  /** 上次激活的插件 id，仅记录历史，不在启动时加载插件。 */
  sessionActivePluginId?: string
  /** 主窗口的普通位置、尺寸与最大化 / 最小化状态。 */
  mainWindowState?: PluginWindowGeometry
  /** 网络代理；缺省/none 为直连，变更经 session.setProxy 即时生效 */
  proxy?: ProxyConfig
  /** 快捷启动（Quick 小窗）配置 */
  quickLauncher?: QuickLauncherSettings
  /** 启动 Splash 背景；缺省 = brand 品牌色 */
  splashBackground?: SplashBackgroundConfig
}

/** GitHub 账号个人资料（设置 profile 段 user 字段；access token 单独加密存储，不落设置） */
export interface UserProfile {
  /** GitHub 用户名（@login） */
  login: string
  /** 显示名（可为空） */
  name: string | null
  /** GitHub 上的原始头像 URL（仅记录来源） */
  avatarUrl: string | null
  /** 主进程预取并缓存的头像 data URL（≤256KB），轨道/设置页离线直渲染 */
  avatarDataUrl: string | null
  /** 主页 https://github.com/{login} */
  htmlUrl: string | null
  /** 本次授权完成时间（ms） */
  connectedAt: number
}

/** 设置 → 个人资料段（已连接账号与兼容字段） */
export interface ProfileSettings {
  /** @deprecated 历史配置字段，仅保留数据兼容。登录使用发布方构建配置。 */
  githubClientId?: string
  /** 已连接的账号信息；未登录为空 */
  user?: UserProfile
}

export interface AppPaths {
  root: string
  plugins: string
  data: string
  themes: string
  settings: string
  database: string
}

/** 每插件快捷启动配置表（SettingsData.pluginLaunch；键 = pluginId） */
export type PluginLaunchSettings = Record<string, PluginLaunchConfig>

/**
 * setPluginLaunch 增量写入载荷：
 * mode 传 null = 清除搜索启动方式（回到「跟随入口」）；旧 hotkey 字段拒绝写入；
 * aliases 传空数组 = 清除触发词。
 */
export type PluginLaunchPatch = Omit<Partial<PluginLaunchConfig>, 'mode'> & {
  mode?: PluginLaunchMode | null
}

// —— 插件生命周期（对标 uTools onPluginEnter / onPluginOut）——

/** openPlugin 可选进入载荷：code 对应 feature 指令，payload 为任意透传数据 */
export interface PluginEnterPayload {
  code?: string
  type?: 'text' | 'regex' | 'over'
  payload?: unknown
}

/** 关闭原因：用户关 Tab / 卸载插件 / 应用退出 */
export type PluginCloseReason = 'tab-close' | 'uninstall' | 'app-quit'

/**
 * 主进程 → 插件 webContents 的生命周期消息（通道 plugin:lifecycle）。
 * enter/out 成对出现以便插件 pause/resume；beforeClose 可 ack；destroy 为尽力而为。
 */
export type PluginLifecycleMessage =
  | ({ event: 'enter'; tabId: string; mode: PluginLaunchMode } & PluginEnterPayload)
  | { event: 'out'; isKill: false }
  | { event: 'beforeClose'; reason: PluginCloseReason; operationId: string }
  | { event: 'beforeSuspend'; operationId: string }
  | { event: 'destroy' }
