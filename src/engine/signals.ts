import type { Draw, SignalMeta } from './types.ts'
import { DOW_WINDOW, HAZARD_GMAX, HistoryState, maskOverlap } from './state.ts'

export interface SignalContext {
  /** Day of week of the draw being predicted */
  targetDow: number
  /** The most recent draw before the one being predicted (null at t=0) */
  prev: Draw | null
}

export interface RawSignal {
  key: string
  raw: Float64Array
}

export const SIGNAL_META: SignalMeta[] = [
  { key: 'freqAll', label: 'Overall frequency', short: 'Frequency', description: 'Long-run appearance rate across all history (smoothed).' },
  { key: 'freqDow', label: 'Day-of-week frequency', short: 'Day of week', description: 'Appearance rate on the target day of week, shrunk toward the overall rate.' },
  { key: 'dowRecent', label: 'Recent form on this weekday', short: 'Day recent', description: `Appearances within the last ${DOW_WINDOW} draws held on the target weekday.` },
  { key: 'recencyFast', label: 'Recency (fast)', short: 'Recency fast', description: 'Exponentially decayed frequency with a short memory (half-life 8 draws) — reacts quickly to streaks.' },
  { key: 'recency', label: 'Recency (medium)', short: 'Recency', description: 'Exponentially decayed frequency — recent draws count more (half-life 20 draws).' },
  { key: 'recencySlow', label: 'Recency (slow)', short: 'Recency slow', description: 'Exponentially decayed frequency with a long memory (half-life 45 draws) — steadier trends.' },
  { key: 'window10', label: 'Last 10 draws', short: 'Window 10', description: 'Raw appearance count in the most recent 10 draws.' },
  { key: 'window20', label: 'Last 20 draws', short: 'Window 20', description: 'Raw appearance count in the most recent 20 draws.' },
  { key: 'window50', label: 'Last 50 draws', short: 'Window 50', description: 'Raw appearance count in the most recent 50 draws.' },
  { key: 'zone', label: 'Number-line zones', short: 'Zones', description: 'Kernel-smoothed frequency — credit spills to neighboring numbers, exposing hot regions of the number line.' },
  { key: 'hot', label: 'Hot streak (z-score)', short: 'Hot', description: 'How far the last-20 count sits above/below its long-run expectation, in standard deviations.' },
  { key: 'momentum', label: 'Momentum', short: 'Momentum', description: 'Short-window rate minus long-window rate — rising numbers score high, fading ones low.' },
  { key: 'overdue', label: 'Overdue ratio', short: 'Overdue', description: 'Draws since last seen relative to the number\'s own average gap.' },
  { key: 'hazard', label: 'Gap hazard rate', short: 'Hazard', description: 'The measured probability of appearing at the current gap length, pooled across all numbers — the statistically honest version of "overdue".' },
  { key: 'cycle', label: 'Gap cycle fit', short: 'Cycle', description: 'Scores numbers whose current gap matches their historical gap rhythm (regular cycles).' },
  { key: 'repeat', label: 'Repeat from last draw', short: 'Repeat', description: 'Empirical probability of appearing given the number was (or was not) in the previous draw.' },
  { key: 'follower', label: 'Follows previous numbers', short: 'Followers', description: 'How often this number historically appeared right after the numbers in the previous draw.' },
  { key: 'followerDow', label: 'Day + previous draw', short: 'Day+prev', description: 'Follower relationship measured only on the target day of week.' },
  { key: 'position', label: 'Position fit', short: 'Position', description: 'Fit against the per-position value distributions of the source feed.' },
  { key: 'similarity', label: 'Similar situations', short: 'Similarity', description: 'What came next in the most similar historical situations (previous draw, weekday, draw shape).' },
  { key: 'mlModel', label: 'Learned combiner (regression)', short: 'ML combiner', description: 'An online multinomial-regression model trained draw-by-draw on every signal at once — it learns how the signals interact instead of treating them independently.' },
]

/** The mlModel signal is produced by the backtest's online learner, not by computeRawSignals. */
export const ML_KEY = 'mlModel'

export const SIGNAL_LABEL: Record<string, SignalMeta> = Object.fromEntries(SIGNAL_META.map((s) => [s.key, s]))

/** The signal keys computeRawSignals will produce for a given configuration. */
export function signalKeys(usePosition: boolean): string[] {
  return SIGNAL_META.map((m) => m.key).filter((k) => usePosition || k !== 'position')
}

function gauss(z: number): number {
  return Math.exp(-0.5 * z * z)
}

