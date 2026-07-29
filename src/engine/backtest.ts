import type { BacktestPoint, BacktestSummary, Draw, SignalPerformance } from './types.ts'
import { HistoryState } from './state.ts'
import { computeRawSignals, SIGNAL_LABEL, SIGNAL_META, topIndices, zNormalize } from './signals.ts'

export const MIN_HISTORY = 30

export interface BacktestOutput {
  summary: BacktestSummary
  /** Final learned weights keyed by signal — used for the live prediction */
  weights: Record<string, number>
  /** Final per-signal skill (EMA of hits@10 above chance) */
  skills: Record<string, number>
  /** Calibrated P(hit) for each predicted rank 1..K */
  rankHitRate: number[]
}

/**
 * Convert per-signal skill estimates into ensemble weights.
 * Signals that do not beat chance get zero weight; positive skill is
 * sharpened (^1.5) so genuinely predictive signals dominate.
 * Early on (few evaluated draws) weights are blended toward uniform.
 */
export function weightsFromSkills(
  keys: string[],
  skill: Record<string, number>,
  evaluated: number,
  chance10: number,
  sharpen = 2,
): Record<string, number> {
  // Signals below 35% of the best signal's skill are treated as noise
  let maxSkill = 0
  for (const k of keys) maxSkill = Math.max(maxSkill, skill[k] ?? 0)
  const floor = 0.35 * maxSkill
  const raw: Record<string, number> = {}
  let sum = 0
  for (const k of keys) {
    const w = Math.pow(Math.max(0, (skill[k] ?? 0) - floor), sharpen)
    raw[k] = w
    sum += w
  }
  const uniform = 1 / keys.length
  // Trust the learned weights only when the best signal's edge is statistically
  // meaningful: SE of the mean-hits metric shrinks with backtest size, and the
  // edge must clear ~1.5 SE before any concentration begins (full at 4 SE).
  // On random data max skill hovers inside the noise band, so weights stay uniform.
  const se = Math.sqrt(Math.max(0.05, chance10)) / Math.sqrt(Math.max(1, evaluated))
  const trust = Math.max(0, Math.min(1, (maxSkill / se - 1.5) / 2.5))
  const out: Record<string, number> = {}
  if (sum <= 1e-12) {
    for (const k of keys) out[k] = uniform
    return out
  }
  for (const k of keys) out[k] = (1 - trust) * uniform + trust * (raw[k] / sum)
  return out
}

/** Pool-adjacent-violators: make rank hit-rates non-increasing. */
export function isotonicDecreasing(rates: number[], weights: number[]): number[] {
  const n = rates.length
  const val = [...rates]
  const w = [...weights]
  const idx: number[] = [] // block end pointers
  const blocks: { v: number; w: number; len: number }[] = []
  for (let i = 0; i < n; i++) {
    let cur = { v: val[i], w: w[i], len: 1 }
    while (blocks.length > 0 && blocks[blocks.length - 1].v < cur.v) {
      const prev = blocks.pop()!
      cur = {
        v: (prev.v * prev.w + cur.v * cur.w) / (prev.w + cur.w),
        w: prev.w + cur.w,
        len: prev.len + cur.len,
      }
    }
    blocks.push(cur)
  }
  const out: number[] = []
  for (const b of blocks) for (let i = 0; i < b.len; i++) out.push(b.v)
  void idx
  return out
}

