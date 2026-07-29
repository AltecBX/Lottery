import type { EngineResult, Settings } from '../engine/types.ts'
import { SectionCard, Ball, fmtPct } from './shared.tsx'
import { BarChart } from './charts/BarChart.tsx'

export function TrendsPanel({ res, settings, onWindowChange }: {
  res: EngineResult
  settings: Settings
  onWindowChange: (w: number) => void
}) {
  const windows = [10, 20, 50, 100, 250]
  const top10 = new Set(res.top10.map((p) => p.number))
  return (
    <SectionCard
      id="trends"
      title="Recent trends & frequency"
      sub="Momentum compares each number's rate in the last 10 draws to its last-50 rate. The chart shows appearance counts in the selected window — orange bars are numbers currently in the model's top 10."
      headExtra={
        <span className="seg" role="group" aria-label="Frequency window">
          {windows.map((w) => (
            <button key={w} className={settings.exploreWindow === w ? 'on' : ''} onClick={() => onWindowChange(w)}>
              {w === 250 ? 'All' : `Last ${w}`}
            </button>
          ))}
        </span>
      }
    >
      <div className="split" style={{ marginBottom: 16 }}>
        <div>
          <div className="mini-title">Rising</div>
          <div className="chip-row">
            {res.rising.map((t) => (
              <span className="chip hot" key={t.number}>
                <span className="dot" />
                {t.number}
                <span className="meta">{fmtPct(t.rate10, 0)} last 10 vs {fmtPct(t.rate50, 0)} last 50</span>
              </span>
            ))}
            {res.rising.length === 0 && <span className="hint">Nothing rising sharply.</span>}
          </div>
        </div>
        <div>
          <div className="mini-title">Fading</div>
          <div className="chip-row">
            {res.falling.map((t) => (
              <span className="chip cold" key={t.number}>
                <span className="dot" />
                {t.number}
                <span className="meta">{fmtPct(t.rate10, 0)} last 10 vs {fmtPct(t.rate50, 0)} last 50</span>
              </span>
            ))}
            {res.falling.length === 0 && <span className="hint">Nothing fading sharply.</span>}
          </div>
        </div>
      </div>

      {res.streaks.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="mini-title">Active streaks (appeared in consecutive draws)</div>
          <div className="chip-row">
            {res.streaks.map((s) => (
              <span className="chip" key={s.number}>
                <Ball n={s.number} size="sm" />
                <span className="meta">{s.streak} draws running</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mini-title">
        Appearances {settings.exploreWindow >= 250 ? 'across all history' : `in the last ${settings.exploreWindow} draws`}
      </div>
      <BarChart
        data={(settings.exploreWindow >= 250 ? res.frequency : res.windowFrequency).map((f) => ({
          label: String(f.number),
          value: f.count,
          highlight: top10.has(f.number),
        }))}
        height={200}
        tooltipTitle={(d) => `Number ${d.label}${top10.has(Number(d.label)) ? ' · in top-10 prediction' : ''}`}
        format={(v) => `${v}`}
      />
      <details className="data-table">
        <summary>View as table</summary>
        <div className="tbl-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Number</th><th className="num">Count</th></tr></thead>
            <tbody>
              {(settings.exploreWindow >= 250 ? res.frequency : res.windowFrequency).map((f) => (
                <tr key={f.number}><td>{f.number}</td><td className="num">{f.count}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </SectionCard>
  )
}
