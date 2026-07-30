import type { EngineResult } from '../engine/types.ts'
import { formatOdds, hitDistribution, jackpotOdds, matchOdds } from '../engine/odds.ts'
import { SectionCard, fmtPct } from './shared.tsx'

/**
 * The panel that keeps everyone honest: what hit counts a fair draw actually
 * produces, how the model's backtest record compares, and the odds no tool
 * can change.
 */
export function RealityPanel({ res }: { res: EngineResult }) {
  const D = res.drawSize
  const K = res.K
  const chanceDist = hitDistribution(K, D, D)
  const pts = res.backtest.points
  const modelDist: number[] = Array(Math.min(D, 4) + 1).fill(0)
  if (pts.length >= 50) {
    for (const p of pts) modelDist[Math.min(p.hitsPick, modelDist.length - 1)]++
    for (let i = 0; i < modelDist.length; i++) modelDist[i] /= pts.length
  }
  const rows = [0, 1, 2].map((m) => ({
    label: `${m} of ${D}`,
    chance: chanceDist[m] ?? 0,
    model: pts.length >= 50 ? modelDist[m] ?? 0 : null,
  }))
  const chance3plus = chanceDist.slice(3).reduce((a, b) => a + b, 0)
  const model3plus = pts.length >= 50 ? modelDist.slice(3).reduce((a, b) => a + b, 0) : null
  rows.push({ label: `3+ of ${D}`, chance: chance3plus, model: model3plus })
  const maxBar = Math.max(...rows.map((r) => Math.max(r.chance, r.model ?? 0)), 0.0001)

  const edge = res.backtest.chance10 > 0 ? res.backtest.ensemble10 / res.backtest.chance10 : 1
  const specialK = res.special?.K ?? 0

  return (
    <SectionCard
      id="reality"
      title="Reality check"
      hint="read this before reading any prediction"
      sub={`A fair draw has no memory. Statistical analysis can only surface whatever tiny biases a game actually has — it cannot beat the odds below. Missing most numbers on most draws is the expected outcome for every model, including this one.`}
    >
      <div className="split">
        <div>
          <div className="mini-title">How many of the model's {D} picks hit a typical draw</div>
          <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Hits</th>
                <th>Pure chance</th>
                <th>{pts.length >= 50 ? 'This model (backtest)' : 'This model'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td style={{ whiteSpace: 'nowrap', fontWeight: 620 }}>{r.label}</td>
                  <td style={{ minWidth: 120 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="scorebar" style={{ flex: 1, maxWidth: 90 }}>
                        <i style={{ width: `${(100 * r.chance) / maxBar}%`, background: 'var(--muted)' }} />
                      </span>
                      <span style={{ fontSize: 12.5, color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', minWidth: 44 }}>
                        {fmtPct(r.chance, 1)}
                      </span>
                    </div>
                  </td>
                  <td style={{ minWidth: 120 }}>
                    {r.model === null ? (
                      <span className="hint">needs 50+ backtested draws</span>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="scorebar" style={{ flex: 1, maxWidth: 90 }}>
                          <i style={{ width: `${(100 * r.model) / maxBar}%` }} />
                        </span>
                        <span style={{ fontSize: 12.5, color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', minWidth: 44 }}>
                          {fmtPct(r.model, 1)}
                        </span>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <p className="hint" style={{ display: 'block', marginTop: 8 }}>
            Catching 0–1 is the normal result. That is not the model failing — it is what a {D}-of-{K} game does.
          </p>
        </div>
        <div>
          <div className="mini-title">The odds nobody can change (any ticket, any method)</div>
          <div className="tbl-wrap">
          <table className="tbl">
            <tbody>
              <tr>
                <td>Match 3 of {D}</td>
                <td className="num" style={{ fontWeight: 640 }}>{formatOdds(matchOdds(K, D, 3))}</td>
              </tr>
              <tr>
                <td>Match 4 of {D}</td>
                <td className="num" style={{ fontWeight: 640 }}>{formatOdds(matchOdds(K, D, 4))}</td>
              </tr>
              <tr>
                <td>Match all {D}</td>
                <td className="num" style={{ fontWeight: 640 }}>{formatOdds(matchOdds(K, D, D))}</td>
              </tr>
              {specialK > 0 && (
                <tr>
                  <td>Match all {D} + bonus ball (jackpot)</td>
                  <td className="num" style={{ fontWeight: 680 }}>{formatOdds(jackpotOdds(K, D, specialK))}</td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
          <p className="card-sub" style={{ marginTop: 10, marginBottom: 0 }}>
            This model's measured edge on your data is <strong>{edge.toFixed(2)}×</strong> chance — it catches on average{' '}
            {res.backtest.ensemble10.toFixed(2)} winners in its top-10 where guessing would catch {res.backtest.chance10.toFixed(2)}.
            {edge < 1.15
              ? ' That is close to no edge at all: treat every prediction here as analysis and entertainment, never as something to rely on.'
              : ' Even that edge changes hit counts by a fraction of a number per draw — it is insight, not a way to beat the game.'}
            {' '}Please play only with money you can comfortably lose.
          </p>
        </div>
      </div>
    </SectionCard>
  )
}
