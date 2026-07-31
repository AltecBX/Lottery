import type { EngineResult } from '../engine/types.ts'
import { formatDate } from '../engine/dates.ts'
import { SectionCard, Ball, fmtPct } from './shared.tsx'

const fmtExpected = (x: number): string => (x >= 0.01 ? x.toFixed(2) : x > 0 ? '<0.01' : '0')

/**
 * Answers one question people always ask: has a full winning combination ever
 * come back? Shows the actual repeats (usually none), what pure chance would
 * predict, and the closest near-recurrences — with the honest odds context.
 */
export function RepeatsPanel({ res }: { res: EngineResult }) {
  const r = res.repeats
  if (!r || r.totalDraws < 2) return null
  const D = r.drawSize
  const never = r.exactRepeats.length === 0
  const pairsTotal = (r.totalDraws * (r.totalDraws - 1)) / 2
  const shareRemoved = r.possibleCombos > 0 ? r.totalDraws / r.possibleCombos : 0

  return (
    <SectionCard
      id="repeats"
      title="Repeat watch"
      className="half"
      hint="has a winning combination ever come back?"
      sub={`Every draw in your history compared against every other — ${pairsTotal.toLocaleString()} pairs checked for full and partial matches.`}
    >
      {never ? (
        <div className="notice" style={{ marginBottom: 14 }}>
          <strong style={{ color: 'var(--ink)' }}>
            No — in {r.totalDraws.toLocaleString()} draws, no full {D}-number combination has ever repeated.
          </strong>{' '}
          That is exactly what the math predicts: with {r.possibleCombos.toLocaleString()} possible combinations, pure
          chance would produce ≈{fmtExpected(r.expectedRepeats)} full repeats in a history this size. A repeat here
          would be the surprise, not the absence of one.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
          <div className="notice warn">
            <strong>{r.exactRepeats.length} full combination{r.exactRepeats.length === 1 ? ' has' : 's have'} repeated</strong>{' '}
            (chance expected ≈{fmtExpected(r.expectedRepeats)}):
          </div>
          {r.exactRepeats.slice(0, 4).map((e) => (
            <div className="repeat-row" key={e.numbers.join('-')}>
              {e.numbers.map((n) => <Ball key={n} n={n} size="sm" />)}
              <span className="meta">{e.dates.map((d) => formatDate(d)).join(' · ')}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mini-title">Closest recurrence ever: {r.maxOverlap} of {D} numbers shared</div>
      <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
        {r.closestPairs.slice(0, 3).map((p) => (
          <div className="repeat-row" key={`${p.dateA}-${p.dateB}`}>
            {p.shared.map((n) => <Ball key={n} n={n} size="sm" variant="match" />)}
            <span className="meta">{formatDate(p.dateA)} ↔ {formatDate(p.dateB)}</span>
          </div>
        ))}
      </div>

      <div className="mini-title">Partial matches between any two draws</div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Numbers shared</th>
              <th className="num">Pairs observed</th>
              <th className="num">Chance expects</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: D - 2 }, (_, i) => D - i).map((k) => (
              <tr key={k}>
                <td style={{ fontWeight: 620 }}>{k} of {D}{k === D ? ' (full repeat)' : ''}</td>
                <td className="num" style={{ fontWeight: 640 }}>{(r.pairsByOverlap[k] ?? 0).toLocaleString()}</td>
                <td className="num" style={{ color: 'var(--muted)' }}>{fmtExpected(r.expectedByOverlap[k] ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="hint" style={{ display: 'block', marginTop: 12 }}>
        Honest odds note: skipping past winners does not raise your win probability — every combination, including a
        past winner, has the same 1-in-{r.possibleCombos.toLocaleString()} shot next draw, and avoiding them removes
        only {fmtPct(shareRemoved, shareRemoved < 0.0005 ? 3 : 2)} of the ticket space. It costs nothing either, and a
        unique line has one real perk: fewer people play it, so a jackpot is less likely to be split. The model's Best
        combination is auto-checked against your history — look for the "never drawn before" tag on the prediction.
      </p>
    </SectionCard>
  )
}
