/**
 * shared/types/ipc — IPC 通道与负载类型定义
 * 职责：定义主进程 / preload / 渲染进程三方共用的通道名常量与请求/响应类型。
 * 被 shellPreload、pluginPreload、主进程各 handler 共同引用。
 * 关键依赖：无（纯类型定义）。
 */
/**
 * IPC 通道常量 — 主进程 / preload / 渲染进程共用。
 * 约定：全部为 request-response（invoke），事件推送走 `shell:event`。
 */
export const IpcChannels = {
  /** 壳子 → 主进程 */
  ShellGetPlugins: 'shell:get-plugins',
  ShellOpenPlugin: 'shell:open-plugin',
  ShellClosePlugin: 'shell:close-plugin',
  ShellActivatePlugin: 'shell:activate-plugin',
  ShellGetBounds: 'shell:get-bounds',
  ShellSetContentBounds: 'shell:set-content-bounds',
  ShellGetTheme: 'shell:get-theme',
  ShellSetTheme: 'shell:set-theme',
  ShellLoadDevPlugin: 'shell:load-dev-plugin',
  ShellReloadPlugin: 'shell:reload-plugin',
  ShellOpenDevTools: 'shell:open-devtools',
  ShellGetSettings: 'shell:get-settings',
  ShellSetSettings: 'shell:set-settings',

  /** 路径与数据 */
  ShellGetPaths: 'shell:get-paths',
  ShellPickFile: 'shell:pick-file',
  ShellGetPluginReadme: 'shell:get-plugin-readme',
  ShellQueryDb: 'shell:query-db',

  /** 硬件加速（写入设置后需重启） */
  ShellGetHardwareAccel: 'shell:get-hardware-accel',
  ShellSetHardwareAccel: 'shell:set-hardware-accel',

  /** 插件拖拽/路径安装：入队后由主进程 installQueue 限流执行 */
  ShellInstallPlugin: 'shell:install-plugin',
  ShellGetInstallQueue: 'shell:get-install-queue',

  /** 卸载插件：关闭 Tab → 清 partition storage → 删文件 → 重扫注册表 */
  ShellUninstallPlugin: 'shell:uninstall-plugin',

  /** 应用自动更新（GitHub Release + electron-updater） */
  ShellCheckUpdate: 'shell:check-update',
  ShellDownloadUpdate: 'shell:download-update',
  ShellInstallUpdate: 'shell:install-update',
  ShellGetUpdateState: 'shell:get-update-state',

  WindowMinimize: 'window:minimize',
  WindowMaximize: 'window:maximize',
  WindowClose: 'window:close',

  /** 插件 preload → 主进程（经 permission 校验） */
  PluginCall: 'plugin:call',
  PluginEvent: 'plugin:event',

  /** 主进程 → 插件 webContents 生命周期推送（enter/out/beforeClose/destroy） */
  PluginLifecycle: 'plugin:lifecycle',
  /** 插件 preload → 主进程：beforeClose 确认（可选，超时 300ms 兜底） */
  PluginLifecycleAck: 'plugin:lifecycle-ack',

  /** 主进程 → 壳子渲染进程推送 */
  ShellEvent: 'shell:event'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/** 壳子 Toast 类型：info 默认样式，success/warn/error 带强调色 */
export type ToastKind = 'info' | 'success' | 'warn' | 'error'

/** shell:event 负载类型 */
export type ShellEventPayload =
  | { type: 'plugins-changed' }
  | { type: 'tab-closed'; tabId: string }
  | { type: 'plugin-error'; pluginId: string; message: string }
  | { type: 'settings-sections'; sections: unknown[] }
  | { type: 'theme-changed'; mode: 'light' | 'dark' | 'system' }
  | { type: 'locale-changed'; locale: 'zh-CN' | 'en-US' }
  | { type: 'theme-packs-changed' }
  | { type: 'plugin-active'; tabId: string | null }
  | { type: 'plugin-title'; tabId: string; title: string }
  | { type: 'plugin-icon'; tabId: string; icon: string }
  | { type: 'plugin-badge'; tabId: string; badge: string | number }
  /** 插件请求壳子 Toast（由 useShellEvents → toastStore 渲染） */
  | { type: 'plugin-toast'; pluginId: string; message: string; toastType?: ToastKind }
  | { type: 'install-progress'; jobId: string; name: string; progress: number; step?: string }
  | { type: 'install-queue'; active: InstallJobInfo[]; waiting: InstallJobInfo[] }
  | { type: 'install-result'; jobId: string; name: string; ok: boolean; error?: string }
  /** 卸载结果：与 install-result 同级，壳子据此 toast + 刷新列表 */
  | { type: 'uninstall-result'; pluginId: string; name: string; ok: boolean; error?: string }
  /** 自动更新状态变更（检查 / 下载进度 / 就绪 / 错误） */
  | { type: 'update-status'; state: UpdateStatePayload }

/** 更新状态推送到渲染层的负载 */
export interface UpdateStatePayload {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  currentVersion: string
  latestVersion?: string
  releaseName?: string
  releaseNotes?: string
  progress?: number
  downloaded?: boolean
  error?: string
  packaged?: boolean
}

/** 主进程 → 插件 WebContents（IpcChannels.PluginEvent）负载 */
export type PluginEventPayload =
  | {
      type: 'theme-change'
      mode: 'light' | 'dark'
      tokens: Record<string, string>
    }

/** 安装队列任务对外视图（active / waiting 列表项） */
export interface InstallJobInfo {
  id: string
  name: string
  progress: number
  status: 'queued' | 'active' | 'done' | 'failed'
}

/** 插件 API 调用：preload 将 zapi 调用收敛到 plugin:call */
export interface PluginCallRequest {
  pluginId: string
  method: string
  args: unknown[]
}

export interface PluginCallResult {
  ok: boolean
  data?: unknown
  error?: string
}
