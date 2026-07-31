import { useMemo } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import { analyzeJackpots, ticketValue, US_LOWER_TIERS } from '../engine/jackpot.ts'
import { formatDate } from '../engine/dates.ts'
import { formatOdds } from '../engine/odds.ts'
import { SectionCard, Tile, fmtPct } from './shared.tsx'
import { LineChart } from './charts/LineChart.tsx'

const money = (n: number): string => {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

/**
 * Jackpot size, ticket volume and what they actually mean. Jackpots do not
 * influence which balls come out — but they do decide what a win is worth and
 * how likely it is to be shared, which is real, checkable math.
 */
export function JackpotPanel({ res, draws }: { res: EngineResult; draws: Draw[] }) {
  const j = useMemo(() => analyzeJackpots(draws), [draws])
  const isUsStyle = res.drawSize === 5 && (res.special?.K ?? 0) > 0

  const value = useMemo(() => {
    if (!j.latest || !isUsStyle) return null
    // NY sales are a slice of national play; scale to a national ticket estimate.
    // NY is roughly a twelfth of Powerball/Mega ticket sales.
    const nyTickets = j.latestSales ? j.latestSales.amount / 2 : null
    const nationalTickets = nyTickets ? nyTickets * 12 : null
    return ticketValue(res.K, res.drawSize, res.special!.K, j.latest.amount, nationalTickets, 2, US_LOWER_TIERS)
  }, [j, res, isUsStyle])

  const series = useMemo(() => {
    const withJ = draws.filter((d) => d.jackpot !== undefined)
    if (withJ.length < 4) return null
    const tail = withJ.slice(-120)
    return {
      labels: tail.map((d) => d.date.slice(0, 7)),
      values: tail.map((d) => d.jackpot! / 1e6),
    }
  }, [draws])

  const salesSeries = useMemo(() => {
    const withS = draws.filter((d) => d.sales !== undefined)
    if (withS.length < 4) return null
    const tail = withS.slice(-120)
    return {
      labels: tail.map((d) => d.date.slice(0, 7)),
      values: tail.map((d) => d.sales! / 1e6),
    }
  }, [draws])

  const hasAnything = j.withJackpot > 0 || j.withSales > 0
  if (!hasAnything) {
    return (
      <SectionCard
        id="jackpot"
        title="Jackpot & players"
        className="half"
        collapsible
        hint="not in this history yet"
        sub="Jackpot amounts and winner locations are not published in the official results feed, so they come from your own data."
      >
        <div className="notice">
          <strong style={{ color: 'var(--ink)' }}>How to add them</strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
            <li>Import a CSV/Excel that has a <strong>Jackpot</strong> column (or "Prize", "Annuity", "Cash value") and optionally a <strong>Winner location</strong> column — both are detected automatically.</li>
            <li>Or type them per draw in <strong>+ Add result</strong>; both fields are optional.</li>
            <li><strong>Ticket sales sync automatically</strong> with the official results for Powerball and Mega Millions, from New York's daily retailer-sales data (2024 onward) — tap Sync.</li>
          </ul>
        </div>
      </SectionCard>
    )
  }

  return (
    <SectionCard
      id="jackpot"
      title="Jackpot & players"
      className="half"
      collapsible
      hint="what a win is worth, and who you'd share it with"
      sub="Jackpot size has no effect on which numbers are drawn — but it decides what a ticket is worth, and ticket volume decides how likely a jackpot is to be split."
    >
      <div className="tiles" style={{ marginBottom: 16 }}>
        {j.latest && <Tile label="Latest jackpot" value={money(j.latest.amount)} delta={formatDate(j.latest.date)} />}
        {j.biggest && <Tile label="Biggest recorded" value={money(j.biggest.amount)} delta={formatDate(j.biggest.date)} />}
        {j.latestSales && (
          <Tile
            label="NY ticket sales (latest draw)"
            value={money(j.latestSales.amount)}
            delta={`≈ ${Math.round(j.latestSales.amount / 2).toLocaleString()} tickets in NY alone`}
          />
        )}
        {j.winners.length > 0 && (
          <Tile label="Recorded jackpot winners" value={j.winners.length.toLocaleString()} delta={`${j.rolloverRun} draws since the last one`} />
        )}
      </div>

      {value && (
        <>
          <div className="mini-title">What a $2 ticket is actually worth at this jackpot</div>
          <div className="tbl-wrap">
            <table className="tbl">
              <tbody>
                <tr>
                  <td>Expected value per ticket</td>
                  <td className="num" style={{ fontWeight: 660, color: value.adjustedEv >= value.ticketPrice ? 'var(--good-text)' : undefined }}>
                    ${value.adjustedEv.toFixed(2)}
                  </td>
                </tr>
                <tr>
                  <td>Jackpot odds</td>
                  <td className="num">{formatOdds(value.jackpotOdds)}</td>
                </tr>
                {value.splitChance !== null && (
                  <tr>
                    <td>Chance the jackpot is shared, if you win</td>
                    <td className="num" style={{ fontWeight: 640 }}>{fmtPct(value.splitChance, 0)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ display: 'block', marginTop: 8 }}>
            Expected value sums every prize tier times its probability. Even when it edges above the $2 ticket price at
            a huge jackpot, that figure ignores taxes and the annuity discount, and the outcome is still dominated by
            the {formatOdds(value.jackpotOdds)} jackpot chance — a positive EV here is a statistical curiosity, not a
            reason to buy more tickets.
            {value.splitChance !== null && ' The split estimate scales New York sales to a national ticket count.'}
          </p>
        </>
      )}

      {series && (
        <div style={{ marginTop: 14 }}>
          <div className="mini-title">Jackpot over time ($ millions)</div>
          <LineChart
            xLabels={series.labels}
            series={[{ name: 'Jackpot', color: 'var(--accent)', values: series.values }]}
            height={170}
            yFormat={(v) => `${v.toFixed(0)}M`}
          />
        </div>
      )}

      {!series && salesSeries && (
        <div style={{ marginTop: 14 }}>
          <div className="mini-title">NY ticket sales per draw ($ millions)</div>
          <LineChart
            xLabels={salesSeries.labels}
            series={[{ name: 'NY sales', color: 'var(--series-2)', values: salesSeries.values }]}
            height={170}
            yFormat={(v) => `${v.toFixed(1)}M`}
          />
        </div>
      )}

      {j.winners.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="mini-title">Where winning tickets were sold</div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Draw</th><th>Location</th><th className="num">Jackpot</th></tr>
              </thead>
              <tbody>
                {j.winners.slice(0, 8).map((w) => (
                  <tr key={`${w.date}-${w.location}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(w.date)}</td>
                    <td>{w.location}</td>
                    <td className="num">{w.amount ? money(w.amount) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {j.salesVsJackpot && (
        <p className="hint" style={{ display: 'block', marginTop: 12 }}>
          Sales track jackpot size with a correlation of <strong>{j.salesVsJackpot.r.toFixed(2)}</strong> across{' '}
          {j.salesVsJackpot.n} draws — bigger prize, more players, and a higher chance of splitting it.
        </p>
      )}

      {j.jackpotVsNumbers && (
        <p className="hint" style={{ display: 'block', marginTop: 10 }}>
          <strong style={{ color: 'var(--ink)' }}>Does the jackpot change the numbers?</strong> Comparing the biggest
          third of jackpots against the smallest: average drawn number {j.jackpotVsNumbers.highMean.toFixed(1)} vs{' '}
          {j.jackpotVsNumbers.lowMean.toFixed(1)} (t = {j.jackpotVsNumbers.t.toFixed(2)}).{' '}
          {Math.abs(j.jackpotVsNumbers.t) < 2
            ? 'No detectable difference — exactly as expected, since the machine has no idea what the prize is.'
            : 'That gap is larger than usual sampling noise; treat it as a curiosity to watch, not a mechanism.'}
        </p>
      )}
    </SectionCard>
  )
}
