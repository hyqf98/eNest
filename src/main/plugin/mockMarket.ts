/**
 * mockMarket — 模拟插件市场数据
 * 职责：提供内置插件市场的静态元数据（名称、描述、权限等），用于列表展示与示例安装。
 * 被 PluginRegistry（list / manifestToSummary / installFromSample）调用。
 * 关键依赖：@shared/types/plugin 类型定义。
 */
import type { PluginPermission, PluginSummary } from '@shared/types/plugin'
import { DEFAULT_PLUGIN_UI } from '@shared/types/plugin'

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
