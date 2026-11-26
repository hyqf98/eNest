import type { CSSProperties, ReactNode } from 'react'
import type { QuickPluginPresentation } from '@shared/types/quick'
import { PluginIcon } from './PluginIcon'

interface Props {
  plugin: QuickPluginPresentation
  gripIcon?: string
  className: string
  style?: CSSProperties
  onDetach(): void
  children?: ReactNode
}

export function QuickPluginGrip({ plugin, gripIcon, className, style, onDetach, children }: Props) {
  return <button type="button" className={`plugin-grip ${className}`} style={style} data-quick-native-drag
    title={`拖出「${plugin.title}」成为独立窗口；点击也可分离`} aria-label={`将${plugin.title}独立显示`} onClick={onDetach}>
    <span className="plugin-grip-icon" aria-hidden="true"><PluginIcon slot="tab" size={20} src={gripIcon} fallbackSrc={plugin.icon} glyph={plugin.glyph || '⌥'} /></span>
    {children}
  </button>
}
