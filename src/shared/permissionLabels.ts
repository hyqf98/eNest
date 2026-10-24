/**
 * permissionLabels — 宿主能力中文名（与 PluginPermission 一一对应）。
 * 职责：原生敏感权限弹窗、设置页与插件详情共用单一来源。
 * 注意：新增权限时同步 plugin.ts 的联合类型 + PLUGIN_PERMISSIONS + 本表。
 */
import type { PluginPermission } from '@shared/types/plugin'

export const PERMISSION_LABELS: Record<PluginPermission, string> = {
  'backend.node': '运行本机后端（可访问文件、网络和系统）',
  'clipboard.read': '读取剪贴板',
  'clipboard.write': '写入剪贴板',
  'clipboard.readImage': '读取剪贴板图片',
  'clipboard.writeImage': '写入剪贴板图片',
  'clipboard.history': '访问剪贴板历史',
  'clipboard.paste': '回贴到原应用',
  'timer.background': '后台专注计时',
  'screen.capture': '屏幕截图',
  'screen.record': '屏幕录制',
  'pin.create': '创建贴图窗口',
  'net.fetch': '访问网络（HTTP/HTTPS）',
  'shell.openExternal': '打开外部链接',
  'storage.local': '插件私有数据存储',
  notify: '系统通知',
  'ui.setTitle': '设置窗口标题',
  'ui.setIcon': '设置窗口图标',
  'ui.setBadge': '设置角标',
  'ui.resize': '调整窗口尺寸',
  'ui.toast': '显示应用内提示',
  'settings.register': '注册设置项',
  'settings.page': '设置页扩展',
  hotkey: '注册全局快捷键',
  contribute: '接收 Quick 搜索并提供结果',
  'vault.write': '插件私有密钥保存与移除',
  'db.connect': '连接数据库',
  'db.query': '执行数据库查询',
  'db.schema': '读取数据库结构',
  'mw.connect': '连接消息中间件',
  'mw.query': '浏览消息中间件',
  'mw.admin': '管理消息中间件',
  'net.socket': 'TCP 连接与本地桥接',
  'fs.rename': '重命名本地文件',
  'fs.read': '读取用户选择的本地文件',
  'fs.write': '写入用户选择的本地文件',
  'sys.control': '终止系统进程',
  'ssh.agent': '使用本机 SSH Agent 认证',
  'sys.inspect': '查看系统进程与端口',
  theme: '注册主题包'
}

/** 取权限中文名；未知键回退原键名（防御） */
export function permissionLabel(perm: string): string {
  return (PERMISSION_LABELS as Record<string, string>)[perm] ?? perm
}
