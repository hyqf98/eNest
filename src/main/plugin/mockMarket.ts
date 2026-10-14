/**
 * mockMarket — 模拟插件市场数据
 * 职责：提供内置插件市场的静态元数据（名称、描述、权限等），用于列表展示与示例安装。
 * 被 PluginRegistry（list / manifestToSummary / installFromSample）调用。
 * 关键依赖：@shared/types/plugin 类型定义。
 */
import type { PluginPermission, PluginSummary } from '@shared/types/plugin'
import { DEFAULT_PLUGIN_UI } from '@shared/types/plugin'
import { mockPluginIcon } from '@shared/mockPluginIcon'

export interface MockMarketPlugin {
  id: string
  name: string
  author: string
  description: string
  version: string
  installs: string
  category: string
  color: string
  glyph: string
  permissions: PluginPermission[]
}

export const MOCK_MARKET_PLUGINS: MockMarketPlugin[] = [
  {
    id: 'com.enest.screen-assistant',
    name: '屏幕助手',
    author: 'eNest Labs',
    description: '矩形截图、矩形录屏（可选声音）、贴图三入口（截图/剪贴板/本地图片）与贴图管理。',
    version: '1.1.0',
    installs: '9.6k',
    category: '媒体',
    color: '#38bdf8',
    glyph: '▣',
    permissions: [
      'screen.capture',
      'screen.record',
      'pin.create',
      'clipboard.readImage',
      'clipboard.writeImage',
      'storage.local',
      'ui.setTitle',
      'ui.toast'
    ]
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
      'ui.toast'
    ]
  },
  {
    id: 'com.enest.translate',
    name: '翻译',
    author: 'Lingua',
    description: '多引擎翻译（Google/MyMemory 自动切换），自动检测语言，一键复制译文。',
    version: '1.1.0',
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
      'ui.toast'
    ]
  },
  {
    id: 'com.enest.ssh',
    name: 'SSH 管理',
    author: 'eNest Labs',
    description: '连接资产库、交互终端、命令补全、性能监控与最小 SFTP。',
    version: '1.0.0',
    installs: 'local',
    category: '开发',
    color: '#34d399',
    glyph: '❯',
    permissions: [
      'vault.write',
      'ssh.session',
      'ssh.exec',
      'ssh.sftp',
      'storage.local',
      'ui.setTitle',
      'ui.toast',
      'notify',
      'clipboard.write',
      'shell.openExternal',
      'settings.register'
    ]
  },
  {
    id: 'com.enest.database',
    name: '数据库',
    author: 'eNest Labs',
    description: '桌面级 SQL 客户端：代码提示、结果集增删改批、控制台会话与导入导出。',
    version: '1.0.0',
    installs: 'local',
    category: '开发',
    color: '#60a5fa',
    glyph: '▤',
    permissions: [
      'vault.write',
      'db.connect',
      'db.query',
      'db.schema',
      'storage.local',
      'ui.setTitle',
      'ui.toast',
      'notify',
      'clipboard.write',
      'shell.openExternal',
      'settings.register'
    ]
  },
  {
    id: 'com.enest.sticky-notes',
    name: '备忘录',
    author: 'eNest Labs',
    description: '多张便签随手记：彩色标签、置顶、自动保存，重开不丢。',
    version: '1.0.0',
    installs: '8.1k',
    category: '效率',
    color: '#5b8cff',
    glyph: '✎',
    permissions: ['storage.local', 'ui.setTitle', 'ui.toast']
  },
  {
    id: 'com.enest.timestamp',
    name: '时间戳',
    author: 'eNest Labs',
    description: '当前秒/毫秒实时刷新一键复制，时间戳与时间互转，ISO 等常用格式。',
    version: '1.0.0',
    installs: '6.4k',
    category: '开发',
    color: '#3ddc97',
    glyph: '⏱',
    permissions: ['clipboard.write', 'ui.setTitle', 'ui.toast']
  },
  {
    id: 'com.enest.json-tools',
    name: 'JSON 工具',
    author: 'eNest Labs',
    description: 'JSON 格式化、压缩、校验定位与转义反转义。',
    version: '1.0.0',
    installs: '7.2k',
    category: '开发',
    color: '#3ddc97',
    glyph: '{}',
    permissions: ['clipboard.read', 'clipboard.write', 'ui.setTitle', 'ui.toast']
  },
  {
    id: 'com.enest.codec',
    name: '编解码',
    author: 'eNest Labs',
    description: 'Base64 / URL / Hex / Unicode 编码解码，中文安全，双栏互换。',
    version: '1.0.0',
    installs: '5.8k',
    category: '开发',
    color: '#3ddc97',
    glyph: '⇄',
    permissions: ['clipboard.read', 'clipboard.write', 'ui.setTitle', 'ui.toast']
  },
  {
    id: 'com.enest.qrcode',
    name: '二维码',
    author: 'eNest Labs',
    description: '文本/URL 生成二维码（尺寸与纠错可调），剪贴板或本地图片解码。',
    version: '1.0.0',
    installs: '6.9k',
    category: '效率',
    color: '#5b8cff',
    glyph: '▦',
    permissions: ['clipboard.read', 'clipboard.write', 'clipboard.readImage', 'clipboard.writeImage', 'ui.setTitle', 'ui.toast']
  },
  {
    id: 'com.enest.pomodoro',
    name: '番茄钟',
    author: 'eNest Labs',
    description: '专注 25 分钟休息 5 分钟（可调），到点系统通知，今日完成统计。',
    version: '1.0.0',
    installs: '4.9k',
    category: '效率',
    color: '#5b8cff',
    glyph: '◷',
    permissions: ['notify', 'storage.local', 'ui.setTitle', 'ui.toast']
  },
  {
    id: 'com.enest.todos',
    name: '待办清单',
    author: 'eNest Labs',
    description: '轻量待办：添加、勾选、置顶、编辑，完成情况自动保存。',
    version: '1.0.0',
    installs: '7.7k',
    category: '效率',
    color: '#5b8cff',
    glyph: '☑',
    permissions: ['storage.local', 'ui.setTitle', 'ui.toast']
  },
  {
    id: 'com.enest.calculator',
    name: '计算器',
    author: 'eNest Labs',
    description: '四则运算与括号百分比，键盘即输即算，附历史记录。',
    version: '1.0.0',
    installs: '5.5k',
    category: '效率',
    color: '#5b8cff',
    glyph: '=',
    permissions: ['clipboard.write', 'ui.setTitle', 'ui.toast']
  },
  {
    id: 'com.enest.password-kit',
    name: '密码工具箱',
    author: 'eNest Labs',
    description: '随机密码生成（长度/字符集可调、强度提示）与 UUID v4 批量生成。',
    version: '1.0.0',
    installs: '5.1k',
    category: '效率',
    color: '#5b8cff',
    glyph: '✱',
    permissions: ['clipboard.write', 'ui.setTitle', 'ui.toast']
  },
  {
    id: 'com.enest.color-picker',
    name: '取色器',
    author: 'eNest Labs',
    description: '屏幕取色：放大镜精准取点，HEX/RGB/HSL 一键复制，附历史色板。',
    version: '1.0.0',
    installs: '5.2k',
    category: '设计',
    color: '#a78bfa',
    glyph: '◉',
    permissions: ['screen.capture', 'clipboard.write', 'storage.local', 'ui.setTitle', 'ui.toast']
  }
]

/** 将 mock 市场数据转为 PluginSummary 数组 */
export function mockToSummary(installed: boolean): PluginSummary[] {
  return MOCK_MARKET_PLUGINS.map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    description: p.description,
    author: p.author,
    category: p.category,
    installs: p.installs,
    color: p.color,
    glyph: p.glyph,
    icon: mockPluginIcon(p.id, p.color),
    permissions: p.permissions,
    installed,
    // 市场 mock 尚无 manifest，统一用默认 UI 配置；安装后由 PluginRegistry 覆盖
    ui: { ...DEFAULT_PLUGIN_UI }
  }))
}

/** com.enest.clipboard → clipboard */
export function shortNameOf(pluginId: string): string {
  const parts = pluginId.split('.')
  return parts[parts.length - 1] || pluginId
}
