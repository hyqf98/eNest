import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as Dialog from '@radix-ui/react-dialog'
import type { NativeModalAction, NativeModalApi, NativeModalState } from '@shared/types/modal'
import { applyAppearanceToDom } from '@renderer/services/appearanceDom'
import { Button } from '@renderer/components/ui/Button'
import { MarkdownView } from '@renderer/components/MarkdownView'
import '@renderer/styles/tokens.css'
import '@renderer/styles/base.css'
import '@renderer/styles/app.css'
import '@renderer/styles/appearance.css'
import '@renderer/styles/confirmDialog.css'
import '@renderer/styles/updateDialog.css'
import '@renderer/modal-overlay.css'

declare global { interface Window { enestModal?: NativeModalApi } }
const api = window.enestModal

function NativeModal() {
  const [state, setState] = useState<NativeModalState | null>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const off = api?.onState(next => {
      applyAppearanceToDom(next.appearance)
      setState(next)
    })
    api?.ready()
    return off
  }, [])
  if (!state) return null
  const english = state.locale === 'en-US'
  const text = (zh: string, en: string): string => english ? en : zh
  const action = (value: NativeModalAction): void => { api?.respond(state.id, value) }
  const update = state.update
  const progress = Math.min(100, Math.max(0, Math.round(update?.progress ?? 0)))
  const dirty = state.dirtyItems.filter(item => item.dirty)
  return <Dialog.Root open onOpenChange={open => { if (!open) action('cancel') }}>
    <Dialog.Portal>
      <Dialog.Overlay className="confirm-overlay native-modal-backdrop" />
      <Dialog.Content className={state.kind === 'confirm' ? `confirm-panel${state.options?.danger ? ' is-danger' : ''}` : 'native-update-panel update-modal'}
        onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus({ preventScroll: true }) }}
        onEscapeKeyDown={event => { event.preventDefault(); action('cancel') }}
        onInteractOutside={event => event.preventDefault()}>
        {state.kind === 'confirm' ? <>
          <Dialog.Title>{state.options?.title}</Dialog.Title>
          <Dialog.Description>{state.options?.message}</Dialog.Description>
          <div className="confirm-actions">
            <Button ref={cancel} variant="ghost" onClick={() => action('cancel')}>{text('取消', 'Cancel')}</Button>
            <Button variant={state.options?.danger ? 'danger' : 'primary'} onClick={() => action('confirm')}>{state.options?.confirmLabel}</Button>
          </div>
        </> : <>
          <header className="update-header">
            <div className="update-title-meta">
              <Dialog.Title>{text('eNest 更新', 'Update eNest')}</Dialog.Title>
              <Dialog.Description className="update-versions">v{update?.currentVersion ?? '-'} → v{update?.latestVersion ?? '-'}</Dialog.Description>
            </div>
          </header>
          <div className="update-body">
            {update?.releaseNotes?.trim() ? <MarkdownView source={update.releaseNotes} /> : <p>{text('当前版本信息由宿主更新服务提供。', 'Version information is provided by the host updater.')}</p>}
            <Button variant="ghost" size="sm" onClick={() => action('release')}>{text('查看发布页', 'View releases')}</Button>
          </div>
          <div className="update-status" aria-live="polite">
            {update?.status === 'downloading' && <div className="update-progress" role="progressbar" aria-label={text('下载进度', 'Download progress')} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              <div className="update-progress-track"><div className="update-progress-fill" style={{ width: `${progress}%` }} /></div><span>{progress}%</span>
            </div>}
            {!!dirty.length && <p>{text('未保存内容：', 'Unsaved work: ')}{dirty.map(item => item.name).join('、')}</p>}
            {(state.error || update?.error) && <p className="update-error">{state.error || update?.error}</p>}
          </div>
          <footer className="update-actions">
            <Button ref={cancel} variant="ghost" disabled={state.saving} onClick={() => action('cancel')}>{text('稍后', 'Later')}</Button>
            {update?.status === 'available' && <Button variant="primary" onClick={() => action('download')}>{text('下载更新', 'Download')}</Button>}
            {update?.status === 'downloaded' && <Button variant="primary" disabled={state.saving} onClick={() => action('install')}>{state.saving ? text('正在保存…', 'Saving…') : text('保存并重启安装', 'Save and restart')}</Button>}
            {update?.status === 'error' && <Button variant="primary" onClick={() => action('retry')}>{text('重试', 'Retry')}</Button>}
          </footer>
        </>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
createRoot(document.getElementById('root')!).render(<NativeModal />)
