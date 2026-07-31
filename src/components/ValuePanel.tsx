import { useMemo, useState } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import type { GameData } from '../engine/games.ts'
import type { JackpotFeed } from '../engine/feed.ts'
import { US_LOWER_TIERS, ticketValue } from '../engine/jackpot.ts'
import { formatOdds } from '../engine/odds.ts'
import { resolveNextDraw, bigMoney } from './NextDraw.tsx'
import { SectionCard, Tile, fmtPct } from './shared.tsx'

const money = (n: number) => `$${n.toFixed(2)}`

/** Median of the most recent recorded sales figures, as a stand-in for turnout. */
function typicalSales(draws: Draw[]): number | null {
  const recent = draws.slice(-40).map((d) => d.sales).filter((s): s is number => s !== undefined && s > 0)
  if (recent.length < 3) return null
  const sorted = [...recent].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * What a ticket is actually worth at tonight's prize.
 *
 * Jackpots are the one part of a lottery that genuinely changes the maths: the
 * odds never move, but the payout does, so the expected value of the same $2
 * ticket swings by a factor of ten across a roll. This panel puts a number on
 * it — including the part most coverage leaves out, which is that a big prize
 * draws a crowd and a crowd means splitting it.
 */
export function ValuePanel({ res, game, draws, feed, drawTime }: {
  res: EngineResult
  game: GameData | undefined
  draws: Draw[]
  feed: JackpotFeed | null
  drawTime: string
}) {
  const info = useMemo(() => resolveNextDraw(res, game, draws, feed, drawTime), [res, game, draws, feed, drawTime])
  const observed = useMemo(() => typicalSales(draws), [draws])

  // NY publishes statewide sales; New York is roughly a twelfth of the national
  // handle, so the national ticket count is estimated from it and stays adjustable.
  const [multiple, setMultiple] = useState(12)
  // The advertised figure is an annuity paid over 30 years; the cash value is
  // what a winner actually receives today, so that is the honest default.
  const [useAnnuity, setUseAnnuity] = useState(false)

  const prize = !useAnnuity && info.cashValue ? info.cashValue : info.amount
  const ticketsSold = observed !== null ? Math.round((observed * multiple) / 2) : null

  const value = useMemo(() => {
    if (!prize) return null
    return ticketValue(res.K, res.drawSize, res.special?.K ?? 0, prize, ticketsSold, 2, US_LOWER_TIERS)
  }, [prize, ticketsSold, res.K, res.drawSize, res.special?.K])

  if (!value || !prize) {
    return (
      <SectionCard
        id="value"
        title="Is it worth it"
        className="half"
        sub="What one ticket is mathematically worth at the current jackpot."
      >
        <p className="hint" style={{ display: 'block' }}>
          No jackpot figure for {res.nextDate} yet. The published feed fills this in automatically for Powerball and
          Mega Millions; for any other game, tap the amount in the prediction card to type it.
        </p>
      </SectionCard>
    )
  }

  const net = value.adjustedEv - 2
  const breakEven = value.grossEv > 0 ? (2 - (value.grossEv - (1 / value.jackpotOdds) * prize)) * value.jackpotOdds : 0

  return (
    <SectionCard
      id="value"
      title="Is it worth it"
      className="half"
      sub={`What a $2 ticket returns on average at ${bigMoney(prize)}${useAnnuity ? ' advertised' : ' cash'} — the odds never move, but the payout does.`}
    >
      <div className="tiles">
        <Tile
          label="Value of a $2 ticket"
          value={money(value.adjustedEv)}
          delta={
            ticketsSold === null ? `${net >= 0 ? money(net) : money(-net)} ${net >= 0 ? 'above' : 'short of'} its price — split risk not counted`
              : net >= 0 ? `${money(net)} above its price` : `${money(-net)} short of its price`
          }
          deltaDir={ticketsSold === null ? 'flat' : net >= 0 ? 'up' : 'down'}
        />
        <Tile label="Before any split" value={money(value.grossEv)} delta="if you were the only winner" />
        <Tile
          label="Chance of sharing it"
          value={value.splitChance !== null ? fmtPct(value.splitChance, 0) : '—'}
          delta={ticketsSold !== null ? `${(ticketsSold / 1e6).toFixed(0)}M tickets estimated` : 'no sales data yet'}
        />
        <Tile
          label="Jackpot odds"
          value={formatOdds(value.jackpotOdds).replace(' million', 'M').replace(' billion', 'B')}
          delta="identical for every ticket ever sold"
        />
      </div>

      <div className="value-controls">
        {info.cashValue && info.amount && (
          <label className="chk">
            <input type="checkbox" checked={useAnnuity} onChange={(e) => setUseAnnuity(e.target.checked)} />
            <span>
              Price the advertised annuity ({bigMoney(info.amount)}) instead of the cash value
              ({bigMoney(info.cashValue)}) — the annuity pays out over 30 years
            </span>
          </label>
        )}
        {observed !== null && (
          <label className="rng">
            <span>National sales ≈ {multiple}× New York's</span>
            <input
              type="range" min={4} max={24} step={1} value={multiple}
              onChange={(e) => setMultiple(Number(e.target.value))}
            />
          </label>
        )}
      </div>

      <p className="hint" style={{ display: 'block' }}>
        {net >= 0 ? (
          <>
            At this prize the average return clears the ticket price — the rare state a jackpot game reaches near the
            top of a long roll{ticketsSold === null && ', though only because there is no sales figure here to price the'
              + ' split with, and a prize this size is exactly when splitting becomes likely'}. It still does not make
            the ticket likely to win: {formatOdds(value.jackpotOdds)} is {formatOdds(value.jackpotOdds)} whatever the
            payout is. The positive average comes from a huge prize on a tiny probability, so the median outcome is
            unchanged — you lose $2. Tax takes roughly a quarter to a third of anything above it.
          </>
        ) : (
          <>
            The average $2 ticket comes back as {money(value.adjustedEv)} at this prize. It would take about{' '}
            {breakEven > 0 && Number.isFinite(breakEven) ? bigMoney(breakEven) : 'an unreachable jackpot'} for the
            average to reach the ticket price, before tax — and sharing the prize pushes that higher still.
          </>
        )}
        {observed === null && ' No ticket-sales data has synced for this game yet, so the split estimate is unavailable;'
          + ' sync the official results to fill it in.'}
      </p>
    </SectionCard>
  )
}
