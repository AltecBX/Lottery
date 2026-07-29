import type { ReactNode } from 'react'

export function Ball({ n, size = 'md', variant = '', title }: { n: number; size?: 'hero' | 'md' | 'sm'; variant?: string; title?: string }) {
  return (
    <span className={`ball ${size} ${variant}`} title={title}>
      {n}
    </span>
  )
}

export function SectionCard({ id, title, hint, sub, children, className = '', headExtra }: {
  id?: string
  title: string
  hint?: string
  sub?: ReactNode
  children: ReactNode
  className?: string
  headExtra?: ReactNode
}) {
  return (
    <section id={id} className={`card section-anchor ${className}`}>
      <div className="card-head">
        <h2>{title}</h2>
        {hint && <span className="hint">{hint}</span>}
        {headExtra && <span className="spacer">{headExtra}</span>}
      </div>
      {sub && <p className="card-sub">{sub}</p>}
      {children}
    </section>
  )
}

export function Tile({ label, value, delta, deltaDir }: { label: string; value: ReactNode; delta?: ReactNode; deltaDir?: 'up' | 'down' | 'flat' }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {delta && <div className={`delta ${deltaDir === 'up' ? 'up' : deltaDir === 'down' ? 'down' : ''}`}>{delta}</div>}
    </div>
  )
}

export const fmtPct = (x: number, digits = 1) => `${(100 * x).toFixed(digits)}%`
export const fmtNum = (x: number, digits = 2) => x.toFixed(digits)

/** Rolling mean over a window (for accuracy-over-time smoothing). */
export function rollingMean(values: number[], window: number): number[] {
  const out: number[] = []
  let acc = 0
  for (let i = 0; i < values.length; i++) {
    acc += values[i]
    if (i >= window) acc -= values[i - window]
    out.push(acc / Math.min(i + 1, window))
  }
  return out
}
