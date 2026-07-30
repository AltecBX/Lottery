import { Fragment, useState } from 'react'
import type { EngineResult } from '../engine/types.ts'
import { SIGNAL_LABEL } from '../engine/signals.ts'
import { SectionCard, Ball, fmtPct } from './shared.tsx'

export function RankingTable({ res }: { res: EngineResult }) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const [showAll, setShowAll] = useState(false)
  const rows = showAll ? res.predictions.slice(0, 20) : res.top10
  const maxScore = Math.max(0.001, ...res.predictions.map((p) => p.score))
  const minScore = Math.min(0, ...res.predictions.slice(0, 20).map((p) => p.score))

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
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 42 }}>Rank</th>
              <th style={{ width: 60 }}>Number</th>
              <th>Score</th>
              <th className="num">Est. probability</th>
              <th>Confidence</th>
              <th>Main reason</th>
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
                    <td><span className={`conf-badge ${p.confidence}`}>{p.confidence}</span></td>
                    <td style={{ color: 'var(--ink-2)', fontSize: 13 }}>{top?.reason ?? '—'}</td>
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
    </SectionCard>
  )
}
