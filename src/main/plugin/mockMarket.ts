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
    id: 'com.enest.clipboard',
    name: '剪贴板历史',
    author: 'eNest Labs',
    description: '本地加密保存剪贴板历史，支持搜索、置顶与一键粘贴。',
    version: '1.2.0',
    installs: '12.4k',
    category: '效率',
    color: '#5b8cff',
    glyph: 'C',
    permissions: ['clipboard.read', 'clipboard.write', 'storage.local']
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
    permissions: ['clipboard.read', 'clipboard.write']
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
    permissions: ['storage.local']
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
    permissions: ['clipboard.read', 'notify']
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
    permissions: ['storage.local', 'notify', 'settings.register']
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
    permissions: ['clipboard.write', 'storage.local']
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
    permissions: ['ui.setTitle']
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
