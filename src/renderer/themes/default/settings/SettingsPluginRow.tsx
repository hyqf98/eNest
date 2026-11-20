import type { ReactNode } from 'react'
import { PluginIcon } from '@renderer/components/PluginIcon'
import type { PluginSummary } from '@shared/types/plugin'

type PluginIdentity = Pick<PluginSummary, 'id' | 'name'> & Partial<Pick<PluginSummary, 'icon' | 'glyph'>>

interface Props {
  plugin: PluginIdentity
  detail: ReactNode
  as?: 'div' | 'summary'
  running?: boolean
  badges?: ReactNode
  children?: ReactNode
}

export function SettingsPluginRow({ plugin, detail, as: Row = 'div', running, badges, children }: Props) {
  const name = plugin.name.trim() || plugin.id
  return (
    <Row className={`dev-plugin-item${running ? ' running' : ''}`}>
      <PluginIcon src={plugin.icon?.trim() || undefined} glyph={plugin.glyph?.trim() || Array.from(name)[0] || '?'} size={40} />
      <span className="dev-plugin-meta">
        <span className="dev-plugin-name">
          {name}
          {running && <span className="dev-run-dot" aria-hidden="true" />}
          {badges}
        </span>
        <code className="dev-plugin-path">{detail}</code>
      </span>
      {children}
    </Row>
  )
}
