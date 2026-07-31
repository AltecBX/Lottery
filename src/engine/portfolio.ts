import { US_LOWER_TIERS } from './jackpot.ts'
import { matchOdds } from './odds.ts'
import type { PrizeTier } from './ticket.ts'

/** Deterministic PRNG so the same inputs always produce the same figures. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface PortfolioTicket {
  numbers: number[]
  special?: number
}

export interface PortfolioStats {
  /** How many different numbers the whole portfolio covers */
  distinctNumbers: number
  /** Chance at least one ticket matches this many mains */
  pAtLeast3: number
  pAtLeast4: number
  /** Chance at least one ticket wins any prize at all */
  pAnyPrize: number
  /** Average of the best single-ticket match count */
  avgBestMatch: number
}

/*
 * Deliberately absent: expected dollars back. Expected value is exactly linear
 * in the number of tickets and completely blind to how they overlap, so it is
 * identical for every arrangement here and says nothing — and simulating it is
 * worse than useless, because the average is dominated by prizes rare enough
 * that a run of this size sees none of them. `lowerTierValue` computes it in
 * closed form instead.
 */

export interface PortfolioResult {
  tickets: PortfolioTicket[]
  stats: PortfolioStats
  /** The same measurements for the same number of pure random tickets */
  quickPick: PortfolioStats
  /** Every ticket being a copy of the model's single best pick */
  concentrated: PortfolioStats
  trials: number
}

/**
 * Choose the numbers for one ticket, discounting each number's score once for
 * every earlier ticket that already used it.
 *
 * The discount is multiplicative, so the two ends of the slider are exact
 * rather than approximate: at `spread` 0 nothing is discounted and every ticket
 * rebuilds the same top pick, while at 1 a used number keeps a millionth of its
 * score and is never taken again until the pool runs out. Raw score breaks ties
 * so the choice stays sensible even then.
 */
function pickTicket(
  scores: Float64Array, K: number, D: number, used: Int32Array, spread: number,
): number[] {
  const keep = Math.max(1e-6, 1 - spread)
  const order: number[] = []
  for (let i = 1; i <= K; i++) order.push(i)
  order.sort((a, b) => {
    const sa = scores[a] * Math.pow(keep, used[a])
    const sb = scores[b] * Math.pow(keep, used[b])
    return sb - sa || scores[b] - scores[a] || a - b
  })
  const picked = order.slice(0, D)
  for (const n of picked) used[n]++
  return picked.sort((a, b) => a - b)
}

/** Uniformly sample D distinct numbers from 1..K (partial Fisher–Yates). */
function sampleDraw(K: number, D: number, pool: Int32Array, rnd: () => number): Int32Array {
  for (let i = 0; i < D; i++) {
    const j = i + Math.floor(rnd() * (K - i))
    const tmp = pool[i]
    pool[i] = pool[j]
    pool[j] = tmp
  }
  return pool
}

/**
 * Measure a set of tickets by simulation against fair random draws. Fair is the
 * point: the coverage advantage of spreading numbers across tickets is a
 * property of the tickets themselves, so it holds no matter which numbers come
 * up — unlike anything that assumes the model is right.
 */
export function scorePortfolio(
  tickets: PortfolioTicket[],
  K: number,
  D: number,
  specialK: number,
  trials: number,
  seed: number,
  tiers: PrizeTier[] = US_LOWER_TIERS,
): PortfolioStats {
  const rnd = mulberry32(seed)
  const pool = new Int32Array(K)
  for (let i = 0; i < K; i++) pool[i] = i + 1
  const mask = new Uint8Array(K + 1)

  // Flatten the prize table into a [mains][specialHit] lookup
  const prizeAt = new Float64Array((D + 1) * 2)
  for (const t of tiers) {
    if (t.match <= D) prizeAt[t.match * 2 + (t.withSpecial ? 1 : 0)] = t.prize
  }

  let hit3 = 0
  let hit4 = 0
  let anyPrize = 0
  let bestSum = 0

  for (let trial = 0; trial < trials; trial++) {
    const drawn = sampleDraw(K, D, pool, rnd)
    for (let i = 0; i < D; i++) mask[drawn[i]] = 1
    const specialDrawn = specialK > 0 ? 1 + Math.floor(rnd() * specialK) : 0

    let best = 0
    let paid = 0
    for (const t of tickets) {
      let m = 0
      for (const n of t.numbers) m += mask[n]
      if (m > best) best = m
      const sp = specialK > 0 && t.special === specialDrawn ? 1 : 0
      if (prizeAt[m * 2 + sp] > 0) paid = 1
    }
    if (best >= 3) hit3++
    if (best >= 4) hit4++
    anyPrize += paid
    bestSum += best

    for (let i = 0; i < D; i++) mask[drawn[i]] = 0
  }

  const distinct = new Set<number>()
  for (const t of tickets) for (const n of t.numbers) distinct.add(n)

  return {
    distinctNumbers: distinct.size,
    pAtLeast3: hit3 / trials,
    pAtLeast4: hit4 / trials,
    pAnyPrize: anyPrize / trials,
    avgBestMatch: bestSum / trials,
  }
}

