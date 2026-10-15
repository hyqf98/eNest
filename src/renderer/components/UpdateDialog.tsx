/**
 * UpdateDialog — 应用更新弹框
 * 展示版本对比与 Release Notes（MarkdownView 渲染 GitHub Release body），
 * 点击「立即更新」开始下载（进度条），完成后一键「保存插件数据并重启安装」。
 * 状态来源：主进程 update-status 事件（shellApi.onEvent）；入口目前仅在设置页
 * （插件视图已隐藏，无原生层遮挡问题）。
 * 依赖：updateDialogStore、marketMotion、MarkdownView、shellApi、notifyService。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { MarkdownView } from '@renderer/components/MarkdownView'
import { useUpdateDialogStore } from '@renderer/stores/updateDialogStore'
import { playUpdateDialogIn, playUpdateDialogOut } from '@renderer/gsap/marketMotion'
import { shellApi } from '@renderer/services/shellApi'
import { useI18n } from '@renderer/hooks/useI18n'
import type { UpdateStatePayload } from '@shared/types/ipc'
import '@renderer/styles/updateDialog.css'

/** 发布页地址（electron-builder.yml publish：github/hyqf98/eNest） */
const RELEASES_URL = 'https://github.com/hyqf98/eNest/releases'

export function UpdateDialog() {
  const open = useUpdateDialogStore((s) => s.open)
  const closeDialog = useUpdateDialogStore((s) => s.closeDialog)
  const saving = useUpdateDialogStore((s) => s.saving)
  const dirtyItems = useUpdateDialogStore((s) => s.dirtyItems)
  const setDirtyItems = useUpdateDialogStore((s) => s.setDirtyItems)
  const restartAfterSave = useUpdateDialogStore((s) => s.restartAfterSave)
  const { t } = useI18n()

  const rootRef = useRef<HTMLDivElement>(null)
  const closingRef = useRef(false)
  const motionContext = useRef<gsap.Context | null>(null)
  const downloadBusy = useRef(false)

  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null)

  // —— 状态订阅（常驻：任何入口打开弹框都能拿到最新状态）——
  useEffect(() => {
    let cancelled = false
    if (shellApi.getUpdateState) {
      void shellApi.getUpdateState().then((s) => {
        if (!cancelled && s) setUpdateState(s)
      })
    }
    if (!shellApi.onEvent) return () => undefined
    const off = shellApi.onEvent((payload) => {
      if (payload.type === 'update-status' && payload.state) setUpdateState(payload.state)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const status = updateState?.status
  const latestVersion = updateState?.latestVersion
  const dirtyCount = (dirtyItems ?? []).filter((item) => item.dirty).length

  // —— 脏状态检测：进入 downloaded 后拉取一次（重启前会再刷新）——
  useEffect(() => {
    if (!open || status !== 'downloaded') return
    let cancelled = false
    if (shellApi.getPluginsDirty) {
      void shellApi
        .getPluginsDirty()
        .then((snapshot) => {
          if (!cancelled) setDirtyItems(snapshot.items)
        })
        .catch(() => {
          if (!cancelled) setDirtyItems([])
        })
    }
    return () => {
      cancelled = true
    }
  }, [open, status, setDirtyItems])

  // —— 动效：打开入场；关闭先播退场再卸载 ——
  useEffect(() => {
    if (!open) return
    closingRef.current = false
    const context = gsap.context(() => playUpdateDialogIn(rootRef.current), rootRef)
    motionContext.current = context
    return () => {
      motionContext.current = null
      context.revert()
    }
  }, [open])

  const requestClose = useCallback(() => {
    if (closingRef.current || useUpdateDialogStore.getState().saving) return
    closingRef.current = true
    motionContext.current?.add(() => {
      void playUpdateDialogOut(rootRef.current).then(() => {
        closeDialog()
      })
    })
  }, [closeDialog])

  // Escape = 稍后
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        requestClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, requestClose])

  const handleDownload = useCallback(() => {
    const download = shellApi.downloadUpdate
    if (!download || downloadBusy.current) return
    downloadBusy.current = true
    void download().finally(() => {
      downloadBusy.current = false
    })
  }, [])

  /** 设置页快捷入口与弹框统一走保存协调，避免原生 updater 提前关闭插件。 */
  const handleRestart = useCallback(() => {
    void restartAfterSave()
  }, [restartAfterSave])

  const handleRetry = useCallback(() => {
    const check = shellApi.checkForUpdates
    if (!check) return
    void check()
  }, [])

  if (!open) return null

  const progress = Math.min(100, Math.max(0, Math.round(updateState?.progress ?? 0)))
  const notes = updateState?.releaseNotes?.trim()
  const dirtyNames = (dirtyItems ?? []).filter((item) => item.dirty).map((item) => item.name)

  return (
    <div className="update-overlay" ref={rootRef}>
      <div className="update-backdrop" data-update-backdrop onClick={requestClose} />
      <div
        className="update-modal"
        data-update-modal
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
      >
        <header className="update-header" data-update-header>
          <span className="update-app-mark" aria-hidden="true">◆</span>
          <div className="update-title-meta">
            <h2 id="update-dialog-title">{t('update.dialog.title')}</h2>
            <p className="update-versions">
              <span className="update-version is-current">v{updateState?.currentVersion ?? '—'}</span>
              <span className="update-version-arrow" aria-hidden="true">→</span>
              <span className="update-version is-next">v{latestVersion ?? '—'}</span>
            </p>
          </div>
          <button className="update-close" type="button" onClick={requestClose} aria-label={t('update.dialog.close')}>
            ✕
          </button>
        </header>

        <div className="update-body" data-update-body>
          <h3 className="update-notes-title">{t('update.dialog.notesTitle')}</h3>
          {notes ? (
            <div className="update-notes">
              <MarkdownView source={notes} />
            </div>
          ) : (
            <p className="update-notes-empty">
              {t('update.dialog.notesEmpty')}
              <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                {t('update.dialog.releaseLink')}
              </a>
            </p>
          )}
        </div>

        <div className="update-status" data-update-status>
          {status === 'downloading' && (
            <div className="update-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              <div className="update-progress-track">
                <div className="update-progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="update-progress-label">{progress}%</span>
            </div>
          )}
          {status === 'downloaded' &&
            (dirtyCount > 0 ? (
              <p className="update-dirty">
                <span className="update-dirty-mark" aria-hidden="true">⚠</span>
                <span className="update-dirty-body">
                  {t('update.dialog.dirtyWarning', { count: String(dirtyCount) })}
                  {dirtyNames.length > 0 && (
                    <span className="update-dirty-names" title={dirtyNames.join('、')}>
                      {dirtyNames.join('、')}
                    </span>
                  )}
                </span>
              </p>
            ) : dirtyItems !== null ? (
              <p className="update-dirty is-ok">
                <span className="update-dirty-mark" aria-hidden="true">✓</span>
                <span className="update-dirty-body">{t('update.dialog.allSynced')}</span>
              </p>
            ) : null)}
          {status === 'error' && updateState?.error && (
            <p className="update-error">{t('update.dialog.error', { message: updateState.error })}</p>
          )}
        </div>

        <footer className="update-actions" data-update-actions>
          <button className="btn btn-ghost" type="button" onClick={requestClose} disabled={saving}>
            {t('update.dialog.later')}
          </button>
          {status === 'available' && (
            <button className="btn btn-primary" type="button" onClick={handleDownload}>
              {t('update.dialog.download')}
            </button>
          )}
          {status === 'downloading' && (
            <button className="btn btn-primary" type="button" disabled>
              {t('update.dialog.downloading', { progress: String(progress) })}
            </button>
          )}
          {status === 'downloaded' && (
            <button className="btn btn-primary" type="button" onClick={handleRestart} disabled={saving}>
              {saving ? t('update.dialog.saving') : t('update.dialog.restart')}
            </button>
          )}
          {status === 'error' && (
            <button className="btn btn-primary" type="button" onClick={handleRetry}>
              {t('update.dialog.retry')}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
