import type { EngineResult } from '../engine/types.ts'
import { SectionCard, Ball, fmtPct } from './shared.tsx'

export function PairsPanel({ res }: { res: EngineResult }) {
  return (
    <SectionCard
      id="pairs"
      title="Pairs & followers"
      className="half"
      sub="Left: numbers drawn together more often than independence predicts. Right: numbers that tend to show up in the draw right after a given number."
    >
      <div className="split">
        <div>
          <div className="mini-title">Frequent pairs (same draw)</div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Pair</th><th className="num">Seen</th><th className="num">Expected</th><th className="num">Lift</th></tr>
              </thead>
              <tbody>
                {res.pairs.slice(0, 9).map((p) => (
                  <tr key={`${p.a}-${p.b}`}>
                    <td>
                      <span className="pair-cell">
                        <Ball n={p.a} size="sm" /><Ball n={p.b} size="sm" />
                      </span>
                    </td>
                    <td className="num">{p.count}×</td>
                    <td className="num" style={{ color: 'var(--muted)' }}>{p.expected.toFixed(1)}</td>
                    <td className="num" style={{ fontWeight: 640, color: p.lift >= 1.3 ? 'var(--good-text)' : undefined }}>{p.lift.toFixed(2)}×</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div className="mini-title">Followers (next draw)</div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>After → comes</th><th className="num">Rate</th><th className="num">Lift</th></tr>
              </thead>
              <tbody>
                {res.followers.slice(0, 9).map((f) => (
                  <tr key={`${f.from}-${f.to}`}>
                    <td>
                      <span className="pair-cell">
                        <Ball n={f.from} size="sm" />
                        <span style={{ color: 'var(--muted)' }}>→</span>
                        <Ball n={f.to} size="sm" />
                      </span>
                    </td>
                    <td className="num" title={`${f.count} of ${f.opportunities} opportunities`}>{fmtPct(f.rate, 0)}</td>
                    <td className="num" style={{ fontWeight: 640, color: f.lift >= 1.3 ? 'var(--good-text)' : undefined }}>{f.lift.toFixed(2)}×</td>
                  </tr>
                ))}
                {res.followers.length === 0 && (
                  <tr><td colSpan={3} style={{ color: 'var(--muted)' }}>No follower pattern clears the noise threshold yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </SectionCard>
  )
}
