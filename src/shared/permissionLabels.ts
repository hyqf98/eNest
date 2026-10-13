/**
 * permissionLabels — 插件权限中文名与用途文案（29 项，与 PluginPermission 一一对应）
 * 职责：权限弹窗（PermissionPromptModal）与设置页「权限管理」块共用单一来源。
 * 注意：新增权限时同步 plugin.ts 的联合类型 + PLUGIN_PERMISSIONS + 本表。
 */
import type { PluginPermission } from '@shared/types/plugin'

export const PERMISSION_LABELS: Record<PluginPermission, string> = {
  'clipboard.read': '读取剪贴板',
  'clipboard.write': '写入剪贴板',
  'clipboard.readImage': '读取剪贴板图片',
  'clipboard.writeImage': '写入剪贴板图片',
  'clipboard.history': '访问剪贴板历史',
  'screen.capture': '屏幕截图',
  'screen.record': '屏幕录制',
  'pin.create': '创建贴图窗口',
  'net.fetch': '访问网络（HTTPS）',
  'shell.openExternal': '打开外部链接',
  'storage.local': '本地数据存储',
  notify: '系统通知',
  'ui.setTitle': '设置窗口标题',
  'ui.setIcon': '设置窗口图标',
  'ui.setBadge': '设置角标',
  'ui.resize': '调整窗口尺寸',
  'ui.toast': '显示应用内提示',
  'settings.register': '注册设置项',
  'settings.page': '设置页扩展',
  hotkey: '注册全局快捷键',
  contribute: '贡献界面入口',
  'vault.write': '安全密钥库读写',
  'ssh.session': 'SSH 终端会话',
  'ssh.exec': '执行远程命令',
  'ssh.sftp': 'SFTP 文件传输',
  'db.connect': '连接数据库',
  'db.query': '执行数据库查询',
  'db.schema': '读取数据库结构',
  theme: '注册主题包'
}

/** 取权限中文名；未知键回退原键名（防御） */
export function permissionLabel(perm: string): string {
  return (PERMISSION_LABELS as Record<string, string>)[perm] ?? perm
}
