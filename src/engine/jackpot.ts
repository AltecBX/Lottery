import type { Draw } from './types.ts'
import { choose, matchOdds, jackpotOdds } from './odds.ts'

export interface JackpotStats {
  /** Draws that carry a jackpot amount */
  withJackpot: number
  latest: { date: string; amount: number } | null
  biggest: { date: string; amount: number } | null
  median: number
  /** Consecutive most-recent draws with no recorded winner location (rollover run) */
  rolloverRun: number
  /** Draws that recorded where a winning ticket was sold */
  winners: { date: string; location: string; amount?: number }[]
  /** Draws that carry synced ticket-sales figures */
  withSales: number
  latestSales: { date: string; amount: number } | null
  /** Pearson correlation between jackpot size and ticket sales, when both exist */
  salesVsJackpot: { r: number; n: number } | null
  /**
   * Honest check: do big-jackpot draws produce different numbers than small
   * ones? Compares the mean drawn number in the top vs bottom jackpot third
   * with a two-sample t-statistic. |t| under ~2 means no detectable difference.
   */
  jackpotVsNumbers: { t: number; highMean: number; lowMean: number; n: number } | null
}

/** Expected value of one ticket, given a jackpot and the game's prize structure. */
export interface TicketValue {
  jackpot: number
  ticketPrice: number
  /** Sum over prize tiers of probability x prize, before tax */
  grossEv: number
  /** Chance at least one other ticket matches all numbers, given tickets sold */
  splitChance: number | null
  /** Gross EV adjusted for expected sharing */
  adjustedEv: number
  jackpotOdds: number
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

export function analyzeJackpots(draws: Draw[]): JackpotStats {
  const withJ = draws.filter((d) => d.jackpot !== undefined && d.jackpot > 0)
  const withS = draws.filter((d) => d.sales !== undefined && d.sales > 0)

  let biggest: JackpotStats['biggest'] = null
  for (const d of withJ) {
    if (!biggest || d.jackpot! > biggest.amount) biggest = { date: d.date, amount: d.jackpot! }
  }
  const last = withJ.length ? withJ[withJ.length - 1] : null
  const lastSales = withS.length ? withS[withS.length - 1] : null

  const sortedAmounts = withJ.map((d) => d.jackpot!).sort((a, b) => a - b)
  const median = sortedAmounts.length ? sortedAmounts[Math.floor(sortedAmounts.length / 2)] : 0

  const winners = draws
    .filter((d) => d.winnerLocation)
    .map((d) => ({ date: d.date, location: d.winnerLocation!, amount: d.jackpot }))
    .reverse()

  let rolloverRun = 0
  for (let i = draws.length - 1; i >= 0; i--) {
    if (draws[i].winnerLocation) break
    rolloverRun++
  }
  // No winner column at all is not a record-breaking rollover. Without this the
  // panel read "0 winners · 3,537 draws since the last one" for any history
  // that simply never carried the column.
  if (winners.length === 0) rolloverRun = 0

  // Sales vs jackpot correlation
  let salesVsJackpot: JackpotStats['salesVsJackpot'] = null
  const both = draws.filter((d) => d.jackpot !== undefined && d.sales !== undefined)
  if (both.length >= 8) {
    const xs = both.map((d) => d.jackpot!)
    const ys = both.map((d) => d.sales!)
    const mx = mean(xs), my = mean(ys)
    let num = 0, dx = 0, dy = 0
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my)
      dx += (xs[i] - mx) ** 2
      dy += (ys[i] - my) ** 2
    }
    const r = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0
    salesVsJackpot = { r, n: both.length }
  }

  // Does jackpot size relate to the numbers drawn? (It should not.)
  let jackpotVsNumbers: JackpotStats['jackpotVsNumbers'] = null
  if (withJ.length >= 30) {
    const byAmount = [...withJ].sort((a, b) => a.jackpot! - b.jackpot!)
    const third = Math.floor(byAmount.length / 3)
    const lowNums = byAmount.slice(0, third).flatMap((d) => d.sorted)
    const highNums = byAmount.slice(-third).flatMap((d) => d.sorted)
    const m1 = mean(highNums), m2 = mean(lowNums)
    const v = (xs: number[], m: number) => xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)
    const se = Math.sqrt(v(highNums, m1) / highNums.length + v(lowNums, m2) / lowNums.length)
    jackpotVsNumbers = { t: se > 0 ? (m1 - m2) / se : 0, highMean: m1, lowMean: m2, n: third }
  }

  return {
    withJackpot: withJ.length,
    latest: last ? { date: last.date, amount: last.jackpot! } : null,
    biggest,
    median,
    rolloverRun,
    winners,
    withSales: withS.length,
    latestSales: lastSales ? { date: lastSales.date, amount: lastSales.sales! } : null,
    salesVsJackpot,
    jackpotVsNumbers,
  }
}

