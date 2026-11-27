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
  media: null, effect: 'orbit', texture: 'none', intensity: 1, speed: 1, direction: 0,
  warmth: 0.5, grain: 0.12, scale: 1, wash: 0.35,
  kind: 'none' as const, palette: 'theme' as const, color: '#bd542b', opacity: 0.85, fit: 'cover' as const,
}
const layout = { variant: 'default', tabStyle: 'classic' as const, density: 1, gap: 16, sidebarWidth: 280, contentWidth: 1520, columns: 3 }
const notifications = { layout: 'card' as const, accent: 'stripe' as const, radius: 16, borderWidth: 1, density: 1, shadow: 'soft' as const }
const splash = { type: 'brand' as const, media: null, opacity: 0.55 }
const tokenLabels = {
  '--bg': ['页面背景色', 'Page background'], '--surface': ['卡片颜色', 'Card color'], '--surface-2': ['次级表面', 'Secondary surface'], '--surface-3': ['浮层表面', 'Overlay surface'],
  '--text': ['文字颜色', 'Text color'], '--text-2': ['次要文字', 'Secondary text'], '--text-3': ['弱化文字', 'Muted text'], '--accent': ['主按钮 / 强调色', 'Primary / accent'],
  '--ok': ['成功色', 'Success'], '--danger': ['危险色', 'Danger'], '--border': ['边框', 'Border'], '--border-strong': ['强边框', 'Strong border'], '--link': ['链接颜色', 'Link color'],
} as const satisfies Record<string, readonly [string, string]>

function defaultTokens(mode: 'light' | 'dark'): Record<string, string> {
  const tokens = { ...THEME_TOKEN_PRESETS[mode] }
  // Link color follows accent until a theme/profile explicitly overrides it.
  delete tokens['--link']
  return tokens
}

