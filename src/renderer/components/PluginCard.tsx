/** 市场目录卡片：真实插件信息、安装/打开与已安装管理操作。 */
import { useRef, useState } from 'react'
import type { PluginSummary } from '@shared/types/plugin'
import { useI18n } from '@renderer/hooks/useI18n'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { confirmAction } from '@renderer/services/confirmAction'
import { Trash2Icon } from '@renderer/components/icons'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { formatPluginPackageSize } from './pluginPresentation'

interface Props {
  plugin: PluginSummary
  onOpen: (id: string) => void
  onDetail?: (id: string, origin?: HTMLElement | null) => void
}

export function PluginCard({ plugin, onOpen, onDetail }: Props) {
  const cardRef = useRef<HTMLElement>(null)
  const { t, locale } = useI18n()
  const [uninstalling, setUninstalling] = useState(false)
  const [toggling, setToggling] = useState(false)
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
    if (busy || !shellApi.uninstallPlugin) return
    if (!await confirmAction({ title: t('plugin.uninstall'), message: t('plugin.uninstallConfirm', { name: plugin.name }), confirmLabel: t('plugin.uninstall'), danger: true })) return
    setUninstalling(true)
    try {
      await shellApi.uninstallPlugin(plugin.id)
    } catch {
      /* 失败提示由 uninstall-result 事件覆盖 */
    } finally {
      // 成功后列表会刷新为未安装；必须复位，否则安装按钮一直 disabled 灰态
      setUninstalling(false)
    }
  }

  const handleToggleEnabled = async () => {
    if (busy || !shellApi.setPluginEnabled) return
    setToggling(true)
    try {
      await shellApi.setPluginEnabled(plugin.id, disabled)
    } catch (error) {
      notify.error(t('plugin.enableFailed', {
        error: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setToggling(false)
    }
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
          disabled={busy || !shellApi.uninstallPlugin}
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

        <div className="card-actions">
          <span className="card-catalog-meta">
            <span title={`v${plugin.version}`}>v{plugin.version}</span>
            {packageSize && <span title={locale === 'en-US' ? `Package size: ${packageSize}` : `安装包大小：${packageSize}`}>{packageSize}</span>}
          </span>
          <span className="card-switch-slot">
            {plugin.installed && (
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={`${plugin.name} · ${disabled ? t('plugin.enable') : t('plugin.disable')}`}
                aria-busy={toggling}
                title={disabled ? t('plugin.enable') : t('plugin.disable')}
                className={`card-switch${enabled ? ' on' : ''}`}
                disabled={busy || !shellApi.setPluginEnabled}
                onClick={() => void handleToggleEnabled()}
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
