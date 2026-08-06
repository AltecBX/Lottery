import { US_LOWER_TIERS } from './jackpot.ts'
import { choose, matchOdds } from './odds.ts'
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
  /**
   * True when these figures were counted exactly rather than simulated. Worth
   * reporting: the events being measured are rare enough that a simulation of
   * any practical size is mostly noise at this resolution.
   */
  exact: boolean
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
  best = false,
): number[] {
  let hi = -Infinity
  let lo = Infinity
  for (let n = 1; n <= K; n++) {
    if (scores[n] > hi) hi = scores[n]
    if (scores[n] < lo) lo = scores[n]
  }
  const range = Math.max(1e-9, hi - lo)
  /*
   * The sampler's preference for a number is exactly the model's claim about
   * it — the probabilities themselves when the scores are probabilities, a
   * mild exponential otherwise (z-scores can be negative).
   *
   * This line is where the "every deal looks the same" bug lived. The old
   * weights exp((s−lo)/(0.35·range)) stretched ANY score spread to a fixed
   * 17× top-to-bottom ratio — the live model's own claim was 1.30× — so the
   * top-scoring number was dealt into essentially every sampled candidate,
   * one ticket's split had a single viable answer that froze across seeds,
   * and five "different" deals were permutations of the same eighteen
   * numbers. The model earns exactly the tilt it can demonstrate, no more.
   */
  const weights = new Float64Array(K + 1)
  if (lo > 0) {
    for (let n = 1; n <= K; n++) weights[n] = scores[n]
  } else {
    for (let n = 1; n <= K; n++) weights[n] = Math.exp((scores[n] - hi) / range)
  }

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

  const cand: number[] = []
  const partA: number[] = []
  const partB: number[] = []

  if (best) {
    // The deterministic top pick — the zero-spread slider position and the
    // "concentrated" baseline ask for THE best ticket, so argmax is the point
    // here, not a bug. Greedy is that maximum whenever it is legal.
    if ((!shape || inShape(greedy, shape)) && allowed(greedy)) {
      for (const n of greedy) used[n]++
      return greedy
    }
    let bestCand: number[] = greedy
    let bestValue = -Infinity
    for (let t = 0; t < TICKET_TRIES; t++) {
      weightedSubset(weights, unusedPool, wantFresh + topUp, rnd, partA)
      weightedSubset(weights, usedPool, wantRepeat, rnd, partB)
      cand.length = 0
      cand.push(...partA, ...partB)
      cand.sort((a, b) => a - b)
      if ((shape && !inShape(cand, shape)) || !allowed(cand)) continue
      let v = 0
      for (const n of cand) v += scores[n]
      if (v > bestValue) { bestValue = v; bestCand = cand.slice() }
    }
    for (const n of bestCand) used[n]++
    return bestCand
  }

  /*
   * A deal, not a search. The weighted sampling already expresses the model's
   * preference, so the first candidate that clears the shape and the pool IS a
   * draw from the honest distribution — taking the best of 1,200 instead
   * would sharpen right back to the argmax this function just stopped being.
   */
  let fallback: number[] | null = null
  let fallbackValue = -Infinity
  const deal = (w: Float64Array): number[] | null => {
    for (let t = 0; t < TICKET_TRIES; t++) {
      weightedSubset(w, unusedPool, wantFresh + topUp, rnd, partA)
      weightedSubset(w, usedPool, wantRepeat, rnd, partB)
      cand.length = 0
      cand.push(...partA, ...partB)
      cand.sort((a, b) => a - b)
      if (shape && !inShape(cand, shape)) continue
      if (!allowed(cand)) {
        // Right shape, wrong pool — remembered in case nothing fully passes.
        let v = 0
        for (const n of cand) v += scores[n]
        if (v > fallbackValue) { fallbackValue = v; fallback = cand.slice() }
        continue
      }
      return cand
    }
    return null
  }

  /*
   * Second pass, on a flat preference. If the model's tilt is steep enough that
   * 1,200 draws from it never once land on an acceptable combination, the thing
   * to give up is the tilt — it is a weak statistical claim, worth 1.30x at its
   * strongest, while the pool and the crowd test are plain facts about the
   * combination and cost nothing to satisfy. Getting this backwards is how a
   * model that liked 1..31 could hand back a ticket every birthday player in
   * the country also holds.
   */
  let chosen = deal(weights)
  if (!chosen) {
    const flat = new Float64Array(K + 1).fill(1)
    chosen = deal(flat)
  }
  const out = chosen ?? fallback ?? greedy
  for (const n of out) used[n]++
  return out
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

const popcount = (x: number): number => {
  x -= (x >> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333)
  x = (x + (x >> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >> 24
}

/** Subsets the exact count may walk before it is cheaper to simulate. */
const EXACT_BUDGET = 3_000_000
/** Two 31-bit mask words, and a per-ticket lookup table of 2^n entries. */
const EXACT_MAX_COVER = 62
const EXACT_MAX_TICKETS = 16

/**
 * The lowest main-number match that pays, with and without the bonus ball.
 * Read off the prize table rather than assumed, so a game with a different
 * structure is measured by its own rules. The jackpot tier lives outside the
 * table and is added back here.
 */
function prizeThresholds(D: number, specialK: number, tiers: PrizeTier[]): { noSpecial: number; withSpecial: number } {
  let noSpecial = Infinity
  let withSpecial = Infinity
  for (const t of tiers) {
    if (t.prize <= 0 || t.match > D) continue
    if (t.withSpecial) withSpecial = Math.min(withSpecial, t.match)
    else noSpecial = Math.min(noSpecial, t.match)
  }
  if (specialK > 0) withSpecial = Math.min(withSpecial, D)
  else noSpecial = Math.min(noSpecial, D)
  return { noSpecial, withSpecial }
}

/**
 * Count what a set of tickets does against every possible draw — exactly.
 *
 * The trick that makes this cheap is that only the covered numbers matter. Two
 * draws that hit the same subset of the numbers these tickets actually contain
 * produce identical results, so the whole of C(69,5) collapses to the subsets
 * of the 18-25 numbers on the tickets, each weighted by how many real draws map
 * onto it: C(K − covered, D − j). For five Powerball tickets that is 68,406
 * cases instead of 11.2 million, and the answer has no error term at all.
 *
 * That matters more than it sounds. "Some ticket hits 4+" happens about once in
 * 7,000 draws, so a 20,000-trial simulation of it expects three events — the
 * figure it prints is dominated by whether it saw two or four, and the gap
 * between two arrangements of the same tickets is far smaller than that. Every
 * comparison here was being made below the noise floor.
 *
 * The bonus ball is drawn from its own pool, so it factors out: for each case,
 * a draw pays if some ticket already clears the no-bonus threshold, and
 * otherwise with probability (distinct bonus balls that would pay) / specialK.
 *
 * Returns null when the enumeration would be larger than simulating — the
 * caller falls back and says so.
 */
export function exactPortfolioStats(
  tickets: PortfolioTicket[],
  K: number,
  D: number,
  specialK: number,
  tiers: PrizeTier[] = US_LOWER_TIERS,
): PortfolioStats | null {
  const n = tickets.length
  if (n === 0 || n > EXACT_MAX_TICKETS || D <= 0 || K < D) return null

  const coverSet = new Set<number>()
  for (const t of tickets) for (const x of t.numbers) coverSet.add(x)
  const cover = [...coverSet].sort((a, b) => a - b)
  const U = cover.length
  if (U > EXACT_MAX_COVER) return null

  const jMax = Math.min(D, U)
  let budget = 0
  for (let j = 0; j <= jMax; j++) budget += choose(U, j)
  if (!Number.isFinite(budget) || budget > EXACT_BUDGET) return null

  const bitLo = new Int32Array(U)
  const bitHi = new Int32Array(U)
  for (let i = 0; i < U; i++) {
    if (i < 31) bitLo[i] = 1 << i
    else bitHi[i] = 1 << (i - 31)
  }
  const posOf = new Map<number, number>()
  for (let i = 0; i < U; i++) posOf.set(cover[i], i)

  const tLo = new Int32Array(n)
  const tHi = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    for (const x of tickets[i].numbers) {
      const p = posOf.get(x)
      if (p === undefined) continue
      tLo[i] |= bitLo[p]
      tHi[i] |= bitHi[p]
    }
  }

  const { noSpecial, withSpecial } = prizeThresholds(D, specialK, tiers)

  /*
   * For every set of tickets that would pay if the bonus matched, how much of
   * the bonus pool that covers. Precomputed over all 2^n membership patterns
   * because the inner loop hits it once per case; with the usual prize table
   * the threshold is zero matches, so in practice one pattern is used
   * throughout, but a game whose lowest bonus tier needs main numbers too gets
   * the same exact treatment.
   */
  const specialShare = new Float64Array(1 << n)
  if (specialK > 0) {
    for (let mask = 0; mask < 1 << n; mask++) {
      const seen = new Set<number>()
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) {
          const s = tickets[i].special
          if (s !== undefined) seen.add(s)
        }
      }
      specialShare[mask] = Math.min(1, seen.size / specialK)
    }
  }

  const total = choose(K, D)
  const bestCount = new Float64Array(D + 1)
  let payWeight = 0
  const c = new Int32Array(Math.max(1, D))

  for (let j = 0; j <= jMax; j++) {
    const rest = choose(K - U, D - j)
    if (rest === 0) continue
    for (let i = 0; i < j; i++) c[i] = i
    for (;;) {
      let alo = 0
      let ahi = 0
      for (let i = 0; i < j; i++) {
        alo |= bitLo[c[i]]
        ahi |= bitHi[c[i]]
      }
      let best = 0
      let payNow = false
      let qual = 0
      for (let i = 0; i < n; i++) {
        const m = popcount(tLo[i] & alo) + popcount(tHi[i] & ahi)
        if (m > best) best = m
        if (m >= noSpecial) payNow = true
        if (m >= withSpecial) qual |= 1 << i
      }
      bestCount[best] += rest
      payWeight += rest * (payNow ? 1 : specialK > 0 ? specialShare[qual] : 0)

      if (j === 0) break
      let i = j - 1
      while (i >= 0 && c[i] === U - j + i) i--
      if (i < 0) break
      c[i]++
      for (let k = i + 1; k < j; k++) c[k] = c[k - 1] + 1
    }
  }

  let ge3 = 0
  let ge4 = 0
  let weightedBest = 0
  for (let b = 0; b <= D; b++) {
    weightedBest += b * bestCount[b]
    if (b >= 3) ge3 += bestCount[b]
    if (b >= 4) ge4 += bestCount[b]
  }

  return {
    distinctNumbers: U,
    pAtLeast3: ge3 / total,
    pAtLeast4: ge4 / total,
    pAnyPrize: payWeight / total,
    avgBestMatch: weightedBest / total,
    exact: true,
  }
}

