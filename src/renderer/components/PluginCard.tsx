/**
 * PluginCard — 市场网格中的插件卡片
 * 头：图标 + 名称/分类小 tag；描述；底部操作。
 * 已安装：启用开关 + 卸载（danger 软底）+ 打开。
 */
import { useState } from 'react'
import type { MouseEvent } from 'react'
import type { PluginSummary } from '@shared/types/plugin'
import { PLUGIN_ICON_DISPLAY_CARD } from '@shared/constants'
import { useI18n } from '@renderer/hooks/useI18n'
import { shellApi } from '@renderer/services/shellApi'
import { Trash2Icon } from '@renderer/components/icons'
import { PluginIcon } from '@renderer/components/PluginIcon'

function iconBackground(p: PluginSummary): string {
  return `linear-gradient(160deg, color-mix(in srgb, ${p.color} 88%, #fff) 0%, ${p.color} 52%, color-mix(in srgb, ${p.color} 72%, #000) 100%)`
}

interface Props {
  plugin: PluginSummary
  onOpen: (id: string) => void
  onDetail?: (id: string) => void
}

export function PluginCard({ plugin, onOpen, onDetail }: Props) {
  const { t } = useI18n()
  const [uninstalling, setUninstalling] = useState(false)
  const [toggling, setToggling] = useState(false)
  const disabled = plugin.installed && plugin.enabled === false
  const enabled = plugin.installed && !disabled

  const handleCard = () => {
    if (uninstalling || toggling) return
    if (plugin.installed) {
      if (disabled) return
      onOpen(plugin.id)
      return
    }
    if (onDetail) onDetail(plugin.id)
    else onOpen(plugin.id)
  }

  const handleUninstall = async (e: MouseEvent) => {
    e.stopPropagation()
    if (uninstalling || !shellApi.uninstallPlugin) return
    if (!window.confirm(t('plugin.uninstallConfirm', { name: plugin.name }))) return
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

  const handleToggleEnabled = async (e: MouseEvent) => {
    e.stopPropagation()
    if (toggling || !shellApi.setPluginEnabled) return
    setToggling(true)
    try {
      await shellApi.setPluginEnabled(plugin.id, disabled)
    } catch {
      /* keep */
    } finally {
      setToggling(false)
    }
  }

  const actionLabel = plugin.installed
    ? disabled
      ? t('plugin.disabled')
      : t('plugin.open')
    : t('plugin.install')

  /** 主按钮：已安装打开插件；未安装与点卡片一致，打开详情 */
  const handleAction = (e: MouseEvent) => {
    e.stopPropagation()
    if (disabled || uninstalling || toggling) return
    if (plugin.installed) {
      onOpen(plugin.id)
      return
    }
    if (onDetail) onDetail(plugin.id)
    else onOpen(plugin.id)
  }

  return (
    <article
      className={`card${disabled ? ' is-disabled' : ''}`}
      onClick={handleCard}
    >
      {plugin.installed ? (
        <button
          type="button"
          className="card-uninstall-corner"
          disabled={uninstalling}
          title={uninstalling ? t('plugin.uninstalling') : t('plugin.uninstall')}
          aria-label={uninstalling ? t('plugin.uninstalling') : t('plugin.uninstall')}
          onClick={(e) => void handleUninstall(e)}
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
          <PluginIcon
            className="card-icon"
            src={plugin.icon}
            glyph={plugin.glyph}
            slot="card"
            size={PLUGIN_ICON_DISPLAY_CARD}
            alt={plugin.name}
            style={{
              background: iconBackground(plugin),
              boxShadow: `0 2px 8px color-mix(in srgb, ${plugin.color} 30%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 22%, transparent)`,
            }}
          />
          <div className="card-title">
            <div className="card-title-row">
              <h3 title={plugin.name}>{plugin.name}</h3>
              <span className="tag tag-cat" title={plugin.category}>
                {plugin.category}
              </span>
            </div>
          </div>
        </div>

        <p>{plugin.description}</p>

        <div className="card-actions">
          {plugin.installed ? (
            <>
              <label
                className="card-switch-wrap"
                title={disabled ? t('plugin.enable') : t('plugin.disable')}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={disabled ? t('plugin.enable') : t('plugin.disable')}
                  className={`card-switch${enabled ? ' on' : ''}`}
                  disabled={toggling || uninstalling}
                  onClick={(e) => void handleToggleEnabled(e)}
                />
              </label>
              <span className="card-actions-spacer" />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={uninstalling || toggling || disabled}
                onClick={handleAction}
              >
                {actionLabel}
              </button>
            </>
          ) : (
            <>
              <span className="card-actions-spacer" />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={uninstalling || toggling}
                onClick={handleAction}
              >
                {actionLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  )
}
