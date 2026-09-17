/**
 * PluginCard — 市场网格中的插件卡片
 * 图标为品牌色圆角方块 + 居中 glyph；展示名称、描述（2 行截断）、分类/安装量。
 * 整卡与底部主按钮：已安装 → onOpen 启动；未安装 → onDetail 详情（无 onDetail 时回落 onOpen 安装）。
 * 已安装时额外提供「启用/禁用」切换与「卸载」：禁用时打开按钮变灰；
 * 卸载二次确认后 shellApi.uninstallPlugin，列表经 uninstall-result 刷新。
 * 由 MarketPage 网格渲染；插件数据来自 shellStore.plugins。
 * 依赖：useI18n、shellApi。
 */
import { useState } from 'react'
import type { CSSProperties, MouseEvent } from 'react'
import type { PluginSummary } from '@shared/types/plugin'
import { useI18n } from '@renderer/hooks/useI18n'
import { shellApi } from '@renderer/services/shellApi'

/** 品牌色微渐变 + 柔和阴影（避免过重的粗渐变） */
function iconStyle(p: PluginSummary): CSSProperties {
  return {
    background: `linear-gradient(160deg, color-mix(in srgb, ${p.color} 88%, #fff) 0%, ${p.color} 52%, color-mix(in srgb, ${p.color} 72%, #000) 100%)`,
    boxShadow: `0 2px 8px color-mix(in srgb, ${p.color} 30%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 22%, transparent)`,
  }
}

interface Props {
  plugin: PluginSummary
  /** 已安装且启用时启动插件（整卡 / 按钮） */
  onOpen: (id: string) => void
  /** 未安装时打开详情；未提供时整卡/按钮回落 onOpen */
  onDetail?: (id: string) => void
}

export function PluginCard({ plugin, onOpen, onDetail }: Props) {
  const { t } = useI18n()
  const [uninstalling, setUninstalling] = useState(false)
  const [toggling, setToggling] = useState(false)
  const disabled = plugin.installed && plugin.enabled === false

  const act = () => {
    if (uninstalling || toggling) return
    if (plugin.installed) {
      if (disabled) return
      onOpen(plugin.id)
      return
    }
    if (onDetail) onDetail(plugin.id)
    else onOpen(plugin.id)
  }

  const handleCard = () => act()

  const handleAction = (e: MouseEvent) => {
    e.stopPropagation()
    act()
  }

  /** 二次确认后卸载；成功/失败 toast 与列表刷新由 uninstall-result 事件处理 */
  const handleUninstall = async (e: MouseEvent) => {
    e.stopPropagation()
    if (uninstalling || !shellApi.uninstallPlugin) return
    if (!window.confirm(t('plugin.uninstallConfirm', { name: plugin.name }))) return
    setUninstalling(true)
    try {
      await shellApi.uninstallPlugin(plugin.id)
    } catch {
      setUninstalling(false)
    }
  }

  /** 启用/禁用切换；成功后 plugins-changed 刷新列表 */
  const handleToggleEnabled = async (e: MouseEvent) => {
    e.stopPropagation()
    if (toggling || !shellApi.setPluginEnabled) return
    setToggling(true)
    try {
      await shellApi.setPluginEnabled(plugin.id, disabled)
    } catch {
      /* 失败保持原状；toast 由调用方可扩展 */
    } finally {
      setToggling(false)
    }
  }

  const actionLabel = plugin.installed
    ? disabled
      ? t('plugin.disabled')
      : t('plugin.open')
    : onDetail
      ? t('plugin.detail')
      : t('plugin.install')

  return (
    <article
      className="card"
      onClick={handleCard}
      style={disabled ? { opacity: 0.72 } : undefined}
    >
      {plugin.installed ? (
        <span
          className="badge-installed"
          style={disabled ? { background: 'var(--chip-bg, rgba(128,128,128,.18))', color: 'var(--text-dim, #888)' } : undefined}
        >
          {disabled ? t('plugin.disabled') : t('plugin.installed')}
        </span>
      ) : null}
      <div className={plugin.installed ? 'card-head has-badge' : 'card-head'}>
        <div className="card-icon" style={iconStyle(plugin)} aria-hidden="true">
          {plugin.glyph}
        </div>
        <h3>{plugin.name}</h3>
        <span className="arrow" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M7 17 17 7M9 7h8v8" />
          </svg>
        </span>
      </div>
      <p>{plugin.description}</p>
      <div className="card-foot">
        <span className="tag">{plugin.category}</span>
        <span className="installs">{plugin.installs}</span>
        {plugin.installed && (
          <button
            type="button"
            className="tag"
            style={{ cursor: toggling ? 'wait' : 'pointer', border: 'none' }}
            disabled={toggling || uninstalling}
            onClick={(e) => void handleToggleEnabled(e)}
            title={disabled ? t('plugin.enable') : t('plugin.disable')}
          >
            {toggling ? '…' : disabled ? t('plugin.enable') : t('plugin.disable')}
          </button>
        )}
        {plugin.installed && (
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={uninstalling}
            onClick={(e) => void handleUninstall(e)}
          >
            {uninstalling ? t('plugin.uninstalling') : t('plugin.uninstall')}
          </button>
        )}
        <button
          type="button"
          className={`btn btn-sm ${plugin.installed && !disabled ? 'btn-ghost' : 'btn-primary'}`}
          disabled={uninstalling || toggling || disabled}
          onClick={handleAction}
        >
          {actionLabel}
        </button>
      </div>
    </article>
  )
}
