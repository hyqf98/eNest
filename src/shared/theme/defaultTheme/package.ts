import type { ThemePackV2 } from '@shared/types/appearance'
import type { PluginContributes, PluginManifest } from '@shared/types/plugin'
import { THEME_TOKEN_PRESETS } from '@shared/theme/presets'
import { DEFAULT_BACKGROUND_PALETTES } from '@shared/theme/defaultTheme/backgroundPalettes'

export const DEFAULT_THEME_IDENTITY = Object.freeze({ source: 'enest.builtin', id: 'default' } as const)
export const DEFAULT_BODY_FONT = '"Inter", "SF Pro Display", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
export const DEFAULT_MONO_FONT = '"JetBrains Mono", "SF Mono", ui-monospace, monospace'

const fonts = {
  body: DEFAULT_BODY_FONT, heading: DEFAULT_BODY_FONT, mono: DEFAULT_MONO_FONT,
  latin: '"Inter", "SF Pro Display", system-ui, sans-serif',
  cjk: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  scale: 1,
}
const components = { controlRadius: 10, cardRadius: 18, panelRadius: 24, borderWidth: 1 }
const background = {
  media: null, effect: 'tunnel', texture: 'none', intensity: 1, speed: 1, direction: 0,
  warmth: 0.5, grain: 0.12, scale: 1, wash: 0.35,
  kind: 'none' as const, palette: 'theme' as const, color: '#bd542b', opacity: 0.85, fit: 'cover' as const,
}
const layout = { variant: 'default', tabStyle: 'classic' as const, density: 1, gap: 16, sidebarWidth: 280, contentWidth: 1520, columns: 3 }
const notifications = { layout: 'card' as const, accent: 'stripe' as const, radius: 16, borderWidth: 1, density: 1, shadow: 'soft' as const }
const splash = { type: 'brand' as const, media: null, opacity: 0.55 }
const tokenLabels = {
  '--bg': '页面背景色', '--surface': '卡片颜色', '--surface-2': '次级表面', '--surface-3': '浮层表面',
  '--text': '文字颜色', '--text-2': '次要文字', '--text-3': '弱化文字', '--accent': '主按钮 / 强调色',
  '--ok': '成功色', '--danger': '危险色', '--border': '边框', '--border-strong': '强边框', '--link': '链接颜色',
} as const

function defaultTokens(mode: 'light' | 'dark'): Record<string, string> {
  const tokens = { ...THEME_TOKEN_PRESETS[mode] }
  // Link color follows accent until a theme/profile explicitly overrides it.
  delete tokens['--link']
  return tokens
}

