import { useMemo, useState } from 'react'
import type { BacktestPoint, EngineResult } from '../engine/types.ts'
import { DOW_SHORT, formatDate } from '../engine/dates.ts'
import { SectionCard, Ball } from './shared.tsx'

const PAGE = 10

type SortKey = 'date' | 'hits' | 'bonus' | 'top10' | 'actual'

const specialHit = (p: BacktestPoint): number =>
  p.specialActual !== undefined && p.specialTop?.includes(p.specialActual) ? 1 : 0

/** Lexicographic compare of two number sequences (first ball, then the next…). */
const cmpSeq = (a: number[], b: number[]): number => {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

/**
 * The learning loop made visible: for every historical draw, what the model
 * (knowing only earlier draws) put in its top-10 — next to what actually hit.
 */
export function PredictionLog({ res }: { res: EngineResult }) {
  const [page, setPage] = useState(0)
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [desc, setDesc] = useState(true)
  const D = res.drawSize
  const points = res.backtest.points
  const hasSpecial = points.some((p) => p.specialActual !== undefined)

  const all = useMemo(() => {
    const arr = [...points]
    const dir = desc ? -1 : 1
    if (sortKey === 'hits') arr.sort((a, b) => dir * (a.hits10 - b.hits10) || b.index - a.index)
    else if (sortKey === 'bonus') arr.sort((a, b) => dir * (specialHit(a) - specialHit(b)) || b.index - a.index)
    else if (sortKey === 'top10') arr.sort((a, b) => dir * cmpSeq(a.predictedTop, b.predictedTop) || b.index - a.index)
    else if (sortKey === 'actual') arr.sort((a, b) => dir * cmpSeq(a.actual, b.actual) || b.index - a.index)
    else arr.sort((a, b) => dir * (a.index - b.index))
    return arr
  }, [points, sortKey, desc])

  const best = useMemo(() => {
    let max = 0
    let count = 0
    let lastDate = ''
    for (const p of points) {
      if (p.hits10 > max) { max = p.hits10; count = 1; lastDate = p.date }
      else if (p.hits10 === max && max > 0) { count++; if (p.date > lastDate) lastDate = p.date }
    }
    return { max, count, lastDate }
  }, [points])

  const setSort = (key: SortKey) => {
    if (sortKey === key) setDesc((d) => !d)
    else { setSortKey(key); setDesc(key === 'date' || key === 'hits' || key === 'bonus') }
    setPage(0)
  }
  const arrow = (key: SortKey) => (sortKey === key ? (desc ? ' ▼' : ' ▲') : '')

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
      {points.length > 0 && (
        <p className="hint" style={{ display: 'block', marginBottom: 10 }}>
          {best.max >= D ? (
            <>🏆 Perfect {D}/{D}: {best.count} time{best.count === 1 ? '' : 's'} — most recently {formatDate(best.lastDate)}.</>
          ) : (
            <>
              Best day so far: <strong>{best.max}/{D}</strong> in the top-10
              {best.count > 0 && <> ({best.count}×, last on {formatDate(best.lastDate)})</>} · a perfect {D}/{D} has
              never happened in {points.length.toLocaleString()} self-tests. Sort the Hits column to browse the best days.
            </>
          )}
        </p>
      )}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="sortable" onClick={() => setSort('date')} title="Sort by draw date">Draw{arrow('date')}</th>
              <th className="sortable" onClick={() => setSort('top10')} title="Sort by the model's #1 pick (then #2, …)">Model's top-10 before the draw{arrow('top10')}</th>
              <th className="sortable" onClick={() => setSort('actual')} title="Sort by the lowest drawn number (then the next, …)">Actual result{arrow('actual')}</th>
              {hasSpecial && (
                <th className="sortable" onClick={() => setSort('bonus')} title="Sort by bonus-ball hits">Bonus{arrow('bonus')}</th>
              )}
              <th className="num sortable" onClick={() => setSort('hits')} title="Sort by hit count">Hits{arrow('hits')}</th>
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
                  {hasSpecial && (
                    <td>
                      {p.specialActual !== undefined ? (
                        <span className="pair-cell" style={{ gap: 4 }} title={p.specialTop ? `model's top-3: ${p.specialTop.join(', ')}` : undefined}>
                          <Ball
                            n={p.specialActual}
                            size="sm"
                            variant={p.specialTop?.includes(p.specialActual) ? 'special' : 'faded'}
                            title={p.specialTop?.includes(p.specialActual) ? 'was in the model\'s top-3' : 'missed'}
                          />
                        </span>
                      ) : (
                        <span className="hint">—</span>
                      )}
                    </td>
                  )}
                  <td className="num" style={{ fontWeight: 680, color: p.hits10 >= 2 ? 'var(--good-text)' : p.hits10 === 0 ? 'var(--muted)' : undefined }}>
                    {p.hits10}/{D}
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr><td colSpan={hasSpecial ? 5 : 4} style={{ color: 'var(--muted)' }}>Not enough history yet — the self-test starts once {res.backtest.minHistory} draws are loaded.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <button className="btn sm" disabled={cur === 0} onClick={() => setPage(cur - 1)}>← {desc && sortKey === 'date' ? 'Newer' : 'Prev'}</button>
          <span className="hint">page {cur + 1} of {pages} · {all.length} self-tested draws</span>
          <button className="btn sm" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>{desc && sortKey === 'date' ? 'Older' : 'Next'} →</button>
        </div>
      )}
    </SectionCard>
  )
}