/**
 * Measure a set of tickets against every draw the game can produce. Fair is the
 * point: the coverage advantage of spreading numbers across tickets is a
 * property of the tickets themselves, so it holds no matter which numbers come
 * up — unlike anything that assumes the model is right.
 *
 * Counted exactly where that is affordable, which covers every set the app
 * actually offers; the simulation below is the fallback for portfolios wide
 * enough to make enumeration the slower of the two.
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
  const counted = exactPortfolioStats(tickets, K, D, specialK, tiers)
  if (counted) return counted

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
    exact: false,
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
  /**
   * Calibrated probabilities aligned with `specialPicks`, so the bonus dealer
   * can weight each ball by exactly what the model claims for it.
   */
  specialProbs?: number[]
  /**
   * Tickets to keep exactly as they are. They count against `count`, their
   * numbers are already spoken for when the rest are dealt, and they come back
   * first in the returned list. This is what lets one good-looking game survive
   * a re-deal of the other four.
   */
  hold?: PortfolioTicket[]
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
   * The bonus balls are dealt the same way the mains are: sampled without
   * replacement, weighted by what the model actually claims. Its calibrated
   * claim is small — the top pick hits 4.13% against 3.85% by chance — so the
   * weights are nearly flat and the deal is nearly uniform, which is honest.
   *
   * Two earlier versions both failed visibly. Indexing by ticket position
   * ignored the seed, so the bonus column never changed; rotating the ranked
   * order fixed that and produced 15-16-17-18-19 down the screen, because
   * everything after the few ranked picks is just 1..K ascending and a rotated
   * window of it is a run of consecutive integers. Nothing that *looks* that
   * artificial should come out of a dealer.
   */
  const specialWeights = new Float64Array(specialOrder.length)
  if (specialK > 0) {
    let claimed = 0
    let nRanked = 0
    for (let i = 0; i < specialOrder.length; i++) {
      const p = opts.specialProbs?.[i]
      if (i < specialPicks.length && p !== undefined && p > 0 && p < 1) {
        specialWeights[i] = p
        claimed += p
        nRanked++
      }
    }
    const rest = specialOrder.length - nRanked
    const share = rest > 0 ? Math.max(1e-9, 1 - claimed) / rest : 0
    for (let i = 0; i < specialOrder.length; i++) if (specialWeights[i] === 0) specialWeights[i] = share
  }
  const dealSpecials = (want: number, r: () => number): number[] => {
    const idx = specialOrder.map((_, i) => i)
    const w = Array.from(specialWeights)
    const out: number[] = []
    while (out.length < want && specialOrder.length > 0) {
      if (idx.length === 0) { for (let i = 0; i < specialOrder.length; i++) { idx.push(i); w[i] = specialWeights[i] } }
      let total = 0
      for (const i of idx) total += w[i]
      let roll = r() * total
      let at = 0
      for (; at < idx.length - 1; at++) { roll -= w[idx[at]]; if (roll <= 0) break }
      out.push(specialOrder[idx[at]])
      idx.splice(at, 1)
    }
    return out
  }
  const dealtSpecials = specialK > 0 ? dealSpecials(count, mulberry32(seed ^ 0x5bf03635)) : []

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

  /*
   * Held tickets are placed before anything is dealt, so their numbers are
   * already spoken for and the fresh ones spread around them rather than
   * colliding with them. A held bonus ball is taken out of the deal for the
   * same reason.
   */
  const held = (opts.hold ?? []).slice(0, count)
  const heldSpecials = new Set<number>()
  for (const h of held) {
    for (const n of h.numbers) if (n >= 1 && n <= K) used[n]++
    if (h.special !== undefined) heldSpecials.add(h.special)
    tickets.push(h)
  }
  const remaining = count - held.length
  // Bonus balls a held ticket already carries are out of the deal — repeating
  // one is the single most expensive overlap there is, because matching the
  // bonus alone pays and two tickets sharing it collect once.
  const freeSpecials = dealtSpecials.filter((s) => !heldSpecials.has(s))
  for (let i = 0; freeSpecials.length < remaining && i < specialOrder.length; i++) {
    const s = specialOrder[i]
    if (!heldSpecials.has(s) && !freeSpecials.includes(s)) freeSpecials.push(s)
  }

  for (let t = 0; t < remaining; t++) {
    // Spread the new numbers evenly over the tickets after the first, which
    // gets a full set of its own.
    const slot = held.length + t
    const fresh = slot === 0
      ? D
      : Math.round((budget * slot) / (count - 1)) - Math.round((budget * (slot - 1)) / (count - 1))
    // Zero spread means "the model's one pick, repeated" — the only setting
    // where a deterministic argmax is the documented behaviour.
    const numbers = pickTicket(scores, K, D, used, fresh, shape, mulberry32(seed + slot * 7919), opts.exclude, opts.accept, spread === 0)
    const ticket: PortfolioTicket = { numbers }
    if (specialK > 0) {
      const pool = freeSpecials.length > 0 ? freeSpecials : dealtSpecials
      ticket.special = spread === 0 ? specialOrder[0] : pool[t % pool.length]
    }
    tickets.push(ticket)
  }

  // Same count, every ticket identical to the model's single best pick
  const topUsed = new Int32Array(K + 1)
  const top = pickTicket(scores, K, D, topUsed, D, shape, mulberry32(seed), opts.exclude, opts.accept, true)
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
