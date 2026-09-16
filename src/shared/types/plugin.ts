/** 插件权限白名单键 */
export type PluginPermission =
  | 'clipboard.read'
  | 'clipboard.write'
  | 'shell.openExternal'
  | 'storage.local'
  | 'notify'
  | 'ui.setTitle'
  | 'ui.setIcon'
  | 'ui.setBadge'
  | 'ui.resize'
  | 'ui.toast'
  | 'settings.register'

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

/** ui 缺省：chrome=default, themeAware=true, background=opaque, preferredColorScheme=auto */
export const DEFAULT_PLUGIN_UI: PluginUiConfig = {
  chrome: 'default',
  themeAware: true,
  background: 'opaque',
  preferredColorScheme: 'auto'
}

/** 将 manifest.ui（可缺省/可残缺）归一为完整 PluginUiConfig，非法值回退默认 */
export function resolvePluginUi(ui?: Partial<PluginUiConfig> | null): PluginUiConfig {
  return {
    chrome:
      ui?.chrome === 'minimal' || ui?.chrome === 'none' ? ui.chrome : DEFAULT_PLUGIN_UI.chrome,
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

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  logo?: string
  main: string
  preload?: string
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
  permissions: PluginPermission[]
  installed: boolean
  rootPath?: string
  devUrl?: string
  /** 已归一的 UI 配置（供壳子 chrome / 主题注入使用） */
  ui: PluginUiConfig
  /** 已归一的打开形态；缺省 panel */
  form?: PluginForm
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

/** 全局呼出快捷启动小窗的设置 */
export interface QuickLauncherSettings {
  /** 是否启用全局热键；false 时不注册 */
  enabled: boolean
  /** Electron accelerator 列表，任一触发 toggle；失败项会被跳过 */
  hotkeys: string[]
}

/** 设置 → 通用（保持轻量） */
export interface GeneralSettings {
  locale: 'zh-CN' | 'en-US'
  /** 关闭 GPU 加速；变更需重启生效 */
  hardwareAcceleration: boolean
  /** 数据根目录，默认 ~/eNest；可覆盖 */
  dataRoot?: string
  closeBehavior: 'minimize-tray' | 'quit'
  /** 快捷启动（Quick 小窗）配置 */
  quickLauncher?: QuickLauncherSettings
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
