import type { PluginSummary } from '@shared/types/plugin'
import { PluginCard } from './PluginCard'
import { MarketCategoryView } from './MarketCategoryView'

interface Props {
  category: string
  plugins: PluginSummary[]
  onOpen: (id: string) => void
  onDetail: (id: string, origin?: HTMLElement | null) => void
}

export function MarketCategorySection({ category, plugins, onOpen, onDetail }: Props) {
  return <MarketCategoryView category={category} plugins={plugins} renderPlugin={plugin =>
    <PluginCard plugin={plugin} onOpen={onOpen} onDetail={onDetail} />} />
}
