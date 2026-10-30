export function Field({
  label,
  desc,
  children,
}: {
  label: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className="field">
      <div>
        <div className="label">{label}</div>
        {desc ? <p className="desc">{desc}</p> : null}
      </div>
      {children}
    </div>
  )
}

export function Card({ title, hint, children, className }: { title: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`s-card${className ? ` ${className}` : ''}`}>
      <h2>{title}</h2>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </div>
  )
}
