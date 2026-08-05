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
 * The shape a real draw of this game has: the range each sorted position keeps
 * to, and the range the total lands in.
 *
 * Taking the top D numbers by score alone ignores all of this, and the result is
 * not a near miss — on a live Powerball model it produced 2-4-5-6-9, a total of
 * 26 when no draw in the current era has ever totalled under 52. The numbers
 * were individually the best-scoring ones; as a combination they were a shape
 * the game has never once produced.
 */
export interface PortfolioShape {
  /** Lowest value each sorted position stays at or above */
  lo: number[]
  /** Highest value each sorted position stays at or below */
  hi: number[]
  sumLo: number
  sumHi: number
}

const inShape = (sorted: number[], shape: PortfolioShape): boolean => {
  let total = 0
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] < shape.lo[i] || sorted[i] > shape.hi[i]) return false
    total += sorted[i]
  }
  return total >= shape.sumLo && total <= shape.sumHi
}

/** Draw `want` distinct numbers from `pool`, each one's chance rising with its weight. */
function weightedSubset(
  weights: Float64Array, pool: number[], want: number, rnd: () => number, out: number[],
): void {
  out.length = 0
  if (want <= 0) return
  let remaining = 0
  for (const n of pool) remaining += weights[n]
  const taken = new Set<number>()
  for (let d = 0; d < want; d++) {
    let r = rnd() * remaining
    let chosen = -1
    for (const n of pool) {
      if (taken.has(n)) continue
      r -= weights[n]
      if (r <= 0) { chosen = n; break }
    }
    if (chosen < 0) {
      for (let i = pool.length - 1; i >= 0; i--) if (!taken.has(pool[i])) { chosen = pool[i]; break }
    }
    if (chosen < 0) break
    taken.add(chosen)
    out.push(chosen)
    remaining -= weights[chosen]
  }
}

/** How many candidate combinations each ticket is chosen from. */
const TICKET_TRIES = 1200

/**
 * How far below the best a ticket may score and still count as its equal,
 * as a fraction of the spread one ticket can span. See `pickTicket`.
 */
const TIE_SLACK = 0.02

/**
 * Choose one ticket: the best-scoring combination that both looks like a draw
 * of this game and introduces exactly `fresh` numbers no earlier ticket used.
 *
 * Taking the top D by score and calling it a ticket is what produced 2-4-5-6-9,
 * so shape is a condition of the search rather than a tie-break. It stays a
 * preference, not a wall: if nothing sampled lands inside the bands the
 * best-scoring combination is taken anyway. Nothing here is called impossible,
 * and none of it changes any ticket's odds — it decides which combinations get
 * suggested, not what they are worth.
 */
