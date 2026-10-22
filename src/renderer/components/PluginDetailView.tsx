/** Original detail presentation. Side effects are supplied by the active surface. */
import type { ReactNode, RefObject } from 'react'
import type { PluginPermission } from '@shared/types/plugin'
import type { PluginPresentation } from './pluginPresentation'
import { useI18n } from '@renderer/hooks/useI18n'
import { MarkdownView } from './MarkdownView'
import { PluginScreenshotGallery } from './PluginScreenshotGallery'
import { PluginIcon } from './PluginIcon'

export interface PluginDetailViewProps {
  plugin: PluginPresentation
  rootRef: RefObject<HTMLDivElement>
  requestClose: () => void
  status: 'loading' | 'ok' | 'empty' | 'error'
  readme: string
  busy: boolean
  disabled: boolean
  uninstalling?: boolean
  installing?: boolean
  toggling?: boolean
  resettingPermissions?: boolean
  deniedPermissions?: PluginPermission[]
  actionLabel: string
  actionError?: string | null
  handlePrimary: () => void | Promise<void>
  handleUpdate: () => void | Promise<void>
  handleToggleEnabled: () => void | Promise<void>
  handleResetPermissions?: () => void | Promise<void>
  handleUninstall: () => void | Promise<void>
  launchControls?: ReactNode
  disableReadmeLinks?: boolean
}

export function PluginDetailView({ plugin, rootRef, requestClose, status, readme, busy, disabled,
  uninstalling = false, installing = false, toggling = false, resettingPermissions = false,
  deniedPermissions = [], actionLabel, actionError, handlePrimary, handleUpdate, handleToggleEnabled,
  handleResetPermissions, handleUninstall, launchControls, disableReadmeLinks = false }: PluginDetailViewProps) {
  const { t } = useI18n()
  const enabled = !disabled
  const updateVersion = plugin.latestVersion
  return (
    <div className="detail-overlay" ref={rootRef} role="presentation">
      <div
        className="detail-backdrop"
        data-detail-backdrop
        onClick={requestClose}
        aria-hidden="true"
      />
      <div
        className="detail-modal"
        data-detail-modal
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="plugin-detail-title"
      >
        <header className="detail-header" data-detail-header>
          <div data-detail-icon style={disabled ? { opacity: 0.6 } : undefined}>
            <PluginIcon className="detail-icon" src={plugin.icon} glyph={plugin.glyph} alt={plugin.name} />
          </div>
          <div className="detail-meta" data-detail-meta>
            <h2 id="plugin-detail-title">{plugin.name}</h2>
            <div className="detail-sub">
              {plugin.author} · v{plugin.version}
              {updateVersion ? ` · ${t('plugin.updateAvailable', { version: updateVersion })}` : ''}
            </div>
            <div className="detail-chips" data-detail-chips>
              <span className="detail-chip">{plugin.category}</span>
              {plugin.installed ? (
                <span className="detail-chip ok">
                  {disabled ? t('plugin.disabled') : t('plugin.installed')}
                </span>
              ) : null}

            </div>
          </div>
          <div className="detail-actions" data-detail-actions>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handlePrimary()}
              disabled={busy || disabled}
            >
              {actionLabel}
            </button>
            {plugin.installed && updateVersion && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleUpdate()}
                disabled={busy}
              >
                {installing ? t('plugin.updating') : t('plugin.update')}
              </button>
            )}
            {plugin.installed && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void handleToggleEnabled()}
                disabled={busy}
              >
                {toggling ? t('common.loading') : enabled ? t('plugin.disable') : t('plugin.enable')}
              </button>
            )}
            {plugin.installed && handleResetPermissions && (deniedPermissions.length > 0 || resettingPermissions) && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void handleResetPermissions()}
                disabled={busy}
                aria-busy={resettingPermissions}
                title="恢复已拒绝的授权，下次使用时重新询问"
              >
                {resettingPermissions ? '正在恢复…' : '重新授权'}
              </button>
            )}
            {plugin.installed && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void handleUninstall()}
                disabled={busy}
              >
                {uninstalling ? t('plugin.uninstalling') : t('plugin.uninstall')}
              </button>
            )}
            <button type="button" className="btn btn-ghost" data-detail-close onClick={requestClose} disabled={uninstalling}>
              {t('plugin.close')}
            </button>
          </div>
        </header>

        <div className="detail-body" data-detail-body>
          {actionError && <p className="detail-action-error" role="alert">{actionError}</p>}
          <PluginScreenshotGallery key={plugin.id} name={plugin.name} screenshots={plugin.screenshots} />
          {launchControls}

          {status === 'loading' && (
            <div className="detail-state">
              <div className="detail-spinner" aria-hidden="true" />
              <span>正在加载说明文档…</span>
            </div>
          )}
          {status === 'empty' && (
            <div className="detail-state">
              <strong>暂无说明文档</strong>
              <span>该插件尚未提供 README，可直接安装体验。</span>
            </div>
          )}
          {status === 'error' && (
            <div className="detail-state">
              <strong>加载失败</strong>
              <span>说明文档读取出错，请稍后重试。</span>
            </div>
          )}
          {status === 'ok' && <MarkdownView source={readme} baseUrl={plugin.readmeUrl} imageMap={plugin.readmeImages} omitImages={plugin.screenshots} disableLinks={disableReadmeLinks} />}
        </div>
      </div>
    </div>
  )
}
