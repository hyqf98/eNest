import type { ReactNode } from 'react'
import { PluginIcon } from '@renderer/components/PluginIcon'
import type { PluginSummary } from '@shared/types/plugin'

type PluginIdentity = Pick<PluginSummary, 'id' | 'name'> & Partial<Pick<PluginSummary, 'icon' | 'glyph'>>

interface Props {
  plugin: PluginIdentity
  detail: ReactNode
  as?: 'div' | 'summary' | 'label' | 'li'
  leading?: ReactNode
  running?: boolean
  /** 登记还在但已无法加载（目录被移走 / 清单读不出 / id 变了）：整行弱化，只保留调用方给出的操作。 */
  unavailable?: boolean
  badges?: ReactNode
  children?: ReactNode
}

export function SettingsPluginRow({ plugin, detail, as: Row = 'div', leading, running, unavailable, badges, children }: Props) {
  const name = plugin.name.trim() || plugin.id
  return (
    <Row
      className={`dev-plugin-item${running ? ' running' : ''}${unavailable ? ' unavailable' : ''}`}
      aria-disabled={unavailable || undefined}
    >
      {leading}
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
