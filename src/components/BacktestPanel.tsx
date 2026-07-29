import type { EngineResult } from '../engine/types.ts'
import { SectionCard, Tile, fmtPct, rollingMean } from './shared.tsx'
import { LineChart } from './charts/LineChart.tsx'

export function BacktestPanel({ res }: { res: EngineResult }) {
  const bt = res.backtest
  const window = Math.max(10, Math.min(50, Math.floor(bt.points.length / 8)))
  // Drop the incomplete head of the rolling window so the chart starts on solid averages
  const skip = Math.min(window - 1, Math.max(0, bt.points.length - 5))
  const ensSeries = rollingMean(bt.points.map((p) => p.hits10), window).slice(skip)
  const baseSeries = rollingMean(bt.points.map((p) => p.baselineHits10), window).slice(skip)
  const labels = bt.points.slice(skip).map((p) => p.date.slice(0, 7))
  const maxWeight = Math.max(0.0001, ...bt.signals.map((s) => s.weight))
  const half = Math.floor(bt.points.length / 2)
  const secondHalf = bt.points.slice(half)
  const late10 = secondHalf.length ? secondHalf.reduce((s, p) => s + p.hits10, 0) / secondHalf.length : 0
  const lateBase = secondHalf.length ? secondHalf.reduce((s, p) => s + p.baselineHits10, 0) / secondHalf.length : 0

  return (
    <SectionCard
      id="backtest"
      title="Backtest results"
      hint={`walk-forward · ${bt.evaluated} draws evaluated · first ${bt.minHistory} used as warm-up`}
      sub="Every historical draw was predicted using only the draws before it — then compared to what actually happened. This is also how the ensemble learns its signal weights: signals that don't beat chance get their weight cut to zero."
    >
      <div className="tiles" style={{ marginBottom: 18 }}>
        <Tile
          label="Ensemble · hits in top-10"
          value={bt.ensemble10.toFixed(2)}
          delta={`${bt.ensemble10 >= bt.chance10 ? '+' : ''}${(100 * (bt.ensemble10 / Math.max(0.0001, bt.chance10) - 1)).toFixed(0)}% vs chance ${bt.chance10.toFixed(2)}`}
          deltaDir={bt.ensemble10 > bt.chance10 * 1.02 ? 'up' : bt.ensemble10 < bt.chance10 * 0.98 ? 'down' : 'flat'}
        />
        <Tile
          label="Frequency baseline · top-10"
          value={bt.baseline10.toFixed(2)}
          delta="what naive frequency achieves"
        />
        <Tile
          label="Trained model (2nd half)"
          value={late10.toFixed(2)}
          delta={`vs frequency ${lateBase.toFixed(2)} in the same period`}
          deltaDir={late10 > lateBase ? 'up' : late10 < lateBase ? 'down' : 'flat'}
        />
        <Tile
          label="Ensemble · hits in top-5"
          value={bt.ensemble5.toFixed(2)}
          delta={`chance ${bt.chance5.toFixed(2)} · baseline ${bt.baseline5.toFixed(2)}`}
        />
      </div>

      <div className="mini-title">Accuracy over time — rolling {window}-draw average of hits in top-10</div>
      <LineChart
        xLabels={labels}
        series={[
          { name: 'Ensemble', color: 'var(--accent)', values: ensSeries },
          { name: 'Frequency baseline', color: 'var(--series-2)', values: baseSeries },
        ]}
        threshold={{ value: bt.chance10, label: 'Chance' }}
        height={230}
        yFormat={(v) => v.toFixed(2)}
      />

      <div className="split" style={{ marginTop: 10 }}>
        <div>
          <div className="mini-title">Signal performance → learned weight</div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Signal</th><th className="num">Skill</th><th>Weight</th></tr>
              </thead>
              <tbody>
                {bt.signals.map((s) => (
                  <tr key={s.key} title={`${s.description} Average hits in its own top-10: ${s.avgHits10.toFixed(2)} (chance ${bt.chance10.toFixed(2)}).`}>
                    <td style={{ whiteSpace: 'nowrap' }}>{s.label}</td>
                    <td className="num" style={{ fontWeight: 640, color: s.skill > 0.015 ? 'var(--good-text)' : s.skill < -0.015 ? 'var(--bad-text)' : 'var(--muted)' }}>
                      {s.skill >= 0 ? '+' : ''}{s.skill.toFixed(2)}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="scorebar" style={{ flex: 1, maxWidth: 110 }}>
                          <i style={{ width: `${(100 * s.weight) / maxWeight}%` }} />
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', minWidth: 34 }}>
                          {fmtPct(s.weight, 0)}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ display: 'block', marginTop: 8 }}>
            Skill = average hits in that signal's own top-10, minus chance. Weights are re-learned online as history grows.
          </p>
        </div>
        <div>
          <div className="mini-title">Hit rate by predicted rank (calibration)</div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Rank</th><th className="num">Hit rate</th><th className="num">Chance</th><th className="num">Edge</th></tr>
              </thead>
              <tbody>
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((r) => {
                  const rate = bt.rankHitRate[r] ?? 0
                  const chance = 5 / Math.max(1, res.K)
                  return (
                    <tr key={r}>
                      <td>#{r + 1}</td>
                      <td className="num" style={{ fontWeight: 640 }}>{fmtPct(rate)}</td>
                      <td className="num" style={{ color: 'var(--muted)' }}>{fmtPct(chance)}</td>
                      <td className="num" style={{ color: rate > chance * 1.02 ? 'var(--good-text)' : 'var(--muted)' }}>
                        {(rate / Math.max(0.0001, chance)).toFixed(2)}×
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ display: 'block', marginTop: 8 }}>
            These backtested rates are what the "estimated probability" column is calibrated from.
          </p>
        </div>
      </div>
    </SectionCard>
  )
}
