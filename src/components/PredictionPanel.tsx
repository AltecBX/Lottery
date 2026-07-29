import type { EngineResult } from '../engine/types.ts'
import { DOW_NAMES, formatDate } from '../engine/dates.ts'
import { Ball, Tile, fmtPct } from './shared.tsx'

export function PredictionPanel({ res }: { res: EngineResult }) {
  const bt = res.backtest
  const edge10 = bt.chance10 > 0 ? bt.ensemble10 / bt.chance10 : 1
  const recent = bt.points.slice(-100)
  const recent10 = recent.length ? recent.reduce((s, p) => s + p.hits10, 0) / recent.length : 0
  const uniformW = bt.signals.length > 0 ? 1 / bt.signals.length : 0
  const learned = bt.signals.length > 0 && bt.signals[0].weight > 1.5 * uniformW
  const drivers = learned ? bt.signals.filter((s) => s.weight > 0.005).slice(0, 5) : []

  return (
    <section id="prediction" className="card hero-card section-anchor">
      <div className="hero-top">
        <h2 style={{ fontSize: 19 }}>Next draw prediction</h2>
        <span className="hero-date">
          {DOW_NAMES[res.nextDow]}, {formatDate(res.nextDate)} · learned from {res.drawCount.toLocaleString()} draws
        </span>
      </div>

      <div className="hero-cols">
        <div className="hero-balls">
          {res.top5.map((p) => (
            <div className="hero-ball-wrap" key={p.number}>
              <Ball n={p.number} size="hero" />
              <span className="prob">{fmtPct(p.probability)}</span>
              <span className="conf">{p.confidence}</span>
            </div>
          ))}
        </div>
        <div className="hero-drivers">
          <div className="mini-title">What's driving the model</div>
          {drivers.map((s) => (
            <div className="driver-row" key={s.key} title={s.description}>
              <span className="scorebar"><i style={{ width: `${Math.min(100, (100 * s.weight) / Math.max(0.0001, drivers[0].weight))}%` }} /></span>
              <span className="driver-name">{s.label}</span>
              <span className="driver-w">{fmtPct(s.weight, 0)}</span>
            </div>
          ))}
          {drivers.length > 0 ? (
            <span className="hint">weights learned by backtesting your data</span>
          ) : (
            <span className="hint">
              No signal shows a statistically significant edge in your data yet, so the ensemble uses a balanced blend of
              all signals. See the Backtest panel for each signal's record.
            </span>
          )}
        </div>
      </div>

      {res.bestCombo && (
        <div className="combo-strip">
          <span className="mini-title" style={{ margin: 0 }}>Best combination</span>
          <span className="balls">
            {res.bestCombo.numbers.map((n) => (
              <Ball key={n} n={n} size="sm" variant="pick" />
            ))}
          </span>
          <span className="combo-note">{res.bestCombo.notes.join(' · ')}</span>
        </div>
      )}

      <div className="tiles" style={{ marginTop: 16 }}>
        <Tile
          label="Model edge (top-10)"
          value={`${edge10.toFixed(2)}×`}
          delta={edge10 > 1.02 ? 'above chance in backtest' : 'no edge over chance yet'}
          deltaDir={edge10 > 1.02 ? 'up' : 'flat'}
        />
        <Tile label="Hits in top-10 (backtest avg)" value={bt.ensemble10.toFixed(2)} delta={`chance ${bt.chance10.toFixed(2)} · frequency ${bt.baseline10.toFixed(2)}`} />
        <Tile label="Recent form (last 100)" value={recent10.toFixed(2)} delta="hits of 5 caught in top-10" />
        <Tile label="≥2 of 5 in top-10" value={fmtPct(bt.ens10AtLeast2, 0)} delta={`${bt.evaluated} draws backtested`} />
      </div>
    </section>
  )
}
