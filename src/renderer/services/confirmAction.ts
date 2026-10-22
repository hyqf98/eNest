import { create } from 'zustand'
import { isMockShell, shellApi } from '@renderer/services/shellApi'

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
}
interface Confirmation extends ConfirmOptions {
  id: number
  returnFocus: HTMLElement | null
  resolve: (confirmed: boolean) => void
}
export const useConfirmation = create<{ request: Confirmation | null }>(() => ({ request: null }))
let sequence = 0

/** Shell home/settings only. Repeated requests cancel rather than duplicating a destructive action. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  if (useConfirmation.getState().request) return Promise.resolve(false)
  if (!isMockShell && shellApi.openNativeModal) {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return shellApi.openNativeModal({ kind: 'confirm', options }).finally(() => {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    })
  }
  return new Promise(resolve => {
    useConfirmation.setState({ request: {
      ...options, id: ++sequence, resolve,
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    } })
  })
}

export function finishConfirmation(id: number, confirmed: boolean): void {
  const request = useConfirmation.getState().request
  if (!request || request.id !== id) return
  useConfirmation.setState({ request: null })
  request.resolve(confirmed)
}
