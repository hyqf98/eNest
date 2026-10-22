/**
 * updateDialogStore — 更新弹框与安装前保存协调
 * available / downloading / downloaded 等状态由 UpdateDialog 内部订阅 update-status 维护；
 * 设置页与弹框共用保存/安装动作，原生 updater 关闭窗口前完成保存等待。
 */
import { create } from 'zustand'
import { isMockShell, shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { t } from '@renderer/i18n'
import type { PluginDirtyState } from '@shared/types/ipc'

interface UpdateDialogState {
  open: boolean
  saving: boolean
  dirtyItems: PluginDirtyState['items'] | null
  openDialog(): void
  closeDialog(): void
  setDirtyItems(items: PluginDirtyState['items']): void
  restartAfterSave(): Promise<void>
}

export const useUpdateDialogStore = create<UpdateDialogState>((set, get) => ({
  open: false,
  saving: false,
  dirtyItems: null,
  openDialog: () => {
    if (!isMockShell && shellApi.openNativeModal) {
      void shellApi.openNativeModal({ kind: 'update' }).catch(() => notify.error('更新窗口未能打开，请重试'))
      return
    }
    set({ open: true })
  },
  closeDialog: () => { if (!get().saving) set({ open: false }) },
  setDirtyItems: (dirtyItems) => set({ dirtyItems }),
  restartAfterSave: async () => {
    const install = shellApi.installUpdate
    if (!install || get().saving) return
    // Zustand 同步写入，两个入口和同一帧双击也只会启动一次保存。
    set({ open: true, saving: true })
    try {
      if (shellApi.getPluginsDirty) {
        try {
          const snapshot = await shellApi.getPluginsDirty()
          set({ dirtyItems: snapshot.items })
        } catch {
          /* 检测失败不阻塞保存 */
        }
      }
      const summary = await shellApi.saveAllPlugins?.()
      if (summary && summary.timedOut > 0) {
        notify.warn(t('update.dialog.saveTimeout', { count: String(summary.timedOut) }))
      }
    } catch {
      // 保持现有产品语义：保存失败或超时会提示，仍允许继续重启安装。
      notify.warn(t('update.dialog.saveFailed'))
    }
    try {
      const state = await install()
      if (state.status === 'error') {
        set({ saving: false })
        notify.error(state.error || t('toasts.updateError'))
      }
      // 成功时维持 saving，直到主进程退出；避免再次提交安装。
    } catch (error) {
      set({ saving: false })
      notify.error(error instanceof Error ? error.message : t('toasts.updateError'))
    }
  },
}))