function pickTicket(
  scores: Float64Array, K: number, D: number, used: Int32Array,
  fresh: number, shape: PortfolioShape | null, rnd: () => number,
  exclude?: Set<string>, accept?: ((sorted: number[]) => boolean) | null,
): number[] {
  let hi = -Infinity
  let lo = Infinity
  for (let n = 1; n <= K; n++) {
    if (scores[n] > hi) hi = scores[n]
    if (scores[n] < lo) lo = scores[n]
  }
  const range = Math.max(1e-9, hi - lo)
  const weights = new Float64Array(K + 1)
  for (let n = 1; n <= K; n++) weights[n] = Math.exp((scores[n] - lo) / (range * 0.35))

  const unusedPool: number[] = []
  const usedPool: number[] = []
  for (let n = 1; n <= K; n++) (used[n] === 0 ? unusedPool : usedPool).push(n)
  // Honour the split only as far as the pools allow.
  const wantFresh = Math.max(0, Math.min(D, Math.min(fresh, unusedPool.length)))
  const wantRepeat = Math.min(D - wantFresh, usedPool.length)
  const topUp = D - wantFresh - wantRepeat

  const allowed = (sorted: number[]): boolean =>
    !exclude?.has(sorted.join('-')) && (!accept || accept(sorted))
  const byValue = (a: number, b: number) => scores[b] - scores[a] || a - b
  const greedy = [
    ...unusedPool.slice().sort(byValue).slice(0, wantFresh + topUp),
    ...usedPool.slice().sort(byValue).slice(0, wantRepeat),
  ].sort((a, b) => a - b)

  /*
   * The highest total this split can reach, valid or not — the anchor the
   * search measures against. It never moves, so "near-optimal" means the same
   * thing on every trial.
   *
   * Anything within `slack` of it is treated as an equal and one is chosen at
   * random, which is both what makes a re-deal actually re-deal and the honest
   * reading of the scores. Seeding the search with `greedy` and keeping strict
   * argmax froze every ticket whose greedy pick happened to be in shape: greedy
   * IS the maximum, so no sampled candidate could ever beat it and the seed
   * changed nothing. On a live model that pinned the first two of five tickets
   * across every re-deal.
   *
   * The slack is a fraction of the spread a whole ticket can span, D·(hi−lo),
   * so it scales with the scores and works whether they are probabilities or
   * z-scores. At 2% of that span it admits combinations within about half a
   * percent of the best — 77 of them on a live Powerball model, against a top-1
   * to top-25 score gap of 11%, which is well inside the noise those scores
   * carry anyway.
   */
  const slack = TIE_SLACK * D * range
  const anchor = greedy.reduce((s, n) => s + scores[n], 0)
  const greedyOk = (!shape || inShape(greedy, shape)) && allowed(greedy)
  let best: number[] | null = greedyOk ? greedy : null
  let ties = greedyOk ? 1 : 0
  // Kept only for the case where nothing at all reaches the near-optimal band.
  let fallback: number[] | null = best
  let fallbackValue = greedyOk ? anchor : -Infinity

  const cand: number[] = []
  const partA: number[] = []
  const partB: number[] = []
  for (let t = 0; t < TICKET_TRIES; t++) {
    weightedSubset(weights, unusedPool, wantFresh + topUp, rnd, partA)
    weightedSubset(weights, usedPool, wantRepeat, rnd, partB)
    cand.length = 0
    cand.push(...partA, ...partB)
    cand.sort((a, b) => a - b)
    if ((shape && !inShape(cand, shape)) || !allowed(cand)) continue
    let v = 0
    for (const n of cand) v += scores[n]
    if (v >= anchor - slack) {
      // Reservoir sampling: every near-optimal candidate is equally likely to
      // be the one returned, so the deal is genuinely re-dealt.
      ties++
      if (rnd() * ties < 1) best = cand.slice()
    }
    if (v > fallbackValue) { fallbackValue = v; fallback = cand.slice() }
  }

  const chosen = best ?? fallback ?? greedy
  for (const n of chosen) used[n]++
  return chosen
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
      // The jackpot tier lives outside the prize table, so a trial that matches
      // everything must still count as a win — "any prize" includes the top one.
      if (prizeAt[m * 2 + sp] > 0 || (m === D && (specialK === 0 || sp === 1))) paid = 1
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
  /** Keep suggested tickets to shapes this game actually produces */
  shape?: PortfolioShape | null
  /**
   * Combinations never to suggest, as sorted join('-') keys — the past
   * jackpots. Not because they cannot repeat (each is exactly as likely as any
   * other combination) but because a combination with a story attracts
   * co-winners, and a shared jackpot pays less.
   */
  exclude?: Set<string>
  /**
   * The reduced pool as a membership test. When set, every suggested ticket
   * must come from inside it — the same pool the model's own pick is generated
   * from, so the two features never disagree about what is worth playing.
   */
  accept?: ((sorted: number[]) => boolean) | null
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
  /*
   * Where in that ranking the set starts. Without this the bonus balls were
   * `specialOrder[t]` — the same five, in the same order, on every deal no
   * matter the seed, so a re-deal visibly changed the mains and left the bonus
   * column untouched.
   *
   * Rotating rather than reranking costs almost nothing: the bonus model picks
   * its top ball 4.13% of the time against 3.85% by chance, so which slice of
   * the ranking a set takes is worth about a quarter of a percentage point —
   * far less than the deal genuinely being a different deal.
   */
  const specialShift = specialOrder.length > 0
    ? Math.floor(mulberry32(seed ^ 0x5bf03635)() * specialOrder.length) % specialOrder.length
    : 0

  const shape = opts.shape ?? null

  /*
   * The slider sets how many different numbers the whole set covers, from D
   * (every ticket identical) up to count·D (no number twice). Naming the target
   * outright is what makes the control responsive: the previous version scored
   * a reuse penalty against the model's own numbers, and because the gap
   * between the best number and the twenty-fifth best is tiny next to the gap
   * across the whole pool, every setting above about 0.1 priced reuse out
   * entirely and returned byte-for-byte identical tickets for nine-tenths of
   * the slider's travel. Here each notch changes the answer.
   */
  const maxDistinct = Math.min(K, count * D)
  const targetDistinct = Math.round(D + spread * (maxDistinct - D))
  const budget = targetDistinct - D

  const used = new Int32Array(K + 1)
  const tickets: PortfolioTicket[] = []
  for (let t = 0; t < count; t++) {
    // Spread the new numbers evenly over the tickets after the first, which
    // gets a full set of its own.
    const fresh = t === 0
      ? D
      : Math.round((budget * t) / (count - 1)) - Math.round((budget * (t - 1)) / (count - 1))
    const numbers = pickTicket(scores, K, D, used, fresh, shape, mulberry32(seed + t * 7919), opts.exclude, opts.accept)
    const ticket: PortfolioTicket = { numbers }
    if (specialK > 0) {
      // At zero spread every ticket is one pick repeated, bonus ball included
      ticket.special = spread === 0
        ? specialOrder[specialShift]
        : specialOrder[(specialShift + t) % specialOrder.length]
    }
    tickets.push(ticket)
  }

  // Same count, every ticket identical to the model's single best pick
  const topUsed = new Int32Array(K + 1)
  const top = pickTicket(scores, K, D, topUsed, D, shape, mulberry32(seed), opts.exclude, opts.accept)
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