/**
 * Expected value of a ticket. Prize tiers below the jackpot use published
 * fixed amounts where given; the jackpot term is discounted by the chance the
 * prize gets shared, estimated from how many tickets were actually sold.
 */
export function ticketValue(
  K: number,
  D: number,
  specialK: number,
  jackpot: number,
  ticketsSold: number | null,
  ticketPrice = 2,
  lowerTiers: { match: number; withSpecial: boolean; prize: number }[] = [],
): TicketValue {
  const jOdds = specialK > 0 ? jackpotOdds(K, D, specialK) : matchOdds(K, D, D)
  const pJackpot = 1 / jOdds

  let grossEv = 0
  for (const tier of lowerTiers) {
    const pMains = 1 / matchOdds(K, D, tier.match)
    const p = specialK > 0 ? pMains * (tier.withSpecial ? 1 / specialK : 1 - 1 / specialK) : pMains
    grossEv += p * tier.prize
  }

  // Sharing: other tickets are (near enough) independent draws from the pool
  let splitChance: number | null = null
  let jackpotTerm = pJackpot * jackpot
  if (ticketsSold !== null && ticketsSold > 0) {
    const others = ticketsSold
    // Expected payout share = (1 - (1-p)^n) / (n*p) for n other tickets
    const np = others * pJackpot
    splitChance = 1 - Math.exp(-np)
    const shareFactor = np > 1e-9 ? (1 - Math.exp(-np)) / np : 1
    jackpotTerm = pJackpot * jackpot * shareFactor
  }
  grossEv += pJackpot * jackpot

  return {
    jackpot,
    ticketPrice,
    grossEv,
    splitChance,
    adjustedEv: grossEv - pJackpot * jackpot + jackpotTerm,
    jackpotOdds: jOdds,
  }
}

export interface JackpotProjection {
  amount: number
  /** 'rollover' = grown from the last draw; 'reset' = the last draw had a winner */
  basis: 'rollover' | 'reset'
  /** How many past steps the estimate was measured from */
  samples: number
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * Estimate the advertised jackpot for the next draw from this history's own
 * behaviour: the typical roll-up between consecutive draws with no winner, or
 * the typical starting amount after a jackpot is hit. It is an estimate, and
 * the UI labels it as one — the exact figure can always be typed in.
 */
export function projectNextJackpot(draws: Draw[]): JackpotProjection | null {
  const withJ = draws.filter((d) => d.jackpot !== undefined && d.jackpot > 0)
  if (withJ.length < 4) return null
  const last = withJ[withJ.length - 1]

  // A recorded winner means the prize resets for the next draw
  if (last.winnerLocation) {
    const resets: number[] = []
    for (let i = 1; i < withJ.length; i++) {
      if (withJ[i - 1].winnerLocation) resets.push(withJ[i].jackpot!)
    }
    if (resets.length === 0) return null
    return { amount: median(resets.slice(-20)), basis: 'reset', samples: resets.length }
  }

  // Otherwise it rolls over: use the typical recent increase
  const steps: number[] = []
  for (let i = 1; i < withJ.length; i++) {
    if (withJ[i - 1].winnerLocation) continue
    const diff = withJ[i].jackpot! - withJ[i - 1].jackpot!
    if (diff > 0) steps.push(diff)
  }
  if (steps.length === 0) return null
  /*
   * One median step is only right when the last recorded amount belongs to the
   * most recent draw. When the newest draws carry no figure — the normal state
   * between a sync and the next feed update — the projection has to cover every
   * draw since. Adding a single step regardless read 40% low after ten draws.
   */
  let gap = 1
  for (let i = draws.length - 1; i >= 0; i--) {
    if (draws[i] === last) break
    gap++
  }
  return { amount: last.jackpot! + gap * median(steps.slice(-30)), basis: 'rollover', samples: steps.length }
}

/** Published Powerball / Mega Millions style fixed lower tiers (US $2 games). */
export const US_LOWER_TIERS = [
  { match: 5, withSpecial: false, prize: 1_000_000 },
  { match: 4, withSpecial: true, prize: 50_000 },
  { match: 4, withSpecial: false, prize: 100 },
  { match: 3, withSpecial: true, prize: 100 },
  { match: 3, withSpecial: false, prize: 7 },
  { match: 2, withSpecial: true, prize: 7 },
  { match: 1, withSpecial: true, prize: 4 },
  { match: 0, withSpecial: true, prize: 4 },
]

export { choose }
