import type { Draw } from './types.ts'

/** Draws remembered per weekday for the "recent form on this weekday" signal. */
export const DOW_WINDOW = 8

/**
 * Incrementally-built view of history. During the walk-forward backtest the
 * state at step t contains ONLY draws 0..t-1, so every signal computed from it
 * is guaranteed leak-free by construction.
 */
export class HistoryState {
  readonly K: number
  /** Numbers per draw */
  readonly D: number
  n = 0
  history: Draw[] = []

  counts: Uint32Array
  countsByDow: Uint32Array // dow*(K+1)+i
  drawsByDow = new Uint32Array(7)

  lastSeen: Int32Array // draw index of last appearance, -1 = never
  gapSum: Float64Array
  gapSumSq: Float64Array
  gapN: Uint32Array

  /** Exponentially decayed appearance rates at three time scales */
  ewmaFast: Float64Array
  ewma: Float64Array
  ewmaSlow: Float64Array
  readonly lamFast: number
  readonly lamMid: number
  readonly lamSlow: number

  w10: Uint16Array
  w20: Uint16Array
  w50: Uint16Array

  /** Appearance counts within the last DOW_WINDOW draws of each weekday */
  dowRecent: Uint16Array // dow*(K+1)+i
  private dowQueues: number[][] = [[], [], [], [], [], [], []] // draw indices per dow

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

  posCounts: Uint32Array // p*(K+1)+i for positions 0..D-1

  sumSum = 0
  sumSumSq = 0
  spreadSum = 0
  spreadSumSq = 0
  oddHist: Uint32Array

  masks: Uint32Array[] = [] // per-draw bitmask of numbers
  drawSums: number[] = []
  readonly maskWords: number

  /** Bonus/special ball tracking (own pool, up to 99) */
  sCounts = new Uint32Array(100)
  sByDow = new Uint32Array(7 * 100)
  sEwma = new Float64Array(100)
  sLastSeen = new Int32Array(100).fill(-1)
  sGapSum = new Float64Array(100)
  sGapN = new Uint32Array(100)
  sTrans = new Uint32Array(100 * 100) // prev special -> next special
  sPrev = 0 // previous draw's special (0 = none)
  sN = 0 // draws with a special ball
  readonly sLambda = Math.pow(0.5, 1 / 25)

  constructor(K: number, drawSize: number) {
    this.K = K
    this.D = drawSize
    const S = K + 1
    this.counts = new Uint32Array(S)
    this.countsByDow = new Uint32Array(7 * S)
    this.lastSeen = new Int32Array(S).fill(-1)
    this.gapSum = new Float64Array(S)
    this.gapSumSq = new Float64Array(S)
    this.gapN = new Uint32Array(S)
    this.ewmaFast = new Float64Array(S)
    this.ewma = new Float64Array(S)
    this.ewmaSlow = new Float64Array(S)
    this.lamFast = Math.pow(0.5, 1 / 8)
    this.lamMid = Math.pow(0.5, 1 / 20)
    this.lamSlow = Math.pow(0.5, 1 / 45)
    this.w10 = new Uint16Array(S)
    this.w20 = new Uint16Array(S)
    this.w50 = new Uint16Array(S)
    this.dowRecent = new Uint16Array(7 * S)
    this.pairCounts = new Uint32Array(S * S)
    this.trans = new Uint32Array(S * S)
    this.transOpp = new Uint32Array(S)
    this.transByDow = new Uint32Array(7 * S * S)
    this.transOppByDow = new Uint32Array(7 * S)
    this.streak = new Uint16Array(S)
    this.maxStreak = new Uint16Array(S)
    this.repeatCount = new Uint32Array(S)
    this.posCounts = new Uint32Array(drawSize * S)
    this.oddHist = new Uint32Array(drawSize + 1)
    this.maskWords = Math.ceil(S / 32)
  }

  /** Long-run appearance probability with Laplace smoothing. */
  rate(i: number, prior = 1): number {
    return (this.counts[i] + prior * (this.D / this.K)) / (this.n + prior)
  }

  meanGap(i: number): number {
    // Average draws between appearances; fall back to theoretical K/D
    return this.gapN[i] > 0 ? this.gapSum[i] / this.gapN[i] : this.K / this.D
  }

  gapSd(i: number): number {
    const n = this.gapN[i]
    if (n < 2) return this.meanGap(i)
    const mean = this.gapSum[i] / n
    const varr = Math.max(0, this.gapSumSq[i] / n - mean * mean)
    return Math.sqrt(varr)
  }

  drawsSince(i: number): number {
    return this.lastSeen[i] < 0 ? this.n : this.n - this.lastSeen[i]
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
    for (let i = 1; i <= this.K; i++) {
      this.ewmaFast[i] *= this.lamFast
      this.ewma[i] *= this.lamMid
      this.ewmaSlow[i] *= this.lamSlow
    }
    for (const i of nums) {
      this.ewmaFast[i] += 1 - this.lamFast
      this.ewma[i] += 1 - this.lamMid
      this.ewmaSlow[i] += 1 - this.lamSlow
    }

    // Window counts: add this draw, retire draws leaving each window
    for (const i of nums) { this.w10[i]++; this.w20[i]++; this.w50[i]++ }
    if (t >= 10) for (const i of this.history[t - 10].sorted) this.w10[i]--
    if (t >= 20) for (const i of this.history[t - 20].sorted) this.w20[i]--
    if (t >= 50) for (const i of this.history[t - 50].sorted) this.w50[i]--

    // Per-weekday recent window
    {
      const q = this.dowQueues[draw.dow]
      q.push(t)
      for (const i of nums) this.dowRecent[draw.dow * S + i]++
      if (q.length > DOW_WINDOW) {
        const old = q.shift()!
        for (const i of this.history[old].sorted) this.dowRecent[draw.dow * S + i]--
      }
    }

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
    for (let a = 0; a < nums.length; a++)
      for (let b = a + 1; b < nums.length; b++)
        this.pairCounts[nums[a] * S + nums[b]]++

    // Positions use source order (meaningful when the feed isn't pre-sorted)
    for (let p = 0; p < this.D && p < draw.numbers.length; p++) {
      const v = draw.numbers[p]
      if (v <= this.K) this.posCounts[p * S + v]++
    }

    // Draw-shape stats
    const sum = nums.reduce((a, b) => a + b, 0)
    const spread = nums[nums.length - 1] - nums[0]
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

    // Bonus/special ball
    if (draw.special !== undefined && draw.special >= 1 && draw.special < 100) {
      const sp = draw.special
      for (let v = 1; v < 100; v++) this.sEwma[v] *= this.sLambda
      this.sEwma[sp] += 1 - this.sLambda
      this.sCounts[sp]++
      this.sByDow[draw.dow * 100 + sp]++
      if (this.sLastSeen[sp] >= 0) {
        this.sGapSum[sp] += this.sN - this.sLastSeen[sp]
        this.sGapN[sp]++
      }
      this.sLastSeen[sp] = this.sN
      if (this.sPrev > 0) this.sTrans[this.sPrev * 100 + sp]++
      this.sPrev = sp
      this.sN++
    }

    this.drawsByDow[draw.dow]++
    this.history.push(draw)
    this.n++
  }

  /** Draws-with-special elapsed since the special value last appeared. */
  sDrawsSince(v: number): number {
    return this.sLastSeen[v] < 0 ? this.sN : this.sN - this.sLastSeen[v]
  }

  sMeanGap(v: number, Ks: number): number {
    return this.sGapN[v] > 0 ? this.sGapSum[v] / this.sGapN[v] : Ks
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