const pack: ThemePackV2 = {
  id: 'default', name: 'eNest 默认主题', nameEn: 'eNest Default', source: DEFAULT_THEME_IDENTITY.source, mode: 'system', version: 3,
  description: '原始 eNest 布局、中性灰表面与铜橙强调色，完整保留背景、字体和启动外观设置。',
  descriptionEn: 'The original eNest layout with neutral grey surfaces and a copper accent; background, font and launch appearance settings are all preserved.',
  schemaVersion: 2, tokens: {},
  quick: { version: 1, entry: 'index.html' },
  settingsPage: { version: 1, entry: 'index.html' },
  variants: {
    light: { tokens: defaultTokens('light'), fonts: { ...fonts }, components: { ...components }, background: { ...background }, layout: { ...layout }, notifications: { ...notifications }, splash: { ...splash }, animation: 'medium' },
    dark: { tokens: defaultTokens('dark'), fonts: { ...fonts }, components: { ...components }, background: { ...background }, layout: { ...layout }, notifications: { ...notifications }, splash: { ...splash }, animation: 'medium' },
  },
  settings: {
    version: 4,
    groups: [
      {
        id: 'colors', title: '色彩微调', titleEn: 'Color tuning',
        description: '当前浅色或深色模式独立保存；透明边框保留 Alpha。',
        descriptionEn: 'Saved separately for the current light or dark mode; transparent borders keep their alpha.',
        fields: Object.entries(tokenLabels).map(([token, [label, labelEn]]) => ({
          key: `color${token.slice(2).split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('')}`,
          label, labelEn, type: 'token' as const, default: THEME_TOKEN_PRESETS.light[token],
          binding: { target: 'token' as const, key: token as keyof typeof tokenLabels },
        })),
      },
      {
        id: 'background', title: '背景与启动画面', titleEn: 'Background and splash',
        description: '氛围色与媒体背景共用一处；启动画面在共享背景动效关闭后独立生效。',
        descriptionEn: 'Atmosphere colors and media backgrounds share one place; the splash takes effect on its own once the shared background effect is off.',
        fields: [
          { key: 'backgroundType', label: '背景类型', labelEn: 'Background type', type: 'select', default: 'none', options: [{ label: '无', labelEn: 'None', value: 'none' }, { label: '渐变氛围', labelEn: 'Gradient', value: 'gradient' }, { label: '纯色', labelEn: 'Solid color', value: 'color' }, { label: '图片', labelEn: 'Image', value: 'image' }, { label: '视频', labelEn: 'Video', value: 'video' }], binding: { target: 'background', key: 'kind' } },
          { key: 'backgroundPalette', label: '氛围配色', labelEn: 'Atmosphere palette', type: 'select', default: 'theme', options: DEFAULT_BACKGROUND_PALETTES.map(palette => ({ label: palette.name, labelEn: palette.nameEn, value: palette.id })), binding: { target: 'background', key: 'palette' }, visibleWhen: { field: 'backgroundType', equals: 'gradient' } },
          { key: 'backgroundColor', label: '自定义纯色', labelEn: 'Custom solid color', type: 'color', default: '#bd542b', binding: { target: 'background', key: 'color' }, visibleWhen: { field: 'backgroundType', equals: 'color' } },
          // 图片/视频与背景动效互斥：动效开启时媒体层画不出来，媒体生效时动效被跳过。
          // 两边都只禁用不清空，用户切回另一侧时原配置还在。
          { key: 'media', label: '背景图片或视频', labelEn: 'Background image or video', type: 'media', default: null, binding: { target: 'background', key: 'media' }, disabledWhen: { field: 'backgroundEffect', equals: 'none', not: true } },
          { key: 'backgroundOpacity', label: '氛围 / 媒体不透明度', labelEn: 'Atmosphere / media opacity', type: 'slider', default: 0.85, min: 0, max: 1, step: 0.01, binding: { target: 'background', key: 'opacity' } },
          { key: 'backgroundFit', label: '媒体填充方式', labelEn: 'Media fit', type: 'select', default: 'cover', help: '仅控制图片和视频，不改变氛围配色与背景动效。', helpEn: 'Only affects images and videos; it does not change the atmosphere palette or background effect.', options: [{ label: '填满', labelEn: 'Fill', value: 'cover' }, { label: '完整显示', labelEn: 'Fit whole', value: 'contain' }], binding: { target: 'background', key: 'fit' } },
          { key: 'backgroundEffect', label: '背景动效', labelEn: 'Background effect', type: 'select', default: 'orbit', options: [{ label: '关闭', labelEn: 'Off', value: 'none' }, { label: '空间折叠', labelEn: 'Spatial fold', value: 'fold' }, { label: '极光绸缎', labelEn: 'Aurora silk', value: 'aurora' }, { label: '引力光环', labelEn: 'Gravity orbit', value: 'orbit' }, { label: '液态波纹', labelEn: 'Liquid ripple', value: 'ripple' }], binding: { target: 'background', key: 'effect' }, disabledWhen: [{ field: 'backgroundType', equals: 'image' }, { field: 'backgroundType', equals: 'video' }] },
          { key: 'splashType', label: '启动画面', labelEn: 'Splash screen', type: 'select', default: 'brand', options: [
            { label: '品牌色', labelEn: 'Brand color', value: 'brand', description: '墨绿底色配浅鼠尾草色标志，与当前主题配色无关，深色界面下也不会变成深底。', descriptionEn: 'Deep green ground with a pale sage mark. It is independent of the current theme palette and never turns into a dark ground in dark mode.' },
            { label: '主题色', labelEn: 'Theme color', value: 'none', description: '跟随当前主题的页面背景与强调色，切换深浅模式或修改配色后一起变化。', descriptionEn: 'Follows the current theme page background and accent, updating together when you switch light/dark or change colors.' },
            { label: '自定义图片', labelEn: 'Custom image', value: 'image', description: '使用本地图片铺满启动画面，可单独调整图片透明度。', descriptionEn: 'Fills the splash with a local image; the image opacity can be adjusted separately.' },
          ], binding: { target: 'splash', key: 'type' } },
          { key: 'splashMedia', label: '启动背景图片', labelEn: 'Splash background image', type: 'media', default: null, binding: { target: 'splash', key: 'media' }, visibleWhen: { field: 'splashType', equals: 'image' } },
          { key: 'splashOpacity', label: '启动图片不透明度', labelEn: 'Splash image opacity', type: 'slider', default: 0.55, min: 0, max: 1, step: 0.05, binding: { target: 'splash', key: 'opacity' }, visibleWhen: { field: 'splashType', equals: 'image' } },
        ],
      },
      {
        id: 'typography', title: '字体与字号', titleEn: 'Fonts and sizing', fields: [
          { key: 'fontFamilyEn', label: '英文字体', labelEn: 'Latin font', type: 'font', default: '', binding: { target: 'font', key: 'latin' }, options: [
            { label: '默认', labelEn: 'Default', value: '' },
            { label: 'Inter / SF', value: '"Inter", "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
            { label: 'Georgia 衬线', labelEn: 'Georgia serif', value: 'Georgia, "Times New Roman", serif' },
            { label: 'JetBrains Mono', value: '"JetBrains Mono", "SF Mono", "Cascadia Code", ui-monospace, monospace' },
          ] },
          { key: 'fontFamily', label: '中文字体', labelEn: 'CJK font', type: 'font', default: '', binding: { target: 'font', key: 'cjk' }, options: [
            { label: '默认', labelEn: 'Default', value: '' },
            { label: '系统默认', labelEn: 'System default', value: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif' },
            { label: '思源黑体 SC', labelEn: 'Source Han Sans SC', value: '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif' },
            { label: '霞鹜文楷', labelEn: 'LXGW WenKai', value: '"LXGW WenKai", "LXGW WenKai Screen", "Kaiti SC", "STKaiti", serif' },
            { label: '更纱黑体', labelEn: 'Sarasa Gothic SC', value: '"Sarasa Gothic SC", "Sarasa UI SC", "PingFang SC", sans-serif' },
          ] },
          { key: 'monoFont', label: '代码与数字', labelEn: 'Code and numbers', type: 'font', default: DEFAULT_MONO_FONT, binding: { target: 'font', key: 'mono' } },
          { key: 'fontScale', label: '字号比例', labelEn: 'Font scale', type: 'slider', default: 1, min: 0.9, max: 1.3, step: 0.05, help: '整体缩放全壳字号，90%–130%', helpEn: 'Scales text across the whole shell, 90%–130%.', binding: { target: 'font', key: 'scale' } },
        ],
      },
      {
        id: 'layout', title: '布局与动画', titleEn: 'Layout and motion', fields: [
          // 标签页样式/自动隐藏/标题栏不透明度由「设置 → 主题」的标签栏与背景透明度分区渲染，
          // 但字段仍在此声明：这两个分区只认 schema 里的 binding，删掉会让控件消失。
          { key: 'tabStyle', label: '标签页样式', labelEn: 'Tab style', type: 'select', default: 'classic', options: [{ label: '顶部标签', labelEn: 'Top tabs', value: 'classic' }, { label: '圆轨', labelEn: 'Orb rail', value: 'orb' }], binding: { target: 'layout', key: 'tabStyle' } },
          { key: 'orbDock', label: '圆轨停靠', labelEn: 'Orb rail dock', type: 'select', default: 'left', options: [{ label: '左侧', labelEn: 'Left', value: 'left' }, { label: '右侧', labelEn: 'Right', value: 'right' }], help: '圆轨吸附在窗口左边或右边；也可直接拖动把手换边', helpEn: 'Docks the orb rail to the left or right edge; you can also drag the handle to switch sides.', binding: { target: 'layout', key: 'orbDock' }, visibleWhen: { field: 'tabStyle', equals: 'orb' } },
          { key: 'tabAutoHide', label: '标题栏自动隐藏', labelEn: 'Auto-hide titlebar', type: 'switch', default: false, help: '指针离开后整条标题栏收起，移到窗口顶部即展开', helpEn: 'Collapses the whole titlebar when the pointer leaves; move to the top edge to reveal it.', binding: { target: 'layout', key: 'tabAutoHide' }, visibleWhen: { field: 'tabStyle', equals: 'classic' } },
          // tabOpacity 不挂 visibleWhen：标题栏（红绿灯 + 插件名/Tab 条）两种样式都存在，背景不透明度都要可调。
          { key: 'tabOpacity', label: '标题栏透明度', labelEn: 'Titlebar transparency', type: 'slider', default: 0, min: 0, max: 1, step: 0.05, help: '越往右越透明，可透出窗口背景', helpEn: 'Further right is more transparent, revealing the window background.', binding: { target: 'layout', key: 'tabOpacity' } },
          // 卡片与标题栏同源：都是"材质层浓度"，拉到 0 可完全透出背景动效。
          { key: 'cardOpacity', label: '设置卡片透明度', labelEn: 'Settings card transparency', type: 'slider', default: 0.82, min: 0, max: 1, step: 0.05, help: '越往右越透明，可让页面背景动效透进设置卡片', helpEn: 'Further right is more transparent, letting the page background effect show through settings cards.', binding: { target: 'layout', key: 'cardOpacity' } },
          { key: 'contentWidth', label: '内容宽度', labelEn: 'Content width', type: 'slider', default: 1520, min: 640, max: 1920, step: 10, binding: { target: 'layout', key: 'contentWidth' } },
          { key: 'density', label: '内容密度', labelEn: 'Content density', type: 'slider', default: 1, min: 0.8, max: 1.2, step: 0.01, binding: { target: 'layout', key: 'density' } },
          { key: 'gap', label: '内容间距', labelEn: 'Content gap', type: 'slider', default: 16, min: 0, max: 32, step: 1, binding: { target: 'layout', key: 'gap' } },
          { key: 'columns', label: '目录列数', labelEn: 'Catalog columns', type: 'slider', default: 3, min: 1, max: 6, step: 1, binding: { target: 'layout', key: 'columns' } },
          { key: 'motion', label: '动画强度', labelEn: 'Motion intensity', type: 'select', default: 'medium', help: '低档减少过渡与轮播动效，高档启用完整动画', helpEn: 'Low reduces transitions and carousel motion; high enables the full animation set.', options: [{ label: '低', labelEn: 'Low', value: 'low' }, { label: '中', labelEn: 'Medium', value: 'medium' }, { label: '高', labelEn: 'High', value: 'high' }], binding: { target: 'animation', key: 'level' } },
        ],
      },
      {
        id: 'surfaces', title: '圆角、边框与通知', titleEn: 'Corners, borders and notifications',
        description: '控件、卡片、面板共用同一套圆角与描边；通知沿用同一外观语言。',
        descriptionEn: 'Controls, cards and panels share one corner and stroke set; notifications follow the same visual language.',
        fields: [
          { key: 'radius', label: '控件圆角', labelEn: 'Control radius', type: 'slider', default: 10, min: 0, max: 24, step: 1, binding: { target: 'component', key: 'controlRadius' } },
          { key: 'cardRadius', label: '卡片圆角', labelEn: 'Card radius', type: 'slider', default: 18, min: 0, max: 32, step: 1, binding: { target: 'component', key: 'cardRadius' } },
          { key: 'panelRadius', label: '面板圆角', labelEn: 'Panel radius', type: 'slider', default: 24, min: 0, max: 40, step: 1, binding: { target: 'component', key: 'panelRadius' } },
          { key: 'borderWidth', label: '边框宽度', labelEn: 'Border width', type: 'slider', default: 1, min: 0, max: 6, step: 0.1, binding: { target: 'component', key: 'borderWidth' } },
          { key: 'notificationLayout', label: '通知布局', labelEn: 'Notification layout', type: 'select', default: 'card', options: [{ label: '标准卡片', labelEn: 'Standard card', value: 'card' }, { label: '紧凑', labelEn: 'Compact', value: 'compact' }, { label: '横幅', labelEn: 'Banner', value: 'banner' }], binding: { target: 'notification', key: 'layout' } },
          { key: 'notificationAccent', label: '通知强调', labelEn: 'Notification accent', type: 'select', default: 'stripe', options: [{ label: '侧边色条', labelEn: 'Side stripe', value: 'stripe' }, { label: '级别图标', labelEn: 'Level icon', value: 'icon' }, { label: '无', labelEn: 'None', value: 'none' }], binding: { target: 'notification', key: 'accent' } },
          { key: 'notificationShadow', label: '通知阴影', labelEn: 'Notification shadow', type: 'select', default: 'soft', options: [{ label: '无', labelEn: 'None', value: 'none' }, { label: '轻阴影', labelEn: 'Soft', value: 'soft' }, { label: '浮起', labelEn: 'Raised', value: 'raised' }], binding: { target: 'notification', key: 'shadow' } },
          { key: 'notificationRadius', label: '通知圆角', labelEn: 'Notification radius', type: 'slider', default: 16, min: 0, max: 24, step: 1, binding: { target: 'notification', key: 'radius' } },
          { key: 'notificationBorderWidth', label: '通知边框', labelEn: 'Notification border', type: 'slider', default: 1, min: 0, max: 6, step: 0.1, binding: { target: 'notification', key: 'borderWidth' } },
          { key: 'notificationDensity', label: '通知密度', labelEn: 'Notification density', type: 'slider', default: 1, min: 0.8, max: 1.2, step: 0.01, binding: { target: 'notification', key: 'density' } },
        ],
      },
    ],
  },
  home: { source: DEFAULT_THEME_IDENTITY.source, id: 'home', variant: 'default' },
  // The classic entry is embedded in the shell document to avoid an extra renderer.
  // Both implementations consume ThemeChromeApi; only native geometry stays in main.
  chrome: { version: 1, classic: { entry: 'index.html' }, rail: { entry: 'orb-overlay.html' }, dock: { entry: 'orb-overlay.html' } },
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