/** z-normalize a raw vector over indices 1..K (in place safe copy). */
export function zNormalize(raw: Float64Array, K: number): Float64Array {
  let mean = 0
  for (let i = 1; i <= K; i++) mean += raw[i]
  mean /= K
  let varr = 0
  for (let i = 1; i <= K; i++) varr += (raw[i] - mean) * (raw[i] - mean)
  const sd = Math.sqrt(varr / K)
  const out = new Float64Array(K + 1)
  if (sd > 1e-12) for (let i = 1; i <= K; i++) out[i] = (raw[i] - mean) / sd
  return out
}

export interface SimilarMatch {
  t: number
  sim: number
}

/**
 * Find historical situations most similar to the current context and score
 * numbers by what followed them. Similarity blends previous-draw overlap,
 * matching weekday and previous-draw sum shape.
 */
export function similarityScores(
  state: HistoryState,
  ctx: SignalContext,
  collectMatches: false | number = false,
): { raw: Float64Array; matches: SimilarMatch[] } {
  const K = state.K
  const raw = new Float64Array(K + 1)
  const matches: SimilarMatch[] = []
  const n = state.n
  if (!ctx.prev || n < 8) return { raw, matches }

  const prevMask = new Uint32Array(state.maskWords)
  for (const i of ctx.prev.sorted) if (i <= K) prevMask[i >> 5] |= 1 << (i & 31)
  const prevSum = ctx.prev.sorted.reduce((a, b) => a + b, 0)

  // Candidate contexts: draw t-1 is the "previous draw", draw t is the outcome.
  const full = n <= 1500
  const start = full ? 1 : n - 1500
  const top: SimilarMatch[] = []
  const KEEP = 25
  for (let t = start; t < n; t++) {
    const overlap = maskOverlap(prevMask, state.masks[t - 1])
    const dowMatch = state.history[t].dow === ctx.targetDow ? 1 : 0
    const sumDiff = Math.abs(state.drawSums[t - 1] - prevSum)
    const sim = 0.55 * (overlap / state.D) + 0.2 * dowMatch + 0.25 * Math.max(0, 1 - sumDiff / 50)
    if (top.length < KEEP) {
      top.push({ t, sim })
      if (top.length === KEEP) top.sort((a, b) => a.sim - b.sim)
    } else if (sim > top[0].sim) {
      top[0] = { t, sim }
      // bubble up to keep ascending order
      for (let k = 1; k < KEEP && top[k].sim < top[k - 1].sim; k++) {
        const tmp = top[k]; top[k] = top[k - 1]; top[k - 1] = tmp
      }
    }
  }
  let wsum = 0
  for (const m of top) {
    const w = Math.max(0, m.sim)
    wsum += w
    for (const i of state.history[m.t].sorted) if (i <= K) raw[i] += w
  }
  if (wsum > 0) for (let i = 1; i <= K; i++) raw[i] /= wsum
  if (collectMatches) {
    top.sort((a, b) => b.sim - a.sim)
    matches.push(...top.slice(0, collectMatches))
  }
  return { raw, matches }
}

