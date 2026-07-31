import type { BacktestPoint, BacktestSummary, Draw, SignalPerformance } from './types.ts'
import { HistoryState } from './state.ts'
import { computeRawSignals, computeSpecialRawSignals, SIGNAL_LABEL, signalKeys, SPECIAL_SIGNAL_KEYS, topIndices, topIndicesPartial, zNormalize } from './signals.ts'

export const MIN_HISTORY = 30

/**
 * Online-regression combiner hyperparameters, chosen by sweeping structured
 * sample data (maximize learned skill) against random seeds (log-score must
 * stay near zero — an honest model must not become over-confident on noise).
 */
export const ML_TUNING = { eta: 0.02, l2: 1e-3 }

export interface BacktestOutput {
  summary: BacktestSummary
  /** Learned ensemble weights (used for the live prediction) */
  weights: Record<string, number>
  /** Calibrated P(hit) for each predicted rank 1..K */
  rankHitRate: number[]
  /** Bonus-ball learned weights (when the game has one) */
  specialWeights: Record<string, number> | null
  /** Bonus-ball calibrated P(hit) by predicted rank */
  specialRankHitRate: number[] | null
  /** Trained coefficients of the online regression combiner (base-signal order) */
  mlWeights: number[]
}

/**
 * Convert per-signal skill estimates into ensemble weights.
 * Signals that do not beat chance get zero weight; positive skill is
 * sharpened (^2) so genuinely predictive signals dominate.
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
  // meaningful: SE of the mean-hits metric shrinks with backtest size. Because
  // we take the max over ~18 (correlated) signals, the noise ceiling sits near
  // 2.5 SE — concentration starts there and reaches full trust at 5 SE.
  // On random data max skill hovers inside the noise band, so weights stay uniform.
  const se = Math.sqrt(Math.max(0.05, chance10)) / Math.sqrt(Math.max(1, evaluated))
  const trust = Math.max(0, Math.min(1, (maxSkill / se - 2.0) / 2.5))
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
  const blocks: { v: number; w: number; len: number }[] = []
  for (let i = 0; i < n; i++) {
    let cur = { v: rates[i], w: weights[i], len: 1 }
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
  return out
}

export function runBacktest(draws: Draw[], K: number, drawSize: number, usePosition: boolean, specialKs = 0): BacktestOutput {
  const N = draws.length
  const D = drawSize
  const state = new HistoryState(K, D)
  const chancePick = (D * Math.min(D, K)) / K
  const chance10 = (D * Math.min(10, K)) / K
  const keysAll = signalKeys(usePosition)

  // Online multinomial-regression combiner: one shared coefficient per base
  // signal, trained walk-forward by AdaGrad on the draw's log-likelihood
  // (softmax over the pool, the actual numbers as positives). Its logit vector
  // joins the ensemble as the 'mlModel' signal, subject to the same
  // significance-gated weighting as every other signal.
  const baseKeys = keysAll.filter((k) => k !== 'mlModel')
  const F = baseKeys.length
  const mlW = new Float64Array(F)
  const mlG = new Float64Array(F)
  const ML_ETA = ML_TUNING.eta
  const ML_L2 = ML_TUNING.l2
  let mlLLGain = 0 // Σ log(p_actual · K): log-likelihood above uniform, in nats

  // Global skill state: recent (EMA) and lifetime, per signal
  const emaG: Record<string, number> = {}
  const sumHits10: Record<string, number> = {}
  const evalCount: Record<string, number> = {}
  const emaLambda = Math.pow(0.5, 1 / 80)

  /**
   * A signal only earns weight if it beats chance BOTH recently (EMA) and over
   * its lifetime — the min of the two kills signals that merely got lucky.
   * (A per-weekday weight adaptation was evaluated and removed: it added no
   * measurable accuracy on structured data but let same-weekday noise streaks
   * concentrate weight on random data. Weekday structure is instead captured
   * per-number by the freqDow / dowRecent / followerDow signals.)
   */
  const skillUsed = (): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const k of keysAll) {
      const lifetime = (evalCount[k] ?? 0) > 0 ? sumHits10[k] / evalCount[k] - chance10 : 0
      out[k] = Math.min(emaG[k] ?? 0, lifetime)
    }
    return out
  }

  // Bonus-ball learner state (only used when specialKs > 0)
  const sEma: Record<string, number> = {}
  const sSum: Record<string, number> = {}
  const sCount: Record<string, number> = {}
  const sChance3 = specialKs > 0 ? Math.min(3, specialKs) / specialKs : 0
  const sHitsAtRank = new Uint32Array(Math.max(1, specialKs + 1))
  let sEvaluated = 0, sTop1 = 0, sTop3 = 0
  const sEmaLambda = Math.pow(0.5, 1 / 80)
  const sSkillUsed = (): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const k of SPECIAL_SIGNAL_KEYS) {
      const lifetime = (sCount[k] ?? 0) > 0 ? sSum[k] / sCount[k] - sChance3 : 0
      out[k] = Math.min(sEma[k] ?? 0, lifetime)
    }
    return out
  }

  const points: BacktestPoint[] = []
  const dowAgg = Array.from({ length: 7 }, () => ({ draws: 0, ens10: 0, base10: 0 }))
  const hitsAtRank = new Uint32Array(K + 1)
  let evaluated = 0
  let ensSumPick = 0, ensSum10 = 0, baseSumPick = 0, baseSum10 = 0
  let ens10AtLeast2 = 0

  for (let t = 0; t < N; t++) {
    const target = draws[t]
    if (t >= MIN_HISTORY) {
      const ctx = { targetDow: target.dow, prev: draws[t - 1] }
      const rawSignals = computeRawSignals(state, ctx, usePosition)
      const keys = rawSignals.map((s) => s.key)
      const zs = rawSignals.map((s) => zNormalize(s.raw, K))
      const actual = new Set(target.sorted.filter((x) => x <= K))

      // Combiner prediction from coefficients trained on draws BEFORE t only
      const logits = new Float64Array(K + 1)
      for (let s = 0; s < F; s++) {
        const w = mlW[s]
        if (w === 0) continue
        const z = zs[s]
        for (let i = 1; i <= K; i++) logits[i] += w * z[i]
      }
      let maxL = 0
      for (let i = 1; i <= K; i++) if (logits[i] > maxL) maxL = logits[i]
      const probs = new Float64Array(K + 1)
      let expSum = 0
      for (let i = 1; i <= K; i++) { probs[i] = Math.exp(logits[i] - maxL); expSum += probs[i] }
      for (let i = 1; i <= K; i++) probs[i] /= expSum
      for (const i of actual) mlLLGain += Math.log(Math.max(1e-300, probs[i]) * K)
      keys.push('mlModel')
      zs.push(zNormalize(logits, K))

      // Per-signal evaluation (top-10 hit count)
      const sigHits: Record<string, number> = {}
      for (let s = 0; s < keys.length; s++) {
        const top10 = topIndicesPartial(zs[s], K, Math.min(10, K))
        let h = 0
        for (const i of top10) if (actual.has(i)) h++
        sigHits[keys[s]] = h
      }

      // Ensemble uses weights learned from draws BEFORE t only
      const weights = weightsFromSkills(keys, skillUsed(), evaluated, chance10)
      const ens = new Float64Array(K + 1)
      for (let s = 0; s < keys.length; s++) {
        const w = weights[keys[s]] ?? 0
        if (w <= 0) continue
        const z = zs[s]
        for (let i = 1; i <= K; i++) ens[i] += w * z[i]
      }
      const order = topIndices(ens, K, K)
      let hPick = 0, h10 = 0
      order.forEach((num, pos) => {
        if (actual.has(num)) {
          hitsAtRank[pos + 1]++
          if (pos < D) hPick++
          if (pos < 10) h10++
        }
      })

      // Baseline: plain overall frequency
      const freqZ = zs[keys.indexOf('freqAll')]
      const baseTop = topIndices(freqZ, K, Math.min(Math.max(10, D), K))
      let bPick = 0, b10 = 0
      baseTop.forEach((num, pos) => {
        if (actual.has(num)) {
          if (pos < D) bPick++
          if (pos < 10) b10++
        }
      })

      evaluated++
      ensSumPick += hPick; ensSum10 += h10; baseSumPick += bPick; baseSum10 += b10
      if (h10 >= 2) ens10AtLeast2++
      dowAgg[target.dow].draws++
      dowAgg[target.dow].ens10 += h10
      dowAgg[target.dow].base10 += b10
      const point: BacktestPoint = {
        index: t,
        date: target.date,
        dow: target.dow,
        hitsPick: hPick,
        hits10: h10,
        baselineHitsPick: bPick,
        baselineHits10: b10,
        predictedTop: order.slice(0, Math.min(10, K)),
        actual: [...target.sorted],
      }

      // Bonus-ball self-test (own pool, own learned weights)
      if (specialKs > 0 && target.special !== undefined && target.special >= 1 && target.special <= specialKs) {
        const sRaws = computeSpecialRawSignals(state, target.dow, specialKs)
        const sZs = sRaws.map((r) => zNormalize(r.raw, specialKs))
        const sKeys = sRaws.map((r) => r.key)
        const sSigHits: Record<string, number> = {}
        for (let i = 0; i < sKeys.length; i++) {
          const top3 = topIndicesPartial(sZs[i], specialKs, Math.min(3, specialKs))
          sSigHits[sKeys[i]] = top3.includes(target.special) ? 1 : 0
        }
        const sWeights = weightsFromSkills(sKeys, sSkillUsed(), sEvaluated, sChance3)
        const sEns = new Float64Array(specialKs + 1)
        for (let i = 0; i < sKeys.length; i++) {
          const w = sWeights[sKeys[i]] ?? 0
          if (w <= 0) continue
          for (let v = 1; v <= specialKs; v++) sEns[v] += w * sZs[i][v]
        }
        const sOrder = topIndices(sEns, specialKs, specialKs)
        const rank = sOrder.indexOf(target.special)
        if (rank >= 0) sHitsAtRank[rank + 1]++
        if (rank === 0) sTop1++
        if (rank >= 0 && rank < 3) sTop3++
        sEvaluated++
        point.specialTop = sOrder.slice(0, Math.min(3, specialKs))
        point.specialActual = target.special
        for (const k of sKeys) {
          const excess = sSigHits[k] - sChance3
          sEma[k] = sEma[k] === undefined ? excess : sEmaLambda * sEma[k] + (1 - sEmaLambda) * excess
          sSum[k] = (sSum[k] ?? 0) + sSigHits[k]
          sCount[k] = (sCount[k] ?? 0) + 1
        }
      }

      points.push(point)

      // Update skill state AFTER evaluating (this draw informs future weights only)
      for (const k of keys) {
        const excess = sigHits[k] - chance10
        emaG[k] = emaG[k] === undefined ? excess : emaLambda * emaG[k] + (1 - emaLambda) * excess
        sumHits10[k] = (sumHits10[k] ?? 0) + sigHits[k]
        evalCount[k] = (evalCount[k] ?? 0) + 1
      }

      // Train the combiner on this draw (informs future predictions only):
      // gradient of the negative log-likelihood, AdaGrad step, light L2
      for (let s = 0; s < F; s++) {
        const z = zs[s]
        let ez = 0
        for (let i = 1; i <= K; i++) ez += probs[i] * z[i]
        let g = actual.size * ez
        for (const i of actual) g -= z[i]
        mlG[s] += g * g
        mlW[s] -= (ML_ETA / Math.sqrt(mlG[s] + 1e-8)) * (g + ML_L2 * mlW[s])
      }
    }
    state.push(target)
  }

  // Rank calibration: empirical hit-rate by predicted rank, shrunk + monotone
  const M = 30 // pseudo-observations toward chance
  const rates: number[] = []
  const rateW: number[] = []
  for (let r = 1; r <= K; r++) {
    rates.push((hitsAtRank[r] + M * (D / K)) / (evaluated + M))
    rateW.push(1)
  }
  const rankHitRate = evaluated > 0 ? isotonicDecreasing(rates, rateW) : Array.from({ length: K }, () => D / K)

  const finalWeights = weightsFromSkills(keysAll, skillUsed(), evaluated, chance10)

  // Bonus-ball final weights + rank calibration
  let specialWeights: Record<string, number> | null = null
  let specialRankHitRate: number[] | null = null
  if (specialKs > 0) {
    specialWeights = weightsFromSkills([...SPECIAL_SIGNAL_KEYS], sSkillUsed(), sEvaluated, sChance3)
    const Ms = 25
    const sRates: number[] = []
    const sW: number[] = []
    for (let r = 1; r <= specialKs; r++) {
      sRates.push((sHitsAtRank[r] + Ms * (1 / specialKs)) / (sEvaluated + Ms))
      sW.push(1)
    }
    specialRankHitRate = sEvaluated > 0 ? isotonicDecreasing(sRates, sW) : Array.from({ length: specialKs }, () => 1 / specialKs)
  }

  const signals: SignalPerformance[] = keysAll
    .filter((k) => (evalCount[k] ?? 0) > 0 || evaluated === 0)
    .map((k) => {
      const meta = SIGNAL_LABEL[k]
      const avg = (evalCount[k] ?? 0) > 0 ? sumHits10[k] / evalCount[k] : 0
      return {
        key: k,
        label: meta?.label ?? k,
        short: meta?.short ?? k,
        description: meta?.description ?? '',
        avgHits10: avg,
        skill: avg - chance10,
        weight: finalWeights[k] ?? 0,
        evaluated: evalCount[k] ?? 0,
      }
    })
  signals.sort((a, b) => b.weight - a.weight || b.skill - a.skill)

  const summary: BacktestSummary = {
    evaluated,
    minHistory: MIN_HISTORY,
    chancePick,
    chance10,
    ensemblePick: evaluated ? ensSumPick / evaluated : 0,
    ensemble10: evaluated ? ensSum10 / evaluated : 0,
    baselinePick: evaluated ? baseSumPick / evaluated : 0,
    baseline10: evaluated ? baseSum10 / evaluated : 0,
    ens10AtLeast2: evaluated ? ens10AtLeast2 / evaluated : 0,
    mlSkillNats: evaluated ? mlLLGain / evaluated : 0,
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
    ...(specialKs > 0
      ? {
          special: {
            evaluated: sEvaluated,
            top1: sEvaluated ? sTop1 / sEvaluated : 0,
            top3: sEvaluated ? sTop3 / sEvaluated : 0,
            chance1: 1 / specialKs,
            chance3: sChance3,
          },
        }
      : {}),
  }

  return { summary, weights: finalWeights, rankHitRate, specialWeights, specialRankHitRate, mlWeights: Array.from(mlW) }
}