export function runBacktest(draws: Draw[], K: number, usePosition: boolean): BacktestOutput {
  const N = draws.length
  const state = new HistoryState(K)
  const chance5 = (5 * Math.min(5, K)) / K
  const chance10 = (5 * Math.min(10, K)) / K

  const skills: Record<string, number> = {}
  const sumHits10: Record<string, number> = {}
  const evalCount: Record<string, number> = {}
  const emaLambda = Math.pow(0.5, 1 / 80)

  let weights: Record<string, number> | null = null
  const points: BacktestPoint[] = []
  const dowAgg = Array.from({ length: 7 }, () => ({ draws: 0, ens10: 0, base10: 0 }))
  const hitsAtRank = new Uint32Array(K + 1)
  let evaluated = 0
  let ensSum5 = 0, ensSum10 = 0, baseSum5 = 0, baseSum10 = 0
  let ens10AtLeast2 = 0

  for (let t = 0; t < N; t++) {
    const target = draws[t]
    if (t >= MIN_HISTORY) {
      const ctx = { targetDow: target.dow, prev: draws[t - 1] }
      const rawSignals = computeRawSignals(state, ctx, usePosition)
      const keys = rawSignals.map((s) => s.key)
      const zs = rawSignals.map((s) => zNormalize(s.raw, K))
      const actual = new Set(target.sorted.filter((x) => x <= K))

      // Per-signal evaluation (top-10 hit count)
      const sigHits: Record<string, number> = {}
      for (let s = 0; s < keys.length; s++) {
        const top10 = topIndices(zs[s], K, Math.min(10, K))
        let h = 0
        for (const i of top10) if (actual.has(i)) h++
        sigHits[keys[s]] = h
        sumHits10[keys[s]] = (sumHits10[keys[s]] ?? 0) + h
        evalCount[keys[s]] = (evalCount[keys[s]] ?? 0) + 1
      }

      // Ensemble uses weights learned from draws BEFORE t only
      if (!weights) weights = weightsFromSkills(keys, skills, 0, chance10)
      const ens = new Float64Array(K + 1)
      for (let s = 0; s < keys.length; s++) {
        const w = weights[keys[s]] ?? 0
        if (w <= 0) continue
        const z = zs[s]
        for (let i = 1; i <= K; i++) ens[i] += w * z[i]
      }
      const order = topIndices(ens, K, K)
      let h5 = 0, h10 = 0
      order.forEach((num, pos) => {
        if (actual.has(num)) {
          hitsAtRank[pos + 1]++
          if (pos < 5) h5++
          if (pos < 10) h10++
        }
      })

      // Baseline: plain overall frequency
      const freqZ = zs[keys.indexOf('freqAll')]
      const baseTop = topIndices(freqZ, K, Math.min(10, K))
      let b5 = 0, b10 = 0
      baseTop.forEach((num, pos) => {
        if (actual.has(num)) {
          if (pos < 5) b5++
          b10++
        }
      })

      evaluated++
      ensSum5 += h5; ensSum10 += h10; baseSum5 += b5; baseSum10 += b10
      if (h10 >= 2) ens10AtLeast2++
      dowAgg[target.dow].draws++
      dowAgg[target.dow].ens10 += h10
      dowAgg[target.dow].base10 += b10
      points.push({ index: t, date: target.date, dow: target.dow, hits5: h5, hits10: h10, baselineHits5: b5, baselineHits10: b10 })

      // Update skills AFTER evaluating (so this draw informs future weights only).
      // A signal only earns weight if it beats chance BOTH recently (EMA) and over
      // its lifetime — taking the min kills signals that merely got lucky lately.
      for (const k of keys) {
        const excess = sigHits[k] - chance10
        skills[k] = skills[k] === undefined ? excess : emaLambda * skills[k] + (1 - emaLambda) * excess
      }
      const skillUsed: Record<string, number> = {}
      for (const k of keys) {
        const lifetime = sumHits10[k] / Math.max(1, evalCount[k]) - chance10
        skillUsed[k] = Math.min(skills[k], lifetime)
      }
      weights = weightsFromSkills(keys, skillUsed, evaluated, chance10)
    }
    state.push(target)
  }

  // Rank calibration: empirical hit-rate by predicted rank, shrunk + monotone
  const M = 30 // pseudo-observations toward chance
  const rates: number[] = []
  const rateW: number[] = []
  for (let r = 1; r <= K; r++) {
    rates.push((hitsAtRank[r] + M * (5 / K)) / (evaluated + M))
    rateW.push(1)
  }
  const rankHitRate = evaluated > 0 ? isotonicDecreasing(rates, rateW) : Array.from({ length: K }, () => 5 / K)

  const signals: SignalPerformance[] = Object.keys(sumHits10).map((k) => {
    const meta = SIGNAL_LABEL[k]
    const avg = sumHits10[k] / Math.max(1, evalCount[k])
    return {
      key: k,
      label: meta?.label ?? k,
      short: meta?.short ?? k,
      description: meta?.description ?? '',
      avgHits10: avg,
      skill: avg - chance10,
      weight: weights?.[k] ?? 0,
      evaluated: evalCount[k],
    }
  })
  signals.sort((a, b) => b.weight - a.weight || b.skill - a.skill)

  const summary: BacktestSummary = {
    evaluated,
    minHistory: MIN_HISTORY,
    chance5,
    chance10,
    ensemble5: evaluated ? ensSum5 / evaluated : 0,
    ensemble10: evaluated ? ensSum10 / evaluated : 0,
    baseline5: evaluated ? baseSum5 / evaluated : 0,
    baseline10: evaluated ? baseSum10 / evaluated : 0,
    ens10AtLeast2: evaluated ? ens10AtLeast2 / evaluated : 0,
    points,
    byDow: dowAgg
      .map((d, dow) => ({
        dow,
        draws: d.draws,
        ensemble10: d.draws ? d.ens10 / d.draws : 0,
        baseline10: d.draws ? d.base10 / d.draws : 0,
      }))
      .filter((d) => d.draws > 0),
    signals,
    rankHitRate,
  }

  // With fewer than MIN_HISTORY draws the loop never evaluates, so no weights
  // were learned — fall back to a uniform blend over the same signal set the
  // live prediction will compute (never an empty map, which would zero out
  // every signal and reduce the ranking to a numeric tie-break).
  const finalWeights = weights ?? weightsFromSkills(
    SIGNAL_META.map((m) => m.key).filter((k) => usePosition || k !== 'position'),
    {},
    0,
    chance10,
  )
  return { summary, weights: finalWeights, skills, rankHitRate }
}