/** Compute every raw signal for the given context. Uses ONLY data inside `state`. */
export function computeRawSignals(state: HistoryState, ctx: SignalContext, usePosition: boolean): RawSignal[] {
  const K = state.K
  const D = state.D
  const S = K + 1
  const n = state.n
  const out: RawSignal[] = []
  const push = (key: string, raw: Float64Array) => out.push({ key, raw })

  // freqAll
  {
    const raw = new Float64Array(S)
    for (let i = 1; i <= K; i++) raw[i] = state.rate(i, 20)
    push('freqAll', raw)
  }
  // freqDow
  {
    const raw = new Float64Array(S)
    const d = ctx.targetDow
    const nD = state.drawsByDow[d]
    const m = 15
    for (let i = 1; i <= K; i++) {
      raw[i] = (state.countsByDow[d * S + i] + m * state.rate(i, 20)) / (nD + m)
    }
    push('freqDow', raw)
  }
  // dowRecent: appearances in the last DOW_WINDOW draws on the target weekday
  {
    const raw = new Float64Array(S)
    const d = ctx.targetDow
    const eff = Math.min(state.drawsByDow[d], DOW_WINDOW)
    if (eff > 0) {
      for (let i = 1; i <= K; i++) raw[i] = state.dowRecent[d * S + i] / eff
    }
    push('dowRecent', raw)
  }
  // recency at three time scales
  {
    const rf = new Float64Array(S), rm = new Float64Array(S), rs = new Float64Array(S)
    for (let i = 1; i <= K; i++) {
      rf[i] = state.ewmaFast[i]
      rm[i] = state.ewma[i]
      rs[i] = state.ewmaSlow[i]
    }
    push('recencyFast', rf)
    push('recency', rm)
    push('recencySlow', rs)
  }
  // windows
  for (const [key, arr, w] of [['window10', state.w10, 10], ['window20', state.w20, 20], ['window50', state.w50, 50]] as const) {
    const raw = new Float64Array(S)
    const eff = Math.min(n, w)
    for (let i = 1; i <= K; i++) raw[i] = eff > 0 ? arr[i] / eff : 0
    push(key, raw)
  }
  // zone: gaussian kernel over the number line, sigma = 2, truncated at +/-5
  {
    const raw = new Float64Array(S)
    const kernel: number[] = []
    for (let d = -5; d <= 5; d++) kernel.push(gauss(d / 2))
    for (let i = 1; i <= K; i++) {
      let num = 0, den = 0
      for (let d = -5; d <= 5; d++) {
        const j = i + d
        if (j < 1 || j > K) continue
        const kw = kernel[d + 5]
        num += kw * state.counts[j]
        den += kw
      }
      raw[i] = den > 0 ? num / den : 0
    }
    push('zone', raw)
  }
  // hot: z of last-20 count vs long-run expectation
  {
    const raw = new Float64Array(S)
    const w = Math.min(n, 20)
    for (let i = 1; i <= K; i++) {
      const p = state.rate(i, 10)
      const sd = Math.sqrt(Math.max(1e-9, w * p * (1 - p)))
      raw[i] = w > 0 ? (state.w20[i] - w * p) / sd : 0
    }
    push('hot', raw)
  }
  // momentum: rate over last 10 minus rate over last 50
  {
    const raw = new Float64Array(S)
    const w10 = Math.min(n, 10), w50 = Math.min(n, 50)
    for (let i = 1; i <= K; i++) {
      if (w10 < 5 || w50 < 20) { raw[i] = 0; continue }
      const r10 = state.w10[i] / w10
      const r50 = state.w50[i] / w50
      const p = state.rate(i, 10)
      raw[i] = (r10 - r50) / Math.sqrt(Math.max(1e-9, p * (1 - p) / w10))
    }
    push('momentum', raw)
  }
  // overdue: current gap over own mean gap
  {
    const raw = new Float64Array(S)
    for (let i = 1; i <= K; i++) {
      raw[i] = Math.min(3, state.drawsSince(i) / Math.max(1, state.meanGap(i)))
    }
    push('overdue', raw)
  }
  // hazard: pooled P(hit | current gap), shrunk toward the fair-game rate D/K
  {
    const raw = new Float64Array(S)
    const a = 40
    const p0 = D / K
    for (let i = 1; i <= K; i++) {
      const g = Math.min(HAZARD_GMAX, state.drawsSince(i))
      raw[i] = (state.hazardHits[g] + a * p0) / (state.hazardExp[g] + a)
    }
    push('hazard', raw)
  }
  // cycle: gap-rhythm fit — high when current gap sits near the number's own mean gap
  {
    const raw = new Float64Array(S)
    for (let i = 1; i <= K; i++) {
      if (state.gapN[i] < 4) { raw[i] = 0; continue }
      const mu = state.meanGap(i)
      const sd = Math.max(1, state.gapSd(i))
      // regularity: tight gap distributions get a sharper, taller peak
      const regularity = mu / (sd + mu)
      raw[i] = gauss((state.drawsSince(i) - mu) / sd) * regularity
    }
    push('cycle', raw)
  }
  // repeat: P(appear | was in previous draw) vs P(appear | was not)
  {
    const raw = new Float64Array(S)
    if (ctx.prev && n >= 2) {
      const inPrev = new Set(ctx.prev.sorted)
      const m = 25
      for (let i = 1; i <= K; i++) {
        const p = state.rate(i, 20)
        if (inPrev.has(i)) {
          raw[i] = (state.repeatCount[i] + m * p) / (state.transOpp[i] + m)
        } else {
          const misses = state.counts[i] - state.repeatCount[i]
          const opp = n - 1 - state.transOpp[i]
          raw[i] = (misses + m * p) / (Math.max(0, opp) + m)
        }
      }
    }
    push('repeat', raw)
  }
  // follower: average transition rate from previous draw's numbers
  {
    const raw = new Float64Array(S)
    if (ctx.prev && n >= 2) {
      const m = 12
      for (let i = 1; i <= K; i++) {
        const p = state.rate(i, 20)
        let acc = 0
        for (const j of ctx.prev.sorted) {
          if (j > K) continue
          acc += (state.trans[j * S + i] + m * p) / (state.transOpp[j] + m)
        }
        raw[i] = acc / D
      }
    }
    push('follower', raw)
  }
  // followerDow: transitions restricted to successors on the target weekday
  {
    const raw = new Float64Array(S)
    if (ctx.prev && n >= 2) {
      const d = ctx.targetDow
      const m = 20
      for (let i = 1; i <= K; i++) {
        const p = state.rate(i, 20)
        let acc = 0
        for (const j of ctx.prev.sorted) {
          if (j > K) continue
          acc += (state.transByDow[(d * S + j) * S + i] + m * p) / (state.transOppByDow[d * S + j] + m)
        }
        raw[i] = acc / D
      }
    }
    push('followerDow', raw)
  }
  // position: probability mass across the positional value distributions
  if (usePosition) {
    const raw = new Float64Array(S)
    const alpha = 2
    for (let i = 1; i <= K; i++) {
      let acc = 0
      for (let p = 0; p < D; p++) {
        acc += (state.posCounts[p * S + i] + alpha * (1 / K)) / (n + alpha)
      }
      raw[i] = acc
    }
    push('position', raw)
  }
  // similarity
  {
    const { raw } = similarityScores(state, ctx)
    push('similarity', raw)
  }

  return out
}

