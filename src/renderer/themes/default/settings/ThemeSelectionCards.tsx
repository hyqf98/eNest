import type { CSSProperties } from 'react'
import type { AppearanceColorMode, ThemeIdentity, ThemePackV2 } from '@shared/types/appearance'
import { themeProfileKey } from '@shared/theme/appearance'
import { Button } from '@renderer/components/ui/Button'
import './appearanceSettings.css'

interface ThemeSelectionCardsProps {
  packs: ThemePackV2[]
  selected: ThemeIdentity | null
  mode: AppearanceColorMode
  pendingKey?: string | null
  disabled?: boolean
  onSelect: (identity: ThemeIdentity) => void
}

const bounded = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value))

/** A host-rendered summary of the public design contract, never theme-specific HTML. */
function ThemePreview({ pack, mode }: { pack: ThemePackV2; mode: AppearanceColorMode }) {
  const { tokens, layout, components, fonts } = pack.variants[mode]
  const columns = Math.round(bounded(layout.columns, 1, 6))
  const style = {
    '--preview-bg': tokens['--bg'],
    '--preview-surface': tokens['--surface'],
    '--preview-accent': tokens['--accent'],
    '--preview-text': tokens['--text'],
    '--preview-muted': tokens['--surface-3'],
    '--preview-columns': columns,
    '--preview-gap': `${bounded(layout.gap / 3, 3, 10)}px`,
    '--preview-sidebar': `${bounded(layout.sidebarWidth / layout.contentWidth * 100, 12, 30)}%`,
    '--preview-control-radius': `${bounded(components.controlRadius / 2, 0, 8)}px`,
    '--preview-card-radius': `${bounded(components.cardRadius / 2, 0, 12)}px`,
    '--preview-border-width': `${bounded(components.borderWidth, 0, 2)}px`,
    '--preview-padding': `${bounded(10 * layout.density, 6, 16)}px`,
    '--preview-font': fonts.heading,
  } as CSSProperties

  return (
    <span className="appearance-preview" data-tab-style={layout.tabStyle ?? 'classic'} style={style} aria-hidden="true">
      <span className="appearance-preview-nav"><i /><i /><i /></span>
      <span className="appearance-preview-search"><i /></span>
      <span className="appearance-preview-feature"><strong>eNest</strong><i /></span>
      <span className="appearance-preview-grid">{Array.from({ length: columns * 2 }, (_, index) => <i key={index}><b /><span /></i>)}</span>
      <span className="appearance-preview-aside"><i /><i /><i /></span>
    </span>
  )
}

/** Host-rendered switcher: every installed theme pack, built in or installed by a plugin. */
export function ThemeSelectionCards({ packs, selected, mode, pendingKey, disabled, onSelect }: ThemeSelectionCardsProps) {
  const selectedKey = selected ? themeProfileKey(selected) : null
  return (
    <div className="appearance-themes" role="group" aria-label="主题选择">
      {packs.map(pack => {
        const key = themeProfileKey(pack)
        const active = key === selectedKey
        const pending = pendingKey === key
        return (
          <Button
            key={key}
            className={`appearance-theme-card${active ? ' is-active' : ''}`}
            data-theme-source={pack.source}
            data-theme-id={pack.id}
            aria-pressed={active}
            aria-label={`${pack.name}${active ? '，已选主题' : ''}`}
            disabled={disabled}
            onClick={() => onSelect({ source: pack.source, id: pack.id })}
          >
            <span className="appearance-theme-preview">
              <ThemePreview pack={pack} mode={mode} />
              <span className="appearance-theme-check" aria-hidden="true">{active ? '✓' : ''}</span>
            </span>
            <span className="appearance-theme-label">
              <strong>{pack.name}</strong>
              <span className={pending ? 'is-pending' : undefined}>{pending ? '切换中…' : active ? '使用中' : pack.source === 'enest.builtin' ? '内置' : '插件'}</span>
            </span>
            {pack.description && <span className="appearance-theme-description">{pack.description}</span>}
          </Button>
        )
      })}
    </div>
  )
}