/**
 * Exact expected dollars back per ticket from the fixed lower tiers, jackpot
 * excluded. Closed form, because these probabilities are known exactly and a
 * simulation would just add noise to a number that has none.
 */
export function lowerTierValue(K: number, D: number, specialK: number, tiers: PrizeTier[] = US_LOWER_TIERS): number {
  let ev = 0
  for (const t of tiers) {
    if (t.match > D) continue
    const pMains = 1 / matchOdds(K, D, t.match)
    const p = specialK > 0 ? pMains * (t.withSpecial ? 1 / specialK : 1 - 1 / specialK) : pMains
    ev += p * t.prize
  }
  return ev
}

export interface PortfolioOptions {
  /** Model score per number, index 1..K (probabilities or z-scores, both work) */
  scores: Float64Array
  K: number
  D: number
  /** Bonus pool size, 0 when the game has none */
  specialK: number
  /** Ranked bonus-ball candidates, best first */
  specialPicks: number[]
  count: number
  /** 0 = every ticket is the same top pick, 1 = cover as many numbers as possible */
  spread: number
  trials?: number
  seed?: number
  tiers?: PrizeTier[]
}

/**
 * Build a set of tickets to play together.
 *
 * Buying five tickets that are near-copies of one another wastes four of them:
 * they win and lose at the same time. Spreading the model's best numbers across
 * the tickets keeps the same per-number quality while covering far more of the
 * pool, which raises the chance that *something* hits. It lowers the chance of
 * one ticket catching several at once — that trade is exactly what the returned
 * numbers let you see.
 */
export function buildPortfolio(opts: PortfolioOptions): PortfolioResult {
  const { scores, K, D, specialK, specialPicks, count, spread } = opts
  const trials = opts.trials ?? 20000
  const seed = opts.seed ?? 0x5eed
  const tiers = opts.tiers ?? US_LOWER_TIERS

  // Bonus balls get spread too. Matching the bonus alone already pays, so
  // repeating one across every ticket throws away the cheapest coverage there
  // is: the model's ranked candidates come first, then the rest of the pool.
  const specialOrder: number[] = []
  const seenSpecial = new Set<number>()
  for (const s of specialPicks) {
    if (Number.isInteger(s) && s >= 1 && s <= specialK && !seenSpecial.has(s)) {
      seenSpecial.add(s)
      specialOrder.push(s)
    }
  }
  for (let s = 1; s <= specialK; s++) {
    if (!seenSpecial.has(s)) { seenSpecial.add(s); specialOrder.push(s) }
  }

  const used = new Int32Array(K + 1)
  const tickets: PortfolioTicket[] = []
  for (let t = 0; t < count; t++) {
    const numbers = pickTicket(scores, K, D, used, spread)
    const ticket: PortfolioTicket = { numbers }
    if (specialK > 0) {
      // At zero spread every ticket is one pick repeated, bonus ball included
      ticket.special = spread === 0 ? specialOrder[0] : specialOrder[t % specialOrder.length]
    }
    tickets.push(ticket)
  }

  // Same count, every ticket identical to the model's single best pick
  const topUsed = new Int32Array(K + 1)
  const top = pickTicket(scores, K, D, topUsed, 0)
  const concentrated: PortfolioTicket[] = Array.from({ length: count }, () => {
    const t: PortfolioTicket = { numbers: top }
    if (specialK > 0) t.special = specialPicks[0] ?? 1
    return t
  })

  // Same count, drawn at random — what a counter quick pick gives you
  const rnd = mulberry32(seed ^ 0x9e3779b9)
  const pool = new Int32Array(K)
  for (let i = 0; i < K; i++) pool[i] = i + 1
  const quick: PortfolioTicket[] = Array.from({ length: count }, () => {
    const drawn = sampleDraw(K, D, pool, rnd)
    const t: PortfolioTicket = { numbers: Array.from(drawn.slice(0, D)).sort((a, b) => a - b) }
    if (specialK > 0) t.special = 1 + Math.floor(rnd() * specialK)
    return t
  })

  return {
    tickets,
    stats: scorePortfolio(tickets, K, D, specialK, trials, seed, tiers),
    quickPick: scorePortfolio(quick, K, D, specialK, trials, seed, tiers),
    concentrated: scorePortfolio(concentrated, K, D, specialK, trials, seed, tiers),
    trials,
  }
}
