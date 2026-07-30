import { useState } from 'react'
import type { EngineResult } from '../engine/types.ts'
import { DOW_SHORT, formatDate } from '../engine/dates.ts'
import { SectionCard, Ball } from './shared.tsx'

const PAGE = 10

/**
 * The learning loop made visible: for every historical draw, what the model
 * (knowing only earlier draws) put in its top-10 — next to what actually hit.
 */
export function PredictionLog({ res }: { res: EngineResult }) {
  const [page, setPage] = useState(0)
  const D = res.drawSize
  const all = [...res.backtest.points].reverse() // newest first
  const pages = Math.max(1, Math.ceil(all.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const rows = all.slice(cur * PAGE, cur * PAGE + PAGE)

  return (
    <SectionCard
      id="log"
      title="Prediction log"
      hint="the model tested against every draw it never saw"
      sub={`Every row is a real self-test: the model predicted this draw using only the draws before it, then scored itself against the actual result — and re-tuned its signal weights. Filled picks = hits; the hit rate you see here is exactly what the accuracy stats are computed from.`}
    >
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Draw</th>
              <th>Model's top-10 before the draw</th>
              <th>Actual result</th>
              <th className="num">Hits</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const actualSet = new Set(p.actual)
              const predictedSet = new Set(p.predictedTop)
              return (
                <tr key={p.index}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {formatDate(p.date)}
                    <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: 12 }}>{DOW_SHORT[p.dow]}</span>
                  </td>
                  <td>
                    <span className="pair-cell" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {p.predictedTop.map((n) => (
                        <Ball key={n} n={n} size="sm" variant={actualSet.has(n) ? 'pick' : 'faded'} title={actualSet.has(n) ? 'hit' : 'miss'} />
                      ))}
                    </span>
                  </td>
                  <td>
                    <span className="pair-cell" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {p.actual.map((n) => (
                        <Ball key={n} n={n} size="sm" variant={predictedSet.has(n) ? 'match' : ''} title={predictedSet.has(n) ? 'was in top-10' : 'missed'} />
                      ))}
                    </span>
                  </td>
                  <td className="num" style={{ fontWeight: 680, color: p.hits10 >= 2 ? 'var(--good-text)' : p.hits10 === 0 ? 'var(--muted)' : undefined }}>
                    {p.hits10}/{D}
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>Not enough history yet — the self-test starts once {res.backtest.minHistory} draws are loaded.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <button className="btn sm" disabled={cur === 0} onClick={() => setPage(cur - 1)}>← Newer</button>
          <span className="hint">page {cur + 1} of {pages} · {all.length} self-tested draws</span>
          <button className="btn sm" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>Older →</button>
        </div>
      )}
    </SectionCard>
  )
}
