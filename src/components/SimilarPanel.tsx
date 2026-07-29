import type { EngineResult } from '../engine/types.ts'
import { DOW_SHORT, formatDate } from '../engine/dates.ts'
import { SectionCard, Ball, fmtPct } from './shared.tsx'

export function SimilarPanel({ res }: { res: EngineResult }) {
  return (
    <SectionCard
      id="similar"
      title="Similar historical situations"
      sub="Moments in history that most resemble right now (same weekday ahead, similar previous draw and draw shape) — and what actually came next. Outlined numbers are also in the current top-10 prediction."
    >
      <div className="sim-list">
        {res.similar.map((s) => (
          <div className="sim-item" key={s.index}>
            <div className="sim-head">
              <span className="pct">{fmtPct(s.similarity, 0)} similar</span>
              <span>{DOW_SHORT[s.dow]} {formatDate(s.date)}</span>
            </div>
            <div className="sim-rows">
              <div className="sim-row">
                <span className="lbl">Before</span>
                {s.contextNumbers.map((n) => <Ball key={n} n={n} size="sm" variant="faded" />)}
              </div>
              <div className="sim-row">
                <span className="lbl">Came next</span>
                {s.outcome.map((n) => (
                  <Ball key={n} n={n} size="sm" variant={s.matchesWithPrediction.includes(n) ? 'match' : ''} />
                ))}
              </div>
            </div>
          </div>
        ))}
        {res.similar.length === 0 && <p className="hint">Not enough history yet to find meaningful analogues.</p>}
      </div>
    </SectionCard>
  )
}
