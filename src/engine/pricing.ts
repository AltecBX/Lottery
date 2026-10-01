import type { SyncKey } from './sync.ts'
import type { PrizeTier } from './ticket.ts'
import { US_LOWER_TIERS } from './jackpot.ts'

/**
 * What one play of a game costs, and what it pays below the jackpot.
 *
 * Every figure here used to be Powerball's, for every game: a $2 ticket and
 * Powerball's prize table. That has been wrong for Mega Millions since its
 * April 2025 overhaul, which raised the ticket to $5, rebuilt the prize table
 * and put a multiplier on every ticket — so its "a ticket is worth" line, its
 * value and jackpot panels, and every saved Mega Millions ticket in the ledger
 * were priced as a different game.
 */
export interface GamePricing {
  /** Dollars per play */
  price: number
  /** Fixed prizes below the jackpot, before any multiplier */
  tiers: PrizeTier[]
  /**
   * A multiplier printed on every ticket and applied to every prize below the
   * jackpot, with its published odds as weights. Null when the game has none
   * built in — Powerball's Power Play is an optional extra the app does not
   * price, so a Powerball ticket here is the plain $2 one.
   */
  multiplier: { value: number; weight: number }[] | null
}

/**
 * Mega Millions since 8 April 2025, from megamillions.com: "tickets cost $5.00
 * per play, with a multiplier included", and the multiplier odds are 2x 1 in
 * 2.13, 3x 1 in 3.2, 4x 1 in 8, 5x 1 in 16, 10x 1 in 32 — exactly 15, 10, 4,
 * 2 and 1 in 32. The winner counts the official results service reports split
 * the same way (213,922 low-tier winners on 29 September 2026: 46.8%, 31.3%,
 * 12.6%, 6.2%, 3.1%). The multiplier is assigned per ticket at purchase, not
 * per draw: one draw has winners at every multiplier.
 *
 * The base prizes are read off the multiplied columns of the official prize
 * matrix, which are the amounts actually paid. The matrix's own "PrizeAmount"
 * column still carries pre-2025 values for two tiers ($4 and $2 where the
 * multiplied amounts imply $7 and $5) and $599 where $500 is meant, so it is
 * not used. California pays these tiers pari-mutuel; these are the fixed
 * amounts every other state pays.
 */
export const MEGA_MILLIONS_2025: GamePricing = {
  price: 5,
  tiers: [
    { match: 5, withSpecial: false, prize: 1_000_000 },
    { match: 4, withSpecial: true, prize: 10_000 },
    { match: 4, withSpecial: false, prize: 500 },
    { match: 3, withSpecial: true, prize: 200 },
    { match: 3, withSpecial: false, prize: 10 },
    { match: 2, withSpecial: true, prize: 10 },
    { match: 1, withSpecial: true, prize: 7 },
    { match: 0, withSpecial: true, prize: 5 },
  ],
  multiplier: [
    { value: 2, weight: 15 },
    { value: 3, weight: 10 },
    { value: 4, weight: 4 },
    { value: 5, weight: 2 },
    { value: 10, weight: 1 },
  ],
}

export const POWERBALL: GamePricing = { price: 2, tiers: US_LOWER_TIERS, multiplier: null }

/**
 * The rules a game's next ticket is bought under. A game without an official
 * source keeps the $2 Powerball-style structure the app has always assumed.
 *
 * Only the current rules are modelled. Every ticket the app can save is
 * stamped for an upcoming draw, so none predates the 2025 Mega Millions
 * change, and pricing a pre-2025 ticket would need that era's table, which no
 * source the app reads still publishes.
 */
export function pricingFor(key: SyncKey | string | undefined): GamePricing {
  return key === 'megamillions' ? MEGA_MILLIONS_2025 : POWERBALL
}

/** The average multiplier — what every prize below the jackpot is worth in expectation. */
export function meanMultiplier(p: GamePricing): number {
  if (!p.multiplier) return 1
  let w = 0
  let v = 0
  for (const m of p.multiplier) { w += m.weight; v += m.weight * m.value }
  return w > 0 ? v / w : 1
}

/** The smallest multiplier a ticket can carry — the provable floor of any prize. */
export function minMultiplier(p: GamePricing): number {
  return p.multiplier ? Math.min(...p.multiplier.map((m) => m.value)) : 1
}

export function maxMultiplier(p: GamePricing): number {
  return p.multiplier ? Math.max(...p.multiplier.map((m) => m.value)) : 1
}

/** "$5", "$2" — the ticket price as the UI prints it. */
export const priceLabel = (p: GamePricing): string =>
  `$${Number.isInteger(p.price) ? p.price : p.price.toFixed(2)}`