export const SPECIAL_SIGNAL_KEYS = ['sFreq', 'sRecency', 'sDow', 'sOverdue', 'sFollower'] as const

/**
 * Signals for the bonus/special ball, computed over its own pool 1..Ks.
 * Uses only data already inside `state` — same leak-free guarantee as the mains.
 */
export function computeSpecialRawSignals(state: HistoryState, targetDow: number, Ks: number): RawSignal[] {
  const out: RawSignal[] = []
  const n = state.sN
  const freq = new Float64Array(Ks + 1)
  const rec = new Float64Array(Ks + 1)
  const dowF = new Float64Array(Ks + 1)
  const over = new Float64Array(Ks + 1)
  const fol = new Float64Array(Ks + 1)
  const nDow = (() => {
    let acc = 0
    for (let v = 1; v <= Ks; v++) acc += state.sByDow[targetDow * 100 + v]
    return acc
  })()
  let prevTotal = 0
  if (state.sPrev > 0) {
    for (let v = 1; v <= Ks; v++) prevTotal += state.sTrans[state.sPrev * 100 + v]
  }
  for (let v = 1; v <= Ks; v++) {
    const base = (state.sCounts[v] + 10 / Ks) / (n + 10)
    freq[v] = base
    rec[v] = state.sEwma[v]
    dowF[v] = (state.sByDow[targetDow * 100 + v] + 12 * base) / (nDow + 12)
    over[v] = Math.min(3, state.sDrawsSince(v) / Math.max(1, state.sMeanGap(v, Ks)))
    fol[v] = state.sPrev > 0 ? (state.sTrans[state.sPrev * 100 + v] + 8 * base) / (prevTotal + 8) : base
  }
  out.push({ key: 'sFreq', raw: freq })
  out.push({ key: 'sRecency', raw: rec })
  out.push({ key: 'sDow', raw: dowF })
  out.push({ key: 'sOverdue', raw: over })
  out.push({ key: 'sFollower', raw: fol })
  return out
}

/** Indices of the m largest values in arr (1..K), descending. */
export function topIndices(arr: Float64Array, K: number, m: number): number[] {
  const idx: number[] = []
  for (let i = 1; i <= K; i++) idx.push(i)
  idx.sort((a, b) => arr[b] - arr[a] || a - b)
  return idx.slice(0, m)
}

/**
 * Same ordering as topIndices (value desc, index asc on ties) but selects only
 * the top m by insertion — the hot path in the backtest, which needs a top-10
 * per signal per draw and never the full ranking.
 */
export function topIndicesPartial(arr: Float64Array, K: number, m: number): number[] {
  if (m >= K) return topIndices(arr, K, m)
  const out: number[] = []
  for (let i = 1; i <= K; i++) {
    const v = arr[i]
    if (out.length === m && !(v > arr[out[m - 1]])) continue
    let lo = 0, hi = out.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      // strictly-greater goes earlier; equal values keep ascending index order
      if (arr[out[mid]] > v || (arr[out[mid]] === v && out[mid] < i)) lo = mid + 1
      else hi = mid
    }
    out.splice(lo, 0, i)
    if (out.length > m) out.pop()
  }
  return out
}
