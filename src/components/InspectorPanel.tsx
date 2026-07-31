import { useMemo, useState } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import { DOW_SHORT, formatDate } from '../engine/dates.ts'
import { SectionCard, Ball, fmtPct } from './shared.tsx'

/** Deep-dive dossier for a single number, computed straight from the history. */
export function InspectorPanel({ res, draws }: { res: EngineResult; draws: Draw[] }) {
  const [picked, setPicked] = useState(0)
  const number = picked >= 1 && picked <= res.K ? picked : res.topPick[0]?.number ?? 1

  const dossier = useMemo(() => {
    const appearances: number[] = []
    const byDow = new Uint32Array(7)
    const drawsByDow = new Uint32Array(7)
    const partners = new Map<number, number>()
    const followers = new Map<number, number>()
    draws.forEach((d, i) => {
      drawsByDow[d.dow]++
      if (d.sorted.includes(number)) {
        appearances.push(i)
        byDow[d.dow]++
        for (const n of d.sorted) if (n !== number) partners.set(n, (partners.get(n) ?? 0) + 1)
        const next = draws[i + 1]
        if (next) for (const n of next.sorted) followers.set(n, (followers.get(n) ?? 0) + 1)
      }
    })
    const gaps: number[] = []
    for (let i = 1; i < appearances.length; i++) gaps.push(appearances[i] - appearances[i - 1])
    const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0
    const longestGap = gaps.length ? Math.max(...gaps) : 0
    const top = (m: Map<number, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    return {
      appearances,
      byDow,
      drawsByDow,
      meanGap,
      longestGap,
      partners: top(partners),
      followers: top(followers),
      lastIndex: appearances.length ? appearances[appearances.length - 1] : -1,
    }
  }, [draws, number])

  const pred = res.predictions.find((p) => p.number === number)
  const N = draws.length
  const since = dossier.lastIndex >= 0 ? N - dossier.lastIndex : N
  const recentWindow = Math.min(60, N)
  const recentStart = N - recentWindow
  const recentHits = new Set(dossier.appearances.filter((i) => i >= recentStart))

  return (
    <SectionCard
      collapsible
      id="inspector"
      title="Number inspector"
      className="half"
      sub="Everything the data knows about one number — pick any number to see its full story."
      headExtra={
        <select
          value={number}
          onChange={(e) => setPicked(Number(e.target.value))}
          style={{ padding: '5px 9px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)' }}
        >
          {Array.from({ length: res.K }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12, flexWrap: 'wrap' }}>
        <Ball n={number} size="hero" />
        <div style={{ fontSize: 13.5, color: 'var(--ink-2)' }}>
          {pred ? (
            <>
              Model rank <strong style={{ color: 'var(--ink)' }}>#{pred.rank}</strong> of {res.K} for the next draw ·
              est. probability <strong style={{ color: 'var(--ink)' }}>{fmtPct(pred.probability)}</strong>
              <br />
              {pred.contributions.find((c) => c.contribution > 0 && c.reason)?.reason ?? 'No strong signal either way right now.'}
            </>
          ) : 'No prediction data yet.'}
        </div>
      </div>

      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className="tile">
          <div className="label">Drawn</div>
          <div className="value">{dossier.appearances.length}×</div>
          <div className="delta">{N ? fmtPct(dossier.appearances.length / N) : '—'} of draws · expected {fmtPct(res.drawSize / res.K)}</div>
        </div>
        <div className="tile">
          <div className="label">Last seen</div>
          <div className="value">{dossier.lastIndex >= 0 ? `${since} draw${since === 1 ? '' : 's'} ago` : 'never'}</div>
          <div className="delta">{dossier.lastIndex >= 0 ? formatDate(draws[dossier.lastIndex].date) : ''}</div>
        </div>
        <div className="tile">
          <div className="label">Average gap</div>
          <div className="value">{dossier.meanGap ? dossier.meanGap.toFixed(1) : '—'}</div>
          <div className="delta">longest drought {dossier.longestGap || '—'} draws</div>
        </div>
      </div>

      <div className="mini-title">Last {recentWindow} draws (filled = hit)</div>
      <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', marginBottom: 14 }}>
        {Array.from({ length: recentWindow }, (_, k) => {
          const idx = recentStart + k
          const hit = recentHits.has(idx)
          return (
            <span
              key={k}
              title={`${formatDate(draws[idx].date)}${hit ? ' — hit' : ''}`}
              style={{
                width: 8, height: 18, borderRadius: 2,
                background: hit ? 'var(--accent)' : 'var(--surface-2)',
                border: '1px solid var(--border)',
              }}
            />
          )
        })}
      </div>

      <div className="split">
        <div>
          <div className="mini-title">By weekday</div>
          <table className="tbl">
            <tbody>
              {[0, 1, 2, 3, 4, 5, 6].filter((d) => dossier.drawsByDow[d] > 0).map((d) => (
                <tr key={d}>
                  <td>{DOW_SHORT[d]}</td>
                  <td className="num">{dossier.byDow[d]}×</td>
                  <td className="num" style={{ color: 'var(--muted)' }}>{fmtPct(dossier.byDow[d] / Math.max(1, dossier.drawsByDow[d]), 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="mini-title">Appears with / is followed by</div>
          <div className="chip-row" style={{ marginBottom: 8 }}>
            {dossier.partners.map(([n, c]) => (
              <span className="chip" key={`p${n}`} title={`drawn together ${c}×`}>
                <Ball n={n} size="sm" /> <span className="meta">{c}×</span>
              </span>
            ))}
          </div>
          <div className="chip-row">
            {dossier.followers.map(([n, c]) => (
              <span className="chip" key={`f${n}`} title={`appeared in the draw right after ${number} was drawn, ${c}×`}>
                <span className="meta">→</span> <Ball n={n} size="sm" /> <span className="meta">{c}×</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </SectionCard>
  )
}
