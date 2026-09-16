/**
 * StatsPill — Hero 顶部统计胶囊
 * 展示插件总数与「刚刚更新」状态文案（装饰性）。
 * 由 MarketPage Hero 使用；文案走 useI18n。
 * 依赖：useI18n。
 */
import { useI18n } from '@renderer/hooks/useI18n'

interface Props {
  count: number
}

export function StatsPill({ count }: Props) {
  const { t } = useI18n()
  return (
    <div className="stats-pill">
      <span className="dot" />
      <span>{t('market.statsPlugins', { n: count })}</span>
      <span className="sep" />
      <span>{t('market.updatedJustNow')}</span>
    </div>
  )
}
