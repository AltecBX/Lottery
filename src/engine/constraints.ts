import type { Draw } from './types.ts'
import { choose } from './odds.ts'
import { orderStatPmf } from './positions.ts'

/**
 * Constraint Lab — the search-space reduction engine.
 *
 * ── The mathematics this is built on ──────────────────────────────────────────
 *
 * A fair draw picks one combination uniformly from all C(K,D). So for ANY
 * filter R, the probability that the winner satisfies R is exactly |R|/C(K,D),
 * the share of the space R keeps. Winner survival and space share are the same
 * number, necessarily — not approximately, exactly.
 *
 * That has a blunt consequence: "keep 99.9% of winners while removing 40% of
 * the space" is impossible against a fair machine. Retaining 99.9% permits
 * removing at most about 0.1%. Any tool promising otherwise is either measuring
 * in-sample or misleading you.
 *
 * So this engine does not pretend. It measures both quantities and reports the
 * gap between them. Survival above space share, by enough standard errors to
 * matter, is evidence of real structure in the draws. Survival at space share
 * means the filter is cosmetic — it removes candidates and winners at the same
 * rate, and buys nothing. Every rule carries that comparison.
 *
 * And separately worth saying plainly: shrinking the candidate space does not
 * raise the chance that any single ticket wins. Every ticket is 1/C(K,D)·(1/S)
 * whatever shape it has. Filtering decides where your tickets sit, not what
 * they are worth.
 */

/** Where a rule sits on the possible-to-typical scale. */
export type RuleTier =
  /** Cannot occur — forbidden by the game's own arithmetic */
  | 'impossible'
  /** Possible, but the exact probability is vanishingly small */
  | 'ultra-rare'
  /** Never or barely observed, yet perfectly possible */
  | 'historically-rare'
  /** Inside the range history routinely produces */
  | 'typical'
  /** Measured no better than its own mathematical baseline — not used */
  | 'unsupported'

export type FeatureGroup = 'position' | 'gap' | 'sum' | 'shape' | 'conditional'

export interface FeatureSpec {
  key: string
  label: string
  group: FeatureGroup
  /** Smallest value the game's arithmetic allows */
  hardMin: number
  /** Largest value the game's arithmetic allows */
  hardMax: number
  /** Needs the previous draw, so it is undefined for the first draw */
  conditional?: boolean
}

const isPrime = (n: number): boolean => {
  if (n < 2) return false
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false
  return true
}

/**
 * Every measurable shape of a combination, in one fixed order.
 *
 * Positions and gaps carry exact arithmetic bounds: the r-th smallest of D
 * drawn from 1..K can never be below r nor above K−(D−r), and gaps are at
 * least 1. Those are the only bounds this engine is ever allowed to treat as
 * hard.
 */
