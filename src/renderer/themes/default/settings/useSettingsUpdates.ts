import { useCallback, useEffect, useRef, useState } from 'react'
import { useUpdateDialogStore } from '@renderer/stores/updateDialogStore'
import { useI18n } from '@renderer/hooks/useI18n'
import { toastStore } from '@renderer/hooks/useToast'
import { shellApi } from '@renderer/services/shellApi'
import type { UpdateStatePayload } from '@shared/types/ipc'

/** Update events stay subscribed while any settings tab is open. */
export function useSettingsUpdates() {
  const { t } = useI18n()
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const checkingRef = useRef(false)
  const stateRevision = useRef(0)
  const openUpdateDialog = useUpdateDialogStore((s) => s.openDialog)
  const restartAfterSave = useUpdateDialogStore((s) => s.restartAfterSave)

  /** 订阅主进程 update-status 推送，并拉取一次当前状态 */
  useEffect(() => {
    const initialRevision = stateRevision.current
    const off = shellApi.onEvent((payload) => {
      if (payload.type === 'update-status' && payload.state) {
        stateRevision.current++
        setUpdateState(payload.state)
        const st = payload.state.status
        // 通知只在事件侧提示一次，避免与 handleCheckUpdate 结果回调重复
        if (st === 'not-available' && checkingRef.current) {
          toastStore.getState().push(t('toasts.updateNone'))
        } else if (st === 'downloaded') {
          toastStore.getState().push(t('toasts.updateReady'))
        } else if (st === 'error' && payload.state.error) {
          toastStore.getState().push(t('toasts.updateError'))
        }
      }
    })
    void shellApi.getUpdateState?.().then(state => {
      if (stateRevision.current === initialRevision) setUpdateState(state)
    }).catch(() => undefined)
    return () => {
      stateRevision.current++
      off()
    }
  }, [t])

  const handleCheckUpdate = useCallback(() => {
    const check = shellApi.checkForUpdates
    if (!check || checkingRef.current) return
    const revision = ++stateRevision.current
    checkingRef.current = true
    setCheckingUpdate(true)
    void (async () => {
      try {
        const result = await check()
        if (result && revision === stateRevision.current) setUpdateState(result)
      } catch {
        toastStore.getState().push(t('toasts.updateError'))
      } finally {
        checkingRef.current = false
        setCheckingUpdate(false)
      }
    })()
  }, [t])

  const handleInstallUpdate = useCallback(() => {
    void restartAfterSave()
  }, [restartAfterSave])

  return { updateState, checkingUpdate, openUpdateDialog, handleCheckUpdate, handleInstallUpdate }
}
