import { useState } from 'react'
import type { Draw } from '../engine/types.ts'
import { DOW_NAMES, formatDate } from '../engine/dates.ts'
import { drawsToCsv } from '../engine/parse.ts'
import { SectionCard, Ball } from './shared.tsx'

const PAGE = 12

export function HistoryTable({ draws, exportName, onDelete }: { draws: Draw[]; exportName: string; onDelete: (draw: Draw) => void }) {
  const [page, setPage] = useState(0)
  const [newestFirst, setNewestFirst] = useState(true)
  const ordered = newestFirst ? [...draws].reverse() : draws
  const pages = Math.max(1, Math.ceil(ordered.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const rows = ordered.slice(cur * PAGE, cur * PAGE + PAGE)

  const exportCsv = () => {
    const blob = new Blob([drawsToCsv(draws)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${exportName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'draws'}-history.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <SectionCard
      collapsible
      id="history"
      title="Historical data"
      hint={`${draws.length.toLocaleString()} draws`}
      headExtra={<button className="btn ghost sm" onClick={exportCsv}>Export CSV</button>}
    >
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="sortable" onClick={() => { setNewestFirst((v) => !v); setPage(0) }} title="Toggle newest/oldest first">
                Date{newestFirst ? ' ▼' : ' ▲'}
              </th>
              <th>Day</th>
              <th>Numbers</th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={`${d.date}-${d.sorted.join(',')}`}>
                <td style={{ whiteSpace: 'nowrap' }}>{formatDate(d.date)}</td>
                <td style={{ color: 'var(--ink-2)' }}>{DOW_NAMES[d.dow]}</td>
                <td>
                  <span className="pair-cell" style={{ gap: 5 }}>
                    {d.numbers.map((n) => <Ball key={n} n={n} size="sm" />)}
                    {d.special !== undefined && <Ball n={d.special} size="sm" variant="special" title="Bonus ball" />}
                  </span>
                </td>
                <td>
                  <button
                    className="btn ghost sm danger"
                    title="Delete this draw"
                    onClick={() => {
                      if (window.confirm(`Delete the draw from ${formatDate(d.date)} (${d.numbers.join(', ')})?`)) onDelete(d)
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>No draws yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <button className="btn sm" disabled={cur === 0} onClick={() => setPage(cur - 1)}>← {newestFirst ? 'Newer' : 'Older'}</button>
          <span className="hint">page {cur + 1} of {pages}</span>
          <button className="btn sm" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>{newestFirst ? 'Older' : 'Newer'} →</button>
        </div>
      )}
    </SectionCard>
  )
}