export function featureSpecs(K: number, D: number): FeatureSpec[] {
  const specs: FeatureSpec[] = []
  for (let r = 1; r <= D; r++) {
    specs.push({ key: `pos${r}`, label: `Position ${r}`, group: 'position', hardMin: r, hardMax: K - (D - r) })
  }
  for (let g = 1; g < D; g++) {
    specs.push({ key: `gap${g}`, label: `Gap ${g}→${g + 1}`, group: 'gap', hardMin: 1, hardMax: K - (D - 1) })
  }
  const minSum = (D * (D + 1)) / 2
  const maxSum = (D * (2 * K - D + 1)) / 2
  specs.push({ key: 'sum', label: 'Total sum', group: 'sum', hardMin: minSum, hardMax: maxSum })
  specs.push({ key: 'sumLow2', label: 'Sum of lowest 2', group: 'sum', hardMin: 3, hardMax: 2 * K - 1 })
  specs.push({ key: 'sumLow3', label: 'Sum of lowest 3', group: 'sum', hardMin: 6, hardMax: 3 * K - 3 })
  specs.push({ key: 'sumHigh2', label: 'Sum of highest 2', group: 'sum', hardMin: 3, hardMax: 2 * K - 1 })
  specs.push({ key: 'spread', label: 'Spread (high − low)', group: 'shape', hardMin: D - 1, hardMax: K - 1 })
  specs.push({ key: 'sd', label: 'Spacing deviation', group: 'shape', hardMin: 0, hardMax: K })
  specs.push({ key: 'maxGap', label: 'Largest gap', group: 'gap', hardMin: 1, hardMax: K - (D - 1) })
  specs.push({ key: 'minGap', label: 'Smallest gap', group: 'gap', hardMin: 1, hardMax: Math.floor((K - 1) / (D - 1)) })
  specs.push({ key: 'consec', label: 'Consecutive pairs', group: 'shape', hardMin: 0, hardMax: D - 1 })
  specs.push({ key: 'runs', label: 'Consecutive runs', group: 'shape', hardMin: 0, hardMax: Math.floor(D / 2) })
  specs.push({ key: 'odd', label: 'Odd numbers', group: 'shape', hardMin: 0, hardMax: D })
  specs.push({ key: 'prime', label: 'Prime numbers', group: 'shape', hardMin: 0, hardMax: D })
  specs.push({ key: 'lowZone', label: 'In the low third', group: 'shape', hardMin: 0, hardMax: D })
  specs.push({ key: 'midZone', label: 'In the middle third', group: 'shape', hardMin: 0, hardMax: D })
  specs.push({ key: 'highZone', label: 'In the high third', group: 'shape', hardMin: 0, hardMax: D })
  specs.push({ key: 'aboveMid', label: 'Above the pool midpoint', group: 'shape', hardMin: 0, hardMax: D })
  specs.push({ key: 'emptyZones', label: 'Empty thirds', group: 'shape', hardMin: 0, hardMax: 2 })
  specs.push({ key: 'lastDigitDup', label: 'Shared last digits', group: 'shape', hardMin: 0, hardMax: D - 1 })
  specs.push({ key: 'centerDist', label: 'Mean distance from centre', group: 'shape', hardMin: 0, hardMax: K })
  specs.push({ key: 'repeatPrev', label: 'Repeats from last draw', group: 'conditional', hardMin: 0, hardMax: D, conditional: true })
  specs.push({ key: 'overlap3', label: 'Seen in the last 3 draws', group: 'conditional', hardMin: 0, hardMax: D, conditional: true })
  specs.push({ key: 'overlap10', label: 'Seen in the last 10 draws', group: 'conditional', hardMin: 0, hardMax: D, conditional: true })
  specs.push({ key: 'dSum', label: 'Sum change from last draw', group: 'conditional', hardMin: -maxSum, hardMax: maxSum, conditional: true })
  specs.push({ key: 'dSpread', label: 'Spread change from last draw', group: 'conditional', hardMin: -K, hardMax: K, conditional: true })
  specs.push({ key: 'dOdd', label: 'Odd-count change', group: 'conditional', hardMin: -D, hardMax: D, conditional: true })
  return specs
}

/** Recent history a conditional feature needs; null for the very first draw. */
export interface DrawContext {
  prev: number[] | null
  /** Union of the previous 3 draws */
  last3: Set<number>
  /** Union of the previous 10 draws */
  last10: Set<number>
  prevSum: number
  prevSpread: number
  prevOdd: number
}

export const EMPTY_CONTEXT: DrawContext = {
  prev: null, last3: new Set(), last10: new Set(), prevSum: 0, prevSpread: 0, prevOdd: 0,
}

/** Build the context a draw at index `i` would have seen. */
export function contextAt(draws: Draw[], i: number): DrawContext {
  if (i <= 0) return EMPTY_CONTEXT
  const prev = draws[i - 1].sorted
  const last3 = new Set<number>()
  const last10 = new Set<number>()
  for (let j = Math.max(0, i - 3); j < i; j++) for (const n of draws[j].sorted) last3.add(n)
  for (let j = Math.max(0, i - 10); j < i; j++) for (const n of draws[j].sorted) last10.add(n)
  const prevSum = prev.reduce((a, b) => a + b, 0)
  return {
    prev,
    last3,
    last10,
    prevSum,
    prevSpread: prev[prev.length - 1] - prev[0],
    prevOdd: prev.filter((v) => v % 2 === 1).length,
  }
}

/**
 * Measure a sorted combination. Order matches `featureSpecs` exactly; NaN marks
 * a conditional feature with no history behind it yet, and every consumer skips
 * NaN rather than treating it as zero.
 */
