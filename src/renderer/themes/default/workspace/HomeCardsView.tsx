import { memo, useMemo, useRef, useState } from 'react'
import type { HomeCatalogItem } from '@shared/types/home'
import { Button } from '@renderer/components/ui/Button'
import { useI18n } from '@renderer/hooks/useI18n'
import './homeCards.css'

interface HomeCardsViewProps {
  items: HomeCatalogItem[]
  onOpen: (pluginId: string, cardId: string) => Promise<void>
  onError: (error: unknown) => void
}

export const HomeCardsView = memo(function HomeCardsView({ items, onOpen, onError }: HomeCardsViewProps) {
  const { locale } = useI18n()
  const english = locale === 'en-US'
  const cards = useMemo(() => items.flatMap(plugin => plugin.installed && plugin.enabled !== false
    ? (plugin.homeCards ?? []).map(card => ({ ...card, pluginId: plugin.pluginId, pluginName: plugin.name })) : []), [items])
  const pending = useRef(false)
  const [opening, setOpening] = useState<string | null>(null)
  const open = async (pluginId: string, cardId: string) => {
    if (pending.current) return
    pending.current = true
    setOpening(JSON.stringify([pluginId, cardId]))
    try { await onOpen(pluginId, cardId) }
    catch (error) { onError(error) }
    finally { pending.current = false; setOpening(null) }
  }
  if (!cards.length) return null
  return <section className="market-extensions" aria-label={english ? 'Plugin extensions' : '插件扩展'}>
    <div className="section-head contrib-head"><h2>{english ? 'Plugin extensions' : '插件扩展'}</h2></div>
    <div className="grid contrib-grid">
      {cards.map(card => {
        const key = JSON.stringify([card.pluginId, card.id])
        const busy = opening === key
        return <Button key={key} className="card contrib-card" disabled={opening !== null} aria-busy={busy}
          onClick={() => void open(card.pluginId, card.id)} title={card.explain || card.pluginName}>
          <span className="contrib-glyph" aria-hidden="true" style={card.color ? { color: card.color } : undefined}>
            {Array.from(card.glyph || card.title.trim())[0]?.toLocaleUpperCase()}
          </span>
          <span className="contrib-body">
            <strong className="contrib-title">{card.title}</strong>
            {card.explain && <span className="contrib-explain">{card.explain}</span>}
            <span className="contrib-source">{busy ? english ? 'Opening…' : '正在打开…' : card.pluginName}</span>
          </span>
        </Button>
      })}
    </div>
  </section>
})
