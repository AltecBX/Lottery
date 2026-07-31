import { useEffect, useState, type ReactNode } from 'react'

/** True on phone-width screens — keeps layout decisions in one place. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)')
    const on = () => setPhone(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return phone
}

export function Ball({ n, size = 'md', variant = '', title }: { n: number; size?: 'hero' | 'md' | 'sm'; variant?: string; title?: string }) {
  return (
    <span className={`ball ${size} ${variant}`} title={title}>
      {n}
    </span>
  )
}

/**
 * A panel. On phones, secondary panels (`collapsible`) start folded so the
 * screen leads with predictions — tapping the header expands them in place.
 */
export function SectionCard({ id, title, hint, sub, children, className = '', headExtra, collapsible = false }: {
  id?: string
  title: string
  hint?: string
  sub?: ReactNode
  children: ReactNode
  className?: string
  headExtra?: ReactNode
  collapsible?: boolean
}) {
  const [open, setOpen] = useState(false)
  const isPhone = useIsPhone()
  const folded = collapsible && isPhone && !open

  return (
    <section id={id} className={`card section-anchor ${className}${folded ? ' folded' : ''}`}>
      <div
        className={`card-head${collapsible && isPhone ? ' tappable' : ''}`}
        onClick={collapsible && isPhone ? () => setOpen((v) => !v) : undefined}
        role={collapsible && isPhone ? 'button' : undefined}
        aria-expanded={collapsible && isPhone ? open : undefined}
        tabIndex={collapsible && isPhone ? 0 : undefined}
        onKeyDown={
          collapsible && isPhone
            ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) } }
            : undefined
        }
      >
        <h2>{title}</h2>
        {hint && <span className="hint hide-sm">{hint}</span>}
        {headExtra && !folded && <span className="spacer">{headExtra}</span>}
        {collapsible && isPhone && <span className="fold-caret" aria-hidden="true">{open ? '−' : '+'}</span>}
      </div>
      {!folded && (
        <>
          {sub && <p className="card-sub">{sub}</p>}
          {children}
        </>
      )}
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
