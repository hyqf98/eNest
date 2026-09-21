/**
 * PluginCard — 市场网格中的插件卡片
 * 头：图标 + 名称/分类小 tag；描述；底部操作。
 * 已安装：启用开关 + 卸载（danger 软底）+ 打开。
 *
 * 动效（motion-web / data-anim 三档）：
 * - 结构暴露 data-plugin-card / data-installed / data-disabled / data-depth / data-actions
 * - --pc 为插件主色，供边框 accent 与指针径向高光 color-mix
 * - high：pointer 驱动 --mx/--my 与 --rx/--ry（≤8deg），CSS 负责 hover/press；不引入 GSAP
 * - 业务 onOpen/onDetail/uninstall/toggle 逻辑不变
 */
import { useCallback, useState } from 'react'
import type { CSSProperties, MouseEvent, PointerEvent } from 'react'
import type { PluginSummary } from '@shared/types/plugin'
import { PLUGIN_ICON_DISPLAY_CARD } from '@shared/constants'
import { useI18n } from '@renderer/hooks/useI18n'
import { useAnimationLevelStore } from '@renderer/hooks/useAnimationLevel'
import { shellApi } from '@renderer/services/shellApi'
import { Trash2Icon } from '@renderer/components/icons'
import { PluginIcon } from '@renderer/components/PluginIcon'

/** high 档 pointer tilt 上限（deg）；CSS 负责 perspective 与阴影 */
const MAX_TILT_DEG = 8

/** 卡片 style：业务色 + 动效 CSS 变量（由 high 档 pointer 写入） */
type CardStyle = CSSProperties & {
  '--pc'?: string
}

function iconBackground(p: PluginSummary): string {
  return `linear-gradient(160deg, color-mix(in srgb, ${p.color} 88%, #fff) 0%, ${p.color} 52%, color-mix(in srgb, ${p.color} 72%, #000) 100%)`
}

function isHighAnim(): boolean {
  return useAnimationLevelStore.getState().level === 'high'
}

/** high：指针位置 → 高光坐标 + tilt 角 + 阴影偏移（光源左上） */
function writeTiltVars(el: HTMLElement, nx: number, ny: number): void {
  const rx = (0.5 - ny) * 2 * MAX_TILT_DEG
  const ry = (nx - 0.5) * 2 * MAX_TILT_DEG
  el.style.setProperty('--mx', `${(nx * 100).toFixed(2)}%`)
  el.style.setProperty('--my', `${(ny * 100).toFixed(2)}%`)
  el.style.setProperty('--rx', `${rx.toFixed(2)}deg`)
  el.style.setProperty('--ry', `${ry.toFixed(2)}deg`)
  el.style.setProperty('--rxn', rx.toFixed(2))
  el.style.setProperty('--ryn', ry.toFixed(2))
  // 光源左上：近侧抬高时阴影向右下偏移
  el.style.setProperty('--sh-x', `${(-1 + ry * 0.55).toFixed(2)}px`)
  el.style.setProperty('--sh-y', `${(6 + rx * 0.4).toFixed(2)}px`)
  el.dataset.tilt = 'on'
}

function resetTiltVars(el: HTMLElement): void {
  el.style.setProperty('--mx', '50%')
  el.style.setProperty('--my', '50%')
  el.style.setProperty('--rx', '0deg')
  el.style.setProperty('--ry', '0deg')
  el.style.setProperty('--rxn', '0')
  el.style.setProperty('--ryn', '0')
  el.style.setProperty('--sh-x', '0px')
  el.style.setProperty('--sh-y', '6px')
  el.dataset.tilt = 'off'
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

  /** high：pointer 驱动 tilt / 高光；控件上不改 tilt，避免与按钮 hover 抢戏 */
  const handlePointerMove = useCallback((e: PointerEvent<HTMLElement>) => {
    if (!isHighAnim()) return
    const el = e.currentTarget
    if (el.classList.contains('is-disabled')) {
      resetTiltVars(el)
      return
    }
    const target = e.target as HTMLElement | null
    if (target?.closest('button, a, input, select, textarea, label')) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const nx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const ny = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    writeTiltVars(el, nx, ny)
  }, [])

  const handlePointerLeave = useCallback((e: PointerEvent<HTMLElement>) => {
    resetTiltVars(e.currentTarget)
  }, [])

  const cardStyle: CardStyle = { '--pc': plugin.color }

  return (
    <article
      className={`card${disabled ? ' is-disabled' : ''}`}
      data-plugin-card=""
      data-installed={plugin.installed ? 'true' : 'false'}
      data-disabled={disabled ? 'true' : 'false'}
      style={cardStyle}
      onClick={handleCard}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
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
          {/* 图标深度层：high 反向 parallax；box-shadow 走 CSS var(--pc)，不再 inline 写死 */}
          <div className="card-icon-rail" data-depth="icon">
            <PluginIcon
              className="card-icon"
              src={plugin.icon}
              glyph={plugin.glyph}
              slot="card"
              size={PLUGIN_ICON_DISPLAY_CARD}
              alt={plugin.name}
              style={{ background: iconBackground(plugin) }}
            />
          </div>
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

        <div className="card-actions" data-actions>
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
