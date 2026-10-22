/** 市场目录卡片：真实插件信息、安装/打开与已安装管理操作。 */
import { useRef, useState } from 'react'
import type { PluginPresentation } from './pluginPresentation'
import { useI18n } from '@renderer/hooks/useI18n'
import { ICON_STROKE_WIDTH, Trash2Icon } from '@renderer/components/icons'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { Switch } from '@renderer/components/ui/Switch'
import { formatPluginPackageSize } from './pluginPresentation'

export interface PluginCardViewProps {
  plugin: PluginPresentation
  onOpen: (id: string) => void
  onDetail?: (id: string, origin?: HTMLElement | null) => void
  onUninstall?: (id: string) => Promise<void>
  onSetEnabled?: (id: string, enabled: boolean) => Promise<void>
}

export function PluginCardView({ plugin, onOpen, onDetail, onUninstall, onSetEnabled }: PluginCardViewProps) {
  const cardRef = useRef<HTMLElement>(null)
  const { t, locale } = useI18n()
  const [uninstalling, setUninstalling] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [error, setError] = useState('')
  const disabled = plugin.installed && plugin.enabled === false
  const enabled = plugin.installed && !disabled
  const busy = uninstalling || toggling
  const detailsLabel = `${plugin.name} · ${t('plugin.detail')}`
  const packageSize = formatPluginPackageSize(plugin.packageSize)
  const tags = plugin.tags?.slice(0, 3) ?? []

  const handleDetail = () => {
    if (busy) return
    if (onDetail) onDetail(plugin.id, cardRef.current)
    else if (!disabled) onOpen(plugin.id)
  }

  const handleAction = () => {
    if (busy) return
    if (plugin.installed && !disabled) onOpen(plugin.id)
    else handleDetail()
  }

  const handleUninstall = async () => {
    if (busy || !onUninstall) return
    setUninstalling(true)
    setError('')
    try { await onUninstall(plugin.id) }
    catch (error) { setError(error instanceof Error ? error.message : t('plugin.uninstall')) }
    finally { setUninstalling(false) }
  }

  const handleToggleEnabled = async () => {
    if (busy || !onSetEnabled) return
    setToggling(true)
    setError('')
    try { await onSetEnabled(plugin.id, disabled) }
    catch (error) { setError(t('plugin.enableFailed', { error: error instanceof Error ? error.message : String(error) })) }
    finally { setToggling(false) }
  }

  const actionLabel = plugin.installed
    ? disabled
      ? t('plugin.detail')
      : t('plugin.open')
    : t('plugin.install')

  return (
    <article
      ref={cardRef}
      className={`card${disabled ? ' is-disabled' : ''}`}
      data-plugin-card=""
      data-plugin-id={plugin.id}
      aria-busy={busy}
      onClick={(event) => {
        // 内部控件各自处理动作；卡片留白和描述遵循主操作。
        if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return
        handleAction()
      }}
    >
      {plugin.installed ? (
        <button
          type="button"
          className="card-uninstall-corner"
          disabled={busy || !onUninstall}
          title={uninstalling ? t('plugin.uninstalling') : t('plugin.uninstall')}
          aria-label={`${plugin.name} · ${uninstalling ? t('plugin.uninstalling') : t('plugin.uninstall')}`}
          onClick={() => void handleUninstall()}
        >
          {uninstalling ? (
            <span className="card-uninstall-dots" aria-hidden>…</span>
          ) : (
            <Trash2Icon size={13} />
          )}
        </button>
      ) : null}

      <div className="card-body">
        <div className="card-head">
          <div className="card-icon-rail">
            <PluginIcon
              className="card-icon"
              src={plugin.icon}
              glyph={plugin.glyph}
              slot="card"
              alt={plugin.name}
            />
          </div>
          <div className="card-title">
            <div className="card-title-row">
              <h3>
                <button
                  type="button"
                  className="card-detail-trigger"
                  title={detailsLabel}
                  aria-label={detailsLabel}
                  disabled={busy || (disabled && !onDetail)}
                  onClick={handleDetail}
                >
                  {plugin.name}
                </button>
              </h3>
            </div>
            {plugin.author && <span className="card-author" title={plugin.author}>{plugin.author}</span>}
          </div>
        </div>
        <p className="card-description" title={plugin.description}>{plugin.description}</p>
        {tags.length > 0 && <div className="card-tags" aria-label={locale === 'en-US' ? 'Plugin tags' : '插件标签'}>
          {tags.map((tag) => <span key={tag} title={tag}>{tag}</span>)}
        </div>}

        {error && <p className="card-action-error" role="alert">{error}</p>}
        <div className="card-actions">
          <span className="card-catalog-meta">
            <span title={`v${plugin.version}`}>v{plugin.version}</span>
            <span title={t('plugin.packageSize', { size: packageSize ?? t('plugin.unknownSize') })}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={ICON_STROKE_WIDTH} strokeLinecap="round" strokeLinejoin="round"
                aria-hidden="true" focusable="false" style={{ verticalAlign: 'text-bottom', marginRight: 4 }}>
                <path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z" />
                <path d="m3 7.5 9 4.5 9-4.5M12 12v9M7.5 5.25l9 4.5" />
              </svg>
              {packageSize ?? '—'}
            </span>
          </span>
          <span className="card-switch-slot">
            {plugin.installed && (
              <Switch
                checked={enabled}
                aria-label={`${plugin.name} · ${disabled ? t('plugin.enable') : t('plugin.disable')}`}
                aria-busy={toggling}
                title={disabled ? t('plugin.enable') : t('plugin.disable')}
                className="card-switch"
                disabled={busy || !onSetEnabled}
                onCheckedChange={() => void handleToggleEnabled()}
              />
            )}
          </span>
          <button type="button" className="btn btn-sm btn-primary"
            disabled={busy || (disabled && !onDetail)} onClick={handleAction}>
            {actionLabel}
          </button>
        </div>
      </div>
    </article>
  )
}
