/**
 * Toast — 历史组件入口（已迁至 NotificationHost）
 * 保留导出以兼容旧 import；实际渲染由 App 根部的 NotificationHost 负责。
 * 新代码请使用 NotificationHost / notifyService。
 */
export { NotificationHost as Toast } from '@renderer/components/NotificationHost'
export { NotificationHost } from '@renderer/components/NotificationHost'
