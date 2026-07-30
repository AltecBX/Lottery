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

/** Honest replacement for High/Medium/Low: how far above chance this really sits. */
export function EdgeChip({ probability, chance }: { probability: number; chance: number }) {
  const edge = chance > 0 ? probability / chance - 1 : 0
  const label = Math.abs(edge) < 0.03 ? '≈ chance' : `${edge > 0 ? '+' : '\u2212'}${Math.round(Math.abs(edge) * 100)}% vs chance`
  const cls = edge >= 0.1 ? 'High' : edge > 0.03 ? 'Medium' : 'Low'
  return (
    <span
      className={`conf-badge ${cls}`}
      title="How far this number's backtest-calibrated probability sits above the chance rate. Even the biggest edge here is a small statistical lean, never a guarantee."
    >
      {label}
    </span>
  )
}
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