const pack: ThemePackV2 = {
  id: 'default', name: 'eNest 默认主题', source: DEFAULT_THEME_IDENTITY.source, mode: 'system', version: 3,
  description: '原始 eNest 布局、中性灰表面与铜橙强调色，完整保留背景、字体和启动外观设置。',
  schemaVersion: 2, tokens: {},
  variants: {
    light: { tokens: defaultTokens('light'), fonts: { ...fonts }, components: { ...components }, background: { ...background }, layout: { ...layout }, notifications: { ...notifications }, splash: { ...splash }, animation: 'medium' },
    dark: { tokens: defaultTokens('dark'), fonts: { ...fonts }, components: { ...components }, background: { ...background }, layout: { ...layout }, notifications: { ...notifications }, splash: { ...splash }, animation: 'medium' },
  },
  settings: {
    version: 4,
    groups: [
      {
        id: 'colors', title: '色彩微调', description: '当前浅色或深色模式独立保存；透明边框保留 Alpha。',
        fields: Object.entries(tokenLabels).map(([token, label]) => ({
          key: `color${token.slice(2).split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('')}`,
          label, type: 'token' as const, default: THEME_TOKEN_PRESETS.light[token],
          binding: { target: 'token' as const, key: token as keyof typeof tokenLabels },
        })),
      },
      {
        id: 'background', title: '背景与启动画面', description: '氛围色与媒体背景共用一处；启动画面在共享背景动效关闭后独立生效。', fields: [
          { key: 'backgroundType', label: '背景类型', type: 'select', default: 'none', options: [{ label: '无', value: 'none' }, { label: '渐变氛围', value: 'gradient' }, { label: '纯色', value: 'color' }, { label: '图片', value: 'image' }, { label: '视频', value: 'video' }], binding: { target: 'background', key: 'kind' } },
          { key: 'backgroundPalette', label: '氛围配色', type: 'select', default: 'theme', options: DEFAULT_BACKGROUND_PALETTES.map(palette => ({ label: palette.name, value: palette.id })), binding: { target: 'background', key: 'palette' }, visibleWhen: { field: 'backgroundType', equals: 'gradient' } },
          { key: 'backgroundColor', label: '自定义纯色', type: 'color', default: '#bd542b', binding: { target: 'background', key: 'color' }, visibleWhen: { field: 'backgroundType', equals: 'color' } },
          { key: 'media', label: '背景图片或视频', type: 'media', default: null, binding: { target: 'background', key: 'media' } },
          { key: 'backgroundOpacity', label: '氛围 / 媒体不透明度', type: 'slider', default: 0.85, min: 0, max: 1, step: 0.01, binding: { target: 'background', key: 'opacity' } },
          { key: 'backgroundFit', label: '媒体填充方式', type: 'select', default: 'cover', help: '仅控制图片和视频，不改变氛围配色与背景动效。', options: [{ label: '填满', value: 'cover' }, { label: '完整显示', value: 'contain' }], binding: { target: 'background', key: 'fit' } },
          { key: 'backgroundEffect', label: '背景动效', type: 'select', default: 'tunnel', options: [{ label: '关闭', value: 'none' }, { label: '空间折叠', value: 'fold' }, { label: '极光绸缎', value: 'aurora' }, { label: '引力光环', value: 'orbit' }, { label: '液态波纹', value: 'ripple' }, { label: '光域隧道', value: 'tunnel' }], binding: { target: 'background', key: 'effect' } },
          { key: 'splashType', label: '启动画面', type: 'select', default: 'brand', options: [
            { label: '品牌色', value: 'brand', description: '墨绿底色配浅鼠尾草色标志，与当前主题配色无关，深色界面下也不会变成深底。' },
            { label: '主题色', value: 'none', description: '跟随当前主题的页面背景与强调色，切换深浅模式或修改配色后一起变化。' },
            { label: '自定义图片', value: 'image', description: '使用本地图片铺满启动画面，可单独调整图片透明度。' },
          ], binding: { target: 'splash', key: 'type' } },
          { key: 'splashMedia', label: '启动背景图片', type: 'media', default: null, binding: { target: 'splash', key: 'media' }, visibleWhen: { field: 'splashType', equals: 'image' } },
          { key: 'splashOpacity', label: '启动图片不透明度', type: 'slider', default: 0.55, min: 0, max: 1, step: 0.05, binding: { target: 'splash', key: 'opacity' }, visibleWhen: { field: 'splashType', equals: 'image' } },
        ],
      },
      {
        id: 'typography', title: '字体与字号', fields: [
          { key: 'fontFamilyEn', label: '英文字体', type: 'font', default: '', binding: { target: 'font', key: 'latin' }, options: [
            { label: '默认', value: '' },
            { label: 'Inter / SF', value: '"Inter", "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
            { label: 'Georgia 衬线', value: 'Georgia, "Times New Roman", serif' },
            { label: 'JetBrains Mono', value: '"JetBrains Mono", "SF Mono", "Cascadia Code", ui-monospace, monospace' },
          ] },
          { key: 'fontFamily', label: '中文字体', type: 'font', default: '', binding: { target: 'font', key: 'cjk' }, options: [
            { label: '默认', value: '' },
            { label: '系统默认', value: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif' },
            { label: '思源黑体 SC', value: '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif' },
            { label: '霞鹜文楷', value: '"LXGW WenKai", "LXGW WenKai Screen", "Kaiti SC", "STKaiti", serif' },
            { label: '更纱黑体', value: '"Sarasa Gothic SC", "Sarasa UI SC", "PingFang SC", sans-serif' },
          ] },
          { key: 'monoFont', label: '代码与数字', type: 'font', default: DEFAULT_MONO_FONT, binding: { target: 'font', key: 'mono' } },
          { key: 'fontScale', label: '字号比例', type: 'slider', default: 1, min: 0.9, max: 1.3, step: 0.05, help: '整体缩放全壳字号，90%–130%', binding: { target: 'font', key: 'scale' } },
        ],
      },
      {
        id: 'layout', title: '布局与动画', fields: [
          { key: 'tabStyle', label: '标签页样式', type: 'select', default: 'classic', options: [{ label: '顶部标签', value: 'classic' }, { label: '左侧圆轨', value: 'orb' }], binding: { target: 'layout', key: 'tabStyle' } },
          { key: 'tabAutoHide', label: '标题栏自动隐藏', type: 'switch', default: false, help: '指针离开后整条标题栏收起，移到窗口顶部即展开', binding: { target: 'layout', key: 'tabAutoHide' }, visibleWhen: { field: 'tabStyle', equals: 'classic' } },
          { key: 'tabOpacity', label: '标题栏背景不透明度', type: 'slider', default: 1, min: 0, max: 1, step: 0.05, binding: { target: 'layout', key: 'tabOpacity' }, visibleWhen: { field: 'tabStyle', equals: 'classic' } },
          { key: 'contentWidth', label: '内容宽度', type: 'slider', default: 1520, min: 640, max: 1920, step: 10, binding: { target: 'layout', key: 'contentWidth' } },
          { key: 'density', label: '内容密度', type: 'slider', default: 1, min: 0.8, max: 1.2, step: 0.01, binding: { target: 'layout', key: 'density' } },
          { key: 'gap', label: '内容间距', type: 'slider', default: 16, min: 0, max: 32, step: 1, binding: { target: 'layout', key: 'gap' } },
          { key: 'columns', label: '目录列数', type: 'slider', default: 3, min: 1, max: 6, step: 1, binding: { target: 'layout', key: 'columns' } },
          { key: 'motion', label: '动画强度', type: 'select', default: 'medium', help: '低档停用过渡与轮播动效，高档启用全部动画', options: [{ label: '低', value: 'low' }, { label: '中', value: 'medium' }, { label: '高', value: 'high' }], binding: { target: 'animation', key: 'level' } },
        ],
      },
      {
        id: 'surfaces', title: '圆角、边框与通知', description: '控件、卡片、面板共用同一套圆角与描边；通知沿用同一外观语言。', fields: [
          { key: 'radius', label: '控件圆角', type: 'slider', default: 10, min: 0, max: 24, step: 1, binding: { target: 'component', key: 'controlRadius' } },
          { key: 'cardRadius', label: '卡片圆角', type: 'slider', default: 18, min: 0, max: 32, step: 1, binding: { target: 'component', key: 'cardRadius' } },
          { key: 'panelRadius', label: '面板圆角', type: 'slider', default: 24, min: 0, max: 40, step: 1, binding: { target: 'component', key: 'panelRadius' } },
          { key: 'borderWidth', label: '边框宽度', type: 'slider', default: 1, min: 0, max: 6, step: 0.1, binding: { target: 'component', key: 'borderWidth' } },
          { key: 'notificationLayout', label: '通知布局', type: 'select', default: 'card', options: [{ label: '标准卡片', value: 'card' }, { label: '紧凑', value: 'compact' }, { label: '横幅', value: 'banner' }], binding: { target: 'notification', key: 'layout' } },
          { key: 'notificationAccent', label: '通知强调', type: 'select', default: 'stripe', options: [{ label: '侧边色条', value: 'stripe' }, { label: '级别图标', value: 'icon' }, { label: '无', value: 'none' }], binding: { target: 'notification', key: 'accent' } },
          { key: 'notificationShadow', label: '通知阴影', type: 'select', default: 'soft', options: [{ label: '无', value: 'none' }, { label: '轻阴影', value: 'soft' }, { label: '浮起', value: 'raised' }], binding: { target: 'notification', key: 'shadow' } },
          { key: 'notificationRadius', label: '通知圆角', type: 'slider', default: 16, min: 0, max: 24, step: 1, binding: { target: 'notification', key: 'radius' } },
          { key: 'notificationBorderWidth', label: '通知边框', type: 'slider', default: 1, min: 0, max: 6, step: 0.1, binding: { target: 'notification', key: 'borderWidth' } },
          { key: 'notificationDensity', label: '通知密度', type: 'slider', default: 1, min: 0.8, max: 1.2, step: 0.01, binding: { target: 'notification', key: 'density' } },
        ],
      },
    ],
  },
  home: { source: DEFAULT_THEME_IDENTITY.source, id: 'home', variant: 'default' },
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

/** Compiled host package; never installed or loaded from the plugin repository. */
export const DEFAULT_THEME_PACKAGE = deepFreeze({
  id: DEFAULT_THEME_IDENTITY.source,
  name: 'eNest 默认主题',
  version: '3.0.0',
  contributes: {
    themePacks: [pack],
    homePages: [{ source: DEFAULT_THEME_IDENTITY.source, id: 'home', version: 1, entry: 'home.html', variants: ['default'] }],
  },
} satisfies Pick<PluginManifest, 'id' | 'name' | 'version'> & {
  contributes: Required<Pick<PluginContributes, 'themePacks' | 'homePages'>>
})
