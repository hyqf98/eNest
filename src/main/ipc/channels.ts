/**
 * channels — IPC 通道类型再导出
 * 职责：将 @shared/types/ipc 中的 IpcChannels 与相关类型聚合导出，供主进程内部统一引用。
 * 被主进程各模块按需 import。
 * 关键依赖：@shared/types/ipc。
 */
export { IpcChannels } from '@shared/types/ipc'
export type {
  IpcChannel,
  ShellEventPayload,
  PluginCallRequest,
  PluginCallResult
} from '@shared/types/ipc'
