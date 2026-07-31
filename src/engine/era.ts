import type { Draw } from './types.ts'

export interface EraInfo {
  /** ISO date the current rule era begins */
  cutoffDate: string
  /** Index of the first draw in the current era */
  cutoffIndex: number
  /** Draws that belong to earlier rule eras */
  excluded: number
  /** Draws inside the current era */
  kept: number
  /** Main pool before and after the change */
  earlyMax: number
  currentMax: number
  /** Bonus pool before and after, 0 when the game has none */
  earlySpecialMax: number
  currentSpecialMax: number
}

const maxMain = (draws: Draw[]): number => {
  let m = 0
  for (const d of draws) for (const n of d.sorted) if (n > m) m = n
  return m
}

const maxSpecial = (draws: Draw[]): number => {
  let m = 0
  for (const d of draws) if (d.special !== undefined && d.special > m) m = d.special
  return m
}

/** Below this the split is not worth making — the model needs history to learn from. */
const MIN_ERA_DRAWS = 120

/**
 * Find where the game's current rules start.
 *
 * Lotteries change their number pools every few years, and draws from an older
 * matrix quietly corrupt everything downstream: they inflate the apparent pool
 * size, which inflates the jackpot odds, which wrecks expected value; and they
 * flatten frequency stats, which is where most of a suspiciously large "model
 * edge" usually comes from. Powerball's 2015 change alone moved the mains from
 * 59 to 69 and the bonus ball from 35 down to 26.
 *
 * Two things give an era boundary away, and both are needed:
 *
 *  - a draw containing a number the current rules cannot produce (the pool
 *    shrank), which is decisive; and
 *  - a long early stretch that never once reaches the numbers now in play (the
 *    pool grew), which is statistical but unmistakable over hundreds of draws.
 *
 * The later of the two boundaries wins. Returns null when the history is all
 * one era, or too short to be worth splitting.
 */
export function detectEra(draws: Draw[]): EraInfo | null {
  if (draws.length < MIN_ERA_DRAWS * 2) return null

  // Read the rules in force from a recent window — long enough to sample the
  // whole pool, short enough to sit inside a single era.
  const windowSize = Math.max(60, Math.floor(draws.length * 0.05))
  const recent = draws.slice(-windowSize)
  const currentMax = maxMain(recent)
  const currentSpecialMax = maxSpecial(recent)
  if (currentMax === 0) return null

  // Decisive: the last draw the current rules could not have produced. This is
  // a floor, not the boundary — a shrinking pool keeps producing legal-looking
  // draws for a while before it changes, so the true changeover is at or after
  // this point, never before it.
  let cutoffIndex = 0
  for (let i = draws.length - 1; i >= 0; i--) {
    const d = draws[i]
    const overMain = d.sorted.some((n) => n > currentMax)
    const overSpecial = currentSpecialMax > 0 && d.special !== undefined && d.special > currentSpecialMax
    if (overMain || overSpecial) { cutoffIndex = i + 1; break }
  }

  if (cutoffIndex > 0) {
    // Pools usually change together — Powerball's mains went 59 → 69 the same
    // day its bonus ball went 35 → 26. Everything before the floor is certainly
    // old, so the first draw from there on reaching a number no old draw could
    // is the era's real opening day, weeks later than the floor alone suggests.
    const priorMax = maxMain(draws.slice(0, cutoffIndex))
    if (currentMax > priorMax) {
      for (let i = cutoffIndex; i < draws.length; i++) {
        if (draws[i].sorted.some((n) => n > priorMax)) { cutoffIndex = i; break }
      }
    }
  } else {
    // Nothing was ever impossible, so any change was a pool that only grew.
    // That shows up as a long early stretch never once reaching today's top.
    const head = draws.slice(0, Math.floor(draws.length * 0.3))
    const headMax = maxMain(head)
    if (currentMax >= headMax + 6) {
      const first = draws.findIndex((d) => d.sorted.some((n) => n > headMax))
      if (first > 0) cutoffIndex = first
    }
  }

  if (cutoffIndex === 0) return null
  const kept = draws.length - cutoffIndex
  if (kept < MIN_ERA_DRAWS) return null

  const before = draws.slice(0, cutoffIndex)
  return {
    cutoffDate: draws[cutoffIndex].date,
    cutoffIndex,
    excluded: cutoffIndex,
    kept,
    earlyMax: maxMain(before),
    currentMax,
    earlySpecialMax: maxSpecial(before),
    currentSpecialMax,
  }
}

/**
 * The draws to analyze. `'current'` (the default) keeps only the current rule
 * era; `'all'` uses everything. Nothing is deleted either way — this is a view
 * over the stored history, so the choice is always reversible.
 */
export function drawsForEra(draws: Draw[], era: 'current' | 'all', info: EraInfo | null): Draw[] {
  if (era === 'all' || !info) return draws
  return draws.slice(info.cutoffIndex)
}