export function extractFeatures(sorted: number[], K: number, ctx: DrawContext, out?: Float64Array): Float64Array {
  const D = sorted.length
  const specs = D // positions
  const f = out ?? new Float64Array(featureCount(D))
  let k = 0
  for (let i = 0; i < specs; i++) f[k++] = sorted[i]
  for (let i = 1; i < D; i++) f[k++] = sorted[i] - sorted[i - 1]

  let sum = 0
  for (const v of sorted) sum += v
  f[k++] = sum
  f[k++] = sorted[0] + sorted[1]
  f[k++] = sorted[0] + sorted[1] + sorted[2]
  f[k++] = sorted[D - 1] + sorted[D - 2]

  const spread = sorted[D - 1] - sorted[0]
  f[k++] = spread
  const mean = sum / D
  let varAcc = 0
  for (const v of sorted) varAcc += (v - mean) ** 2
  f[k++] = Math.sqrt(varAcc / D)

  let maxGap = 0
  let minGap = Infinity
  let consec = 0
  let runs = 0
  let inRun = false
  for (let i = 1; i < D; i++) {
    const g = sorted[i] - sorted[i - 1]
    if (g > maxGap) maxGap = g
    if (g < minGap) minGap = g
    if (g === 1) {
      consec++
      if (!inRun) { runs++; inRun = true }
    } else inRun = false
  }
  f[k++] = maxGap
  f[k++] = minGap
  f[k++] = consec
  f[k++] = runs

  let odd = 0
  let prime = 0
  let low = 0
  let mid = 0
  let high = 0
  let above = 0
  const third = K / 3
  const midpoint = (K + 1) / 2
  const digits = new Set<number>()
  for (const v of sorted) {
    if (v % 2 === 1) odd++
    if (isPrime(v)) prime++
    if (v <= third) low++
    else if (v <= 2 * third) mid++
    else high++
    if (v > midpoint) above++
    digits.add(v % 10)
  }
  f[k++] = odd
  f[k++] = prime
  f[k++] = low
  f[k++] = mid
  f[k++] = high
  f[k++] = above
  f[k++] = (low === 0 ? 1 : 0) + (mid === 0 ? 1 : 0) + (high === 0 ? 1 : 0)
  f[k++] = D - digits.size
  f[k++] = Math.abs(mean - midpoint)

  if (ctx.prev) {
    let rep = 0
    let o3 = 0
    let o10 = 0
    const prevSet = new Set(ctx.prev)
    for (const v of sorted) {
      if (prevSet.has(v)) rep++
      if (ctx.last3.has(v)) o3++
      if (ctx.last10.has(v)) o10++
    }
    f[k++] = rep
    f[k++] = o3
    f[k++] = o10
    f[k++] = sum - ctx.prevSum
    f[k++] = spread - ctx.prevSpread
    f[k++] = odd - ctx.prevOdd
  } else {
    for (let i = 0; i < 6; i++) f[k++] = NaN
  }
  return f
}

export const featureCount = (D: number): number => D + (D - 1) + 4 + 2 + 4 + 9 + 6

/**
 * Online histograms, one per feature, so quantiles cost a scan rather than a
 * sort. Values are offset into non-negative bins because the conditional
 * deltas are signed.
 */
export class ConstraintState {
  readonly D: number
  readonly K: number
  readonly specs: FeatureSpec[]
  private readonly offset: Int32Array
  private readonly bins: Uint32Array[]
  private readonly seen: Uint32Array
  n = 0
  /** Per-weekday counts, for the shrunk weekday view */
  readonly byDow: Uint32Array

  constructor(K: number, D: number) {
    this.K = K
    this.D = D
    this.specs = featureSpecs(K, D)
    this.offset = new Int32Array(this.specs.length)
    this.bins = this.specs.map((s, i) => {
      // sd and centreDist are fractional; bin them to whole units
      this.offset[i] = -Math.floor(s.hardMin)
      return new Uint32Array(Math.ceil(s.hardMax) - Math.floor(s.hardMin) + 2)
    })
    this.seen = new Uint32Array(this.specs.length)
    this.byDow = new Uint32Array(7)
  }

  push(features: Float64Array, dow: number): void {
    for (let i = 0; i < this.specs.length; i++) {
      const v = features[i]
      if (!Number.isFinite(v)) continue
      const b = Math.round(v) + this.offset[i]
      if (b < 0 || b >= this.bins[i].length) continue
      this.bins[i][b]++
      this.seen[i]++
    }
    this.n++
    if (dow >= 0 && dow < 7) this.byDow[dow]++
  }

  observations(i: number): number {
    return this.seen[i]
  }

