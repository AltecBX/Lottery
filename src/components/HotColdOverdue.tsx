import type { EngineResult } from '../engine/types.ts'
import { SectionCard } from './shared.tsx'

export function HotColdOverdue({ res }: { res: EngineResult }) {
  return (
    <SectionCard
      id="hotcold"
      title="Hot, cold & overdue"
      className="half"
      sub="Hot/cold compare the last 20 draws to each number's own long-run expectation (z-score). Overdue compares the current gap to the number's average gap."
    >
      <div className="mini-title">Hot — running above expectation</div>
      <div className="chip-row" style={{ marginBottom: 14 }}>
        {res.hot.filter((h) => h.z > 0.5).map((h) => (
          <span className="chip hot" key={h.number}>
            <span className="dot" />
            {h.number}
            <span className="meta">{h.count20}× / exp {h.expected20.toFixed(1)} · +{h.z.toFixed(1)}σ</span>
          </span>
        ))}
      </div>
      <div className="mini-title">Cold — running below expectation</div>
      <div className="chip-row" style={{ marginBottom: 14 }}>
        {res.cold.filter((c) => c.z < -0.5).map((c) => (
          <span className="chip cold" key={c.number}>
            <span className="dot" />
            {c.number}
            <span className="meta">{c.count20}× / exp {c.expected20.toFixed(1)} · {c.z.toFixed(1)}σ</span>
          </span>
        ))}
      </div>
      <div className="mini-title">Overdue — longest past their usual gap</div>
      <div className="chip-row">
        {res.overdue.filter((o) => o.ratio > 1.2).map((o) => (
          <span className="chip overdue" key={o.number}>
            <span className="dot" />
            {o.number}
            <span className="meta">{o.drawsSinceSeen} since seen · {o.ratio.toFixed(1)}× avg gap {o.meanGap.toFixed(0)}</span>
          </span>
        ))}
      </div>
      {res.backtest.signals.length > 0 && (() => {
        const overdueSig = res.backtest.signals.find((s) => s.key === 'overdue')
        if (overdueSig && overdueSig.skill <= 0.02) {
          return (
            <p className="card-sub" style={{ marginTop: 12, marginBottom: 0 }}>
              Note: in your data's backtest, "overdue" has shown {overdueSig.skill <= 0 ? 'no' : 'little'} predictive value
              (skill {overdueSig.skill >= 0 ? '+' : ''}{overdueSig.skill.toFixed(2)}), so the ensemble gives it {overdueSig.weight < 0.01 ? 'no' : 'low'} weight.
            </p>
          )
        }
        return null
      })()}
    </SectionCard>
  )
}
