import { Fragment, useState } from 'react'
import type { EngineResult } from '../engine/types.ts'
import { SIGNAL_LABEL } from '../engine/signals.ts'
import { SectionCard, Ball, EdgeChip, fmtPct, useIsPhone } from './shared.tsx'

export function RankingTable({ res }: { res: EngineResult }) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [sortKey, setSortKey] = useState<'rank' | 'number'>('rank')
  const [asc, setAsc] = useState(true)
  const isPhone = useIsPhone()
  const base = showAll ? res.predictions.slice(0, 20) : res.top10
  const rows = [...base].sort((a, b) => {
    const v = sortKey === 'number' ? a.number - b.number : a.rank - b.rank
    return asc ? v : -v
  })
  const maxScore = Math.max(0.001, ...res.predictions.map((p) => p.score))
  const minScore = Math.min(0, ...res.predictions.slice(0, 20).map((p) => p.score))
  const setSort = (key: 'rank' | 'number') => {
    if (sortKey === key) setAsc((v) => !v)
    else { setSortKey(key); setAsc(true) }
  }
  const arrow = (key: 'rank' | 'number') => (sortKey === key ? (asc ? ' ▲' : ' ▼') : '')

  return (
    <SectionCard
      id="ranking"
      title="Predictive Score ranking"
      hint="click a row to see why"
      sub="Every number scored by the weighted ensemble. Probability estimates are calibrated from backtest hit rates at each rank — not guesses."
      headExtra={
        <button className="btn ghost sm" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show top 10' : 'Show top 20'}
        </button>
      }
    >
      {isPhone ? (
        <div className="rank-cards">
          {rows.map((p) => {
            const top = p.contributions.find((c) => c.contribution > 0 && c.reason)
            const isOpen = expanded === p.number
            return (
              <div
                className={`rank-card${p.rank <= res.drawSize ? ' picked' : ''}`}
                key={p.number}
                onClick={() => setExpanded(isOpen ? null : p.number)}
              >
                <span className="rk">#{p.rank}</span>
                <Ball n={p.number} size="md" variant={p.rank <= res.drawSize ? 'pick' : ''} />
                <div className="rc-main">
                  <div className="rc-top">
                    <span className="prob">{fmtPct(p.probability)}</span>
                    <EdgeChip probability={p.probability} chance={res.drawSize / res.K} />
                  </div>
                  <div className="rc-reason">{isOpen ? '' : top?.reason ?? '—'}</div>
                  {isOpen && (
                    <div className="why-list" style={{ marginTop: 4 }}>
                      {p.contributions.slice(0, 3).map((c) => (
                        <div className="why-item" key={c.key}>
                          <span className={`w ${c.contribution >= 0 ? 'pos' : 'neg'}`}>
                            {c.contribution >= 0 ? '+' : ''}{c.contribution.toFixed(2)}
                          </span>
                          <span className="txt">{c.reason || SIGNAL_LABEL[c.key]?.description || '—'}</span>
                        </div>
                      ))}
                      <div className="why-item">
                        <span className="w" style={{ color: 'var(--muted)' }}>stats</span>
                        <span className="txt">
                          drawn {p.stats.count}× · last seen {p.stats.drawsSinceSeen} draws ago · avg gap{' '}
                          {p.stats.meanGap.toFixed(1)} · {p.stats.last20} hits in last 20
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 46 }} className="sortable" onClick={() => setSort('rank')} title="Sort by model rank">Rank{arrow('rank')}</th>
              <th style={{ width: 72 }} className="sortable" onClick={() => setSort('number')} title="Sort by ball number">Number{arrow('number')}</th>
              <th className="sortable" onClick={() => setSort('rank')} title="Score order = rank order">Score</th>
              <th className="num sortable" onClick={() => setSort('rank')} title="Probability order = rank order">Est. probability</th>
              <th>Edge</th>
              <th className="hide-sm">Main reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const frac = Math.max(0.03, (p.score - minScore) / (maxScore - minScore || 1))
              const top = p.contributions.find((c) => c.contribution > 0 && c.reason)
              return (
                <Fragment key={p.number}>
                  <tr onClick={() => setExpanded(expanded === p.number ? null : p.number)} style={{ cursor: 'pointer' }}>
                    <td className="num" style={{ color: 'var(--muted)' }}>{p.rank}</td>
                    <td><Ball n={p.number} size="sm" variant={p.rank <= res.drawSize ? 'pick' : ''} /></td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="scorebar" style={{ flex: 1, maxWidth: 130 }}>
                          <i style={{ width: `${100 * frac}%` }} />
                        </span>
                        <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5, color: 'var(--ink-2)', minWidth: 44 }}>
                          {p.score >= 0 ? '+' : ''}{p.score.toFixed(2)}
                        </span>
                      </div>
                    </td>
                    <td className="num" style={{ fontWeight: 640 }}>{fmtPct(p.probability)}</td>
                    <td><EdgeChip probability={p.probability} chance={res.drawSize / res.K} /></td>
                    <td className="hide-sm" style={{ color: 'var(--ink-2)', fontSize: 13 }}>{top?.reason ?? '—'}</td>
                  </tr>
                  {expanded === p.number && (
                    <tr className="rank-expand">
                      <td colSpan={6}>
                        <div className="why-list">
                          {p.contributions.slice(0, 4).map((c) => (
                            <div className="why-item" key={c.key}>
                              <span className={`w ${c.contribution >= 0 ? 'pos' : 'neg'}`}>
                                {c.contribution >= 0 ? '+' : ''}{c.contribution.toFixed(2)}
                              </span>
                              <span className="sig">{c.label}</span>
                              <span className="txt">{c.reason || SIGNAL_LABEL[c.key]?.description || '—'}</span>
                            </div>
                          ))}
                          <div className="why-item">
                            <span className="w" style={{ color: 'var(--muted)' }}>stats</span>
                            <span className="txt">
                              drawn {p.stats.count}× ({fmtPct(p.stats.overallRate)}) · last seen {p.stats.drawsSinceSeen} draw{p.stats.drawsSinceSeen === 1 ? '' : 's'} ago ·
                              avg gap {p.stats.meanGap.toFixed(1)} · {p.stats.last20} hits in last 20 ·
                              repeats {fmtPct(p.stats.repeatRate, 0)} of the time
                              {p.stats.streak >= 2 ? ` · on a ${p.stats.streak}-draw streak` : ''}
                            </span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      )}
    </SectionCard>
  )
}