  /**
   * Two-sided interval covering at least (1 − 2·alpha) of observed values.
   *
   * Jeffreys smoothing (half a count in every reachable bin) keeps a value that
   * has never been observed from receiving probability zero, which is what stops
   * "never happened" turning into "cannot happen".
   */
  interval(i: number, alpha: number): { lo: number; hi: number } {
    const spec = this.specs[i]
    const bins = this.bins[i]
    const off = this.offset[i]
    const total = this.seen[i]
    if (total === 0) return { lo: spec.hardMin, hi: spec.hardMax }
    const prior = 0.5
    const reachable = bins.length
    const grand = total + prior * reachable
    const wantLo = alpha * grand
    const wantHi = (1 - alpha) * grand

    let acc = 0
    let lo = spec.hardMin
    let hi = spec.hardMax
    let haveLo = false
    for (let b = 0; b < reachable; b++) {
      const before = acc
      acc += bins[b] + prior
      if (!haveLo && acc > wantLo) { lo = b - off; haveLo = true }
      if (before < wantHi && acc >= wantHi) { hi = b - off; break }
    }
    if (lo > hi) { const t = lo; lo = hi; hi = t }
    return { lo: Math.max(spec.hardMin, lo), hi: Math.min(spec.hardMax, hi) }
  }

  /**
   * Intervals at several coverages in one pass over the histogram.
   *
   * The walk-forward test rebuilds every candidate rule at every draw, so this
   * runs tens of thousands of times: one sweep for all coverages rather than
   * one sweep each is the difference between a fast panel and a stalled worker.
   */
  intervalsFor(i: number, alphas: number[], out: { lo: number; hi: number }[]): void {
    const spec = this.specs[i]
    const bins = this.bins[i]
    const off = this.offset[i]
    const total = this.seen[i]
    for (let a = 0; a < alphas.length; a++) {
      out[a].lo = spec.hardMin
      out[a].hi = spec.hardMax
    }
    if (total === 0) return

    const prior = 0.5
    const grand = total + prior * bins.length
    const doneLo = new Array<boolean>(alphas.length).fill(false)
    const doneHi = new Array<boolean>(alphas.length).fill(false)
    let acc = 0
    for (let b = 0; b < bins.length; b++) {
      const before = acc
      acc += bins[b] + prior
      for (let a = 0; a < alphas.length; a++) {
        if (!doneLo[a] && acc > alphas[a] * grand) { out[a].lo = b - off; doneLo[a] = true }
        const wantHi = (1 - alphas[a]) * grand
        if (!doneHi[a] && before < wantHi && acc >= wantHi) { out[a].hi = b - off; doneHi[a] = true }
      }
    }
    for (let a = 0; a < alphas.length; a++) {
      if (out[a].lo > out[a].hi) { const t = out[a].lo; out[a].lo = out[a].hi; out[a].hi = t }
      out[a].lo = Math.max(spec.hardMin, out[a].lo)
      out[a].hi = Math.min(spec.hardMax, out[a].hi)
    }
  }

  /** Observed count of an exact value, and its Jeffreys-smoothed probability. */
  at(i: number, value: number): { count: number; p: number } {
    const bins = this.bins[i]
    const b = Math.round(value) + this.offset[i]
    const count = b >= 0 && b < bins.length ? bins[b] : 0
    const grand = this.seen[i] + 0.5 * bins.length
    return { count, p: (count + 0.5) / Math.max(1e-9, grand) }
  }

  /** Observed min and max — reported, never used as a hard cutoff. */
  observedRange(i: number): { min: number; max: number } {
    const bins = this.bins[i]
    const off = this.offset[i]
    let min = NaN
    let max = NaN
    for (let b = 0; b < bins.length; b++) if (bins[b] > 0) { min = b - off; break }
    for (let b = bins.length - 1; b >= 0; b--) if (bins[b] > 0) { max = b - off; break }
    return { min, max }
  }

  /** Percentile of a value within the observed distribution. */
  percentileOf(i: number, value: number): number {
    const bins = this.bins[i]
    const off = this.offset[i]
    const total = this.seen[i]
    if (total === 0) return 0.5
    let below = 0
    const b = Math.round(value) + off
    for (let x = 0; x < Math.min(b, bins.length); x++) below += bins[x]
    return below / total
  }
}

/** Wilson score interval — honest for proportions near 0 and 1. */
export function wilson(hits: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 }
  const p = hits / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return { lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d) }
}

/**
 * Exact probability that the r-th smallest ball lands inside [lo, hi].
 * Used to classify a position rule against arithmetic rather than history.
 */
export function positionIntervalProbability(K: number, D: number, r: number, lo: number, hi: number): number {
  let p = 0
  for (let v = Math.max(1, lo); v <= Math.min(K, hi); v++) p += orderStatPmf(K, D, r, v)
  return p
}

/** Total combinations in the pool, for reporting the universe size. */
export const universeSize = (K: number, D: number): number => choose(K, D)
