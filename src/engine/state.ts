import type { Draw } from './types.ts'

/**
 * Incrementally-built view of history. During the walk-forward backtest the
 * state at step t contains ONLY draws 0..t-1, so every signal computed from it
 * is guaranteed leak-free by construction.
 */
export class HistoryState {
  readonly K: number
  n = 0
  history: Draw[] = []

  counts: Uint32Array
  countsByDow: Uint32Array // dow*(K+1)+i
  drawsByDow = new Uint32Array(7)

  lastSeen: Int32Array // draw index of last appearance, -1 = never
  gapSum: Float64Array
  gapSumSq: Float64Array
  gapN: Uint32Array

  ewma: Float64Array // exponentially decayed appearance rate
  readonly ewmaLambda: number

  w10: Uint16Array
  w20: Uint16Array
  w50: Uint16Array

  pairCounts: Uint32Array // a*(K+1)+b for a<b

  trans: Uint32Array // j*(K+1)+i : i appeared right after a draw containing j
  transOpp: Uint32Array // times j appeared in a draw that has a successor
  transByDow: Uint32Array // (dow*(K+1)+j)*(K+1)+i, dow = successor's day
  transOppByDow: Uint32Array // dow*(K+1)+j

  streak: Uint16Array
  maxStreak: Uint16Array
  repeatCount: Uint32Array // times number appeared in consecutive draws
  repeatHits = 0
  repeatOpp = 0

  posCounts: Uint32Array // p*(K+1)+i for positions 0..4

  sumSum = 0
  sumSumSq = 0
  spreadSum = 0
  spreadSumSq = 0
  oddHist = new Uint32Array(6)

  masks: Uint32Array[] = [] // per-draw bitmask of numbers
  drawSums: number[] = []
  readonly maskWords: number

  constructor(K: number, ewmaHalfLife = 20) {
    this.K = K
    const S = K + 1
    this.counts = new Uint32Array(S)
    this.countsByDow = new Uint32Array(7 * S)
    this.lastSeen = new Int32Array(S).fill(-1)
    this.gapSum = new Float64Array(S)
    this.gapSumSq = new Float64Array(S)
    this.gapN = new Uint32Array(S)
    this.ewma = new Float64Array(S)
    this.ewmaLambda = Math.pow(0.5, 1 / ewmaHalfLife)
    this.w10 = new Uint16Array(S)
    this.w20 = new Uint16Array(S)
    this.w50 = new Uint16Array(S)
    this.pairCounts = new Uint32Array(S * S)
    this.trans = new Uint32Array(S * S)
    this.transOpp = new Uint32Array(S)
    this.transByDow = new Uint32Array(7 * S * S)
    this.transOppByDow = new Uint32Array(7 * S)
    this.streak = new Uint16Array(S)
    this.maxStreak = new Uint16Array(S)
    this.repeatCount = new Uint32Array(S)
    this.posCounts = new Uint32Array(5 * S)
    this.maskWords = Math.ceil(S / 32)
  }

  /** Long-run appearance probability with Laplace smoothing. */
  rate(i: number, prior = 1): number {
    return (this.counts[i] + prior * (5 / this.K)) / (this.n + prior)
  }

  meanGap(i: number): number {
    // Average draws between appearances; fall back to theoretical K/5
    return this.gapN[i] > 0 ? this.gapSum[i] / this.gapN[i] : this.K / 5
  }

  gapSd(i: number): number {
    const n = this.gapN[i]
    if (n < 2) return this.meanGap(i)
    const mean = this.gapSum[i] / n
    const varr = Math.max(0, this.gapSumSq[i] / n - mean * mean)
    return Math.sqrt(varr)
  }

  drawsSince(i: number): number {
    return this.lastSeen[i] < 0 ? this.n : this.n - 1 - this.lastSeen[i] + 1
  }

  push(draw: Draw): void {
    const S = this.K + 1
    const t = this.n
    const prev = t > 0 ? this.history[t - 1] : null
    const nums = draw.sorted

    // Transitions from the previous draw to this one (keyed by THIS draw's dow)
    if (prev) {
      const d = draw.dow
      for (const j of prev.sorted) {
        this.transOpp[j]++
        this.transOppByDow[d * S + j]++
        for (const i of nums) {
          this.trans[j * S + i]++
          this.transByDow[(d * S + j) * S + i]++
        }
        this.repeatOpp++
        if (nums.includes(j)) {
          this.repeatCount[j]++
          this.repeatHits++
        }
      }
    }

    // EWMA decay for everyone, bump for the drawn
    const lam = this.ewmaLambda
    for (let i = 1; i <= this.K; i++) this.ewma[i] *= lam
    for (const i of nums) this.ewma[i] += 1 - lam

    // Window counts: add this draw, retire draws leaving each window
    for (const i of nums) { this.w10[i]++; this.w20[i]++; this.w50[i]++ }
    if (t >= 10) for (const i of this.history[t - 10].sorted) this.w10[i]--
    if (t >= 20) for (const i of this.history[t - 20].sorted) this.w20[i]--
    if (t >= 50) for (const i of this.history[t - 50].sorted) this.w50[i]--

    // Core counts, gaps, streaks
    const inDraw = new Set(nums)
    for (const i of nums) {
      this.counts[i]++
      this.countsByDow[draw.dow * S + i]++
      if (this.lastSeen[i] >= 0) {
        const gap = t - this.lastSeen[i]
        this.gapSum[i] += gap
        this.gapSumSq[i] += gap * gap
        this.gapN[i]++
      }
      this.lastSeen[i] = t
    }
    if (prev) {
      for (let i = 1; i <= this.K; i++) {
        if (inDraw.has(i)) {
          this.streak[i] = prev.sorted.includes(i) ? this.streak[i] + 1 : 1
          if (this.streak[i] > this.maxStreak[i]) this.maxStreak[i] = this.streak[i]
        } else {
          this.streak[i] = 0
        }
      }
    } else {
      for (const i of nums) { this.streak[i] = 1; this.maxStreak[i] = 1 }
    }

    // Pairs
    for (let a = 0; a < 5; a++)
      for (let b = a + 1; b < 5; b++)
        this.pairCounts[nums[a] * S + nums[b]]++

    // Positions use source order (meaningful when the feed isn't pre-sorted)
    for (let p = 0; p < 5; p++) {
      const v = draw.numbers[p]
      if (v <= this.K) this.posCounts[p * S + v]++
    }

    // Draw-shape stats
    const sum = nums.reduce((a, b) => a + b, 0)
    const spread = nums[4] - nums[0]
    const odd = nums.filter((x) => x % 2 === 1).length
    this.sumSum += sum
    this.sumSumSq += sum * sum
    this.spreadSum += spread
    this.spreadSumSq += spread * spread
    this.oddHist[odd]++

    // Similarity support
    const mask = new Uint32Array(this.maskWords)
    for (const i of nums) mask[i >> 5] |= 1 << (i & 31)
    this.masks.push(mask)
    this.drawSums.push(sum)

    this.drawsByDow[draw.dow]++
    this.history.push(draw)
    this.n++
  }

  sumMean(): number { return this.n ? this.sumSum / this.n : 0 }
  sumSd(): number {
    if (this.n < 2) return 1
    const m = this.sumMean()
    return Math.sqrt(Math.max(1e-9, this.sumSumSq / this.n - m * m))
  }
}

export function popcount(x: number): number {
  x = x - ((x >> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333)
  x = (x + (x >> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >> 24
}

export function maskOverlap(a: Uint32Array, b: Uint32Array): number {
  let o = 0
  for (let w = 0; w < a.length; w++) o += popcount(a[w] & b[w])
  return o
}
