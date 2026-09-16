/**
 * StatsPill — Hero 顶部统计胶囊
 * 展示插件总数与「UPDATED JUST NOW」状态文案（装饰性）。
 * 由 MarketPage Hero 使用；无 store 依赖，仅接收 count。
 */
interface Props {
  count: number
}

export function StatsPill({ count }: Props) {
  return (
    <div className="stats-pill">
      <span className="dot" />
      <span>{count}</span> PLUGINS
      <span className="sep" />
      UPDATED JUST NOW
    </div>
  )
}
