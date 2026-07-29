import type { EngineResult } from '../engine/types.ts'
import { SectionCard, Ball, fmtPct } from './shared.tsx'

export function CombosPanel({ res }: { res: EngineResult }) {
  const combos = res.bestCombo ? [res.bestCombo, ...res.altCombos] : []
  return (
    <SectionCard
      id="combos"
      title="Combination builder"
      className="half"
      sub="Five-number tickets assembled from the top candidates — scored on member strength, pair affinity, and how closely the ticket's shape (sum, odd/even) matches historical draws."
    >
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 30 }}>#</th>
              <th>Combination</th>
              <th className="num">Relative likelihood</th>
              <th className="num">Avg number prob.</th>
            </tr>
          </thead>
          <tbody>
            {combos.map((c, i) => (
              <tr key={c.numbers.join('-')} title={c.notes.join(' · ')}>
                <td className="num" style={{ color: 'var(--muted)' }}>{i + 1}</td>
                <td>
                  <span className="pair-cell" style={{ gap: 5 }}>
                    {c.numbers.map((n) => <Ball key={n} n={n} size="sm" variant={i === 0 ? 'pick' : ''} />)}
                  </span>
                </td>
                <td className="num" style={{ fontWeight: 640 }}>{c.relative}</td>
                <td className="num">{fmtPct(c.avgProbability)}</td>
              </tr>
            ))}
            {combos.length === 0 && (
              <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>Need more data to build combinations.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {res.positions.length > 0 && (
        <>
          <div className="mini-title" style={{ marginTop: 14 }}>
            Position profile {res.inputSorted ? '(feed is pre-sorted — positions are low→high ranks)' : '(source draw order)'}
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Position</th><th className="num">Min</th><th className="num">P25</th><th className="num">Median</th><th className="num">P75</th><th className="num">Max</th></tr>
              </thead>
              <tbody>
                {res.positions.map((p) => (
                  <tr key={p.position}>
                    <td>#{p.position}</td>
                    <td className="num" style={{ color: 'var(--muted)' }}>{p.min}</td>
                    <td className="num">{p.p25}</td>
                    <td className="num" style={{ fontWeight: 640 }}>{p.median}</td>
                    <td className="num">{p.p75}</td>
                    <td className="num" style={{ color: 'var(--muted)' }}>{p.max}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  )
}
