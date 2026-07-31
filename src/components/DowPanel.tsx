import type { EngineResult } from '../engine/types.ts'
import { DOW_NAMES } from '../engine/dates.ts'
import { SectionCard, Ball, fmtPct } from './shared.tsx'

export function DowPanel({ res }: { res: EngineResult }) {
  return (
    <SectionCard
      collapsible
      id="dow"
      title="Day of week analysis"
      className="half"
      sub={`This game draws on ${res.scheduleDows.map((d) => DOW_NAMES[d]).join(', ')}. Top numbers per weekday, with their lift vs the overall rate.`}
    >
      {res.weekdayTest.length > 0 && (() => {
        const worst = res.weekdayTest.reduce((a, b) => (Math.abs(b.z) > Math.abs(a.z) ? b : a))
        const real = worst.z > 3
        return (
          <div className={`notice${real ? ' warn' : ''}`} style={{ marginBottom: 14 }}>
            <strong style={{ color: 'var(--ink)' }}>
              {real
                ? `${DOW_NAMES[worst.dow]} draws look genuinely uneven.`
                : 'Does the weekday actually matter here? Not measurably.'}
            </strong>{' '}
            Testing every number's count on each draw day against a flat expectation, the strongest deviation is{' '}
            {DOW_NAMES[worst.dow]} at <strong>{worst.z >= 0 ? '+' : ''}{worst.z.toFixed(1)}σ</strong>
            {real
              ? ' — beyond ordinary sampling noise, so it is worth watching as more draws arrive.'
              : ' — well inside the range random draws produce, so weekday-specific "hot numbers" below are noise, not an edge.'}{' '}
            The Backtest panel shows the same verdict empirically: the day-of-week signals only earn weight if they
            actually predict.
          </div>
        )
      })()}

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Draws</th>
              <th>Most drawn on this day</th>
            </tr>
          </thead>
          <tbody>
            {res.dowProfiles.map((p) => (
              <tr key={p.dow}>
                <td style={{ fontWeight: 620, whiteSpace: 'nowrap' }}>
                  {DOW_NAMES[p.dow]}
                  {p.dow === res.nextDow && <span style={{ color: 'var(--accent)', fontSize: 11.5, marginLeft: 6, fontWeight: 650 }}>next</span>}
                </td>
                <td className="num">{p.draws}</td>
                <td>
                  <div className="chip-row">
                    {p.top.map((t) => (
                      <span className="pair-cell" key={t.number} title={`${t.count}× on ${DOW_NAMES[p.dow]}s — ${fmtPct(t.rate)} vs ${fmtPct(t.rate / Math.max(0.0001, t.lift))} overall`}>
                        <Ball n={t.number} size="sm" />
                        <span style={{ fontSize: 11.5, color: t.lift >= 1.25 ? 'var(--good-text)' : 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                          {t.lift.toFixed(2)}×
                        </span>
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {res.backtest.byDow.length > 1 && (
        <>
          <div className="mini-title" style={{ marginTop: 14 }}>Backtest accuracy by day (hits in top-10)</div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Day</th><th className="num">Ensemble</th><th className="num">Frequency</th><th className="num">Chance</th></tr>
              </thead>
              <tbody>
                {res.backtest.byDow.map((d) => (
                  <tr key={d.dow}>
                    <td>{DOW_NAMES[d.dow]}</td>
                    <td className="num" style={{ fontWeight: 640, color: d.ensemble10 > res.backtest.chance10 ? 'var(--good-text)' : undefined }}>{d.ensemble10.toFixed(2)}</td>
                    <td className="num">{d.baseline10.toFixed(2)}</td>
                    <td className="num" style={{ color: 'var(--muted)' }}>{res.backtest.chance10.toFixed(2)}</td>
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
