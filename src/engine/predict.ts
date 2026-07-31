import type { NumberPrediction, NumberStats } from './types.ts'
import { HAZARD_GMAX, HistoryState } from './state.ts'
import { computeRawSignals, SIGNAL_LABEL, zNormalize, type SignalContext } from './signals.ts'
import { DOW_NAMES } from './dates.ts'

const pct = (x: number, digits = 1) => `${(100 * x).toFixed(digits)}%`

export function numberStats(state: HistoryState, ctx: SignalContext, i: number): NumberStats {
  const S = state.K + 1
  const d = ctx.targetDow
  const w20 = Math.min(state.n, 20)
  const p = state.rate(i, 10)
  const sd20 = Math.sqrt(Math.max(1e-9, w20 * p * (1 - p)))
  const r10 = state.w10[i] / Math.max(1, Math.min(state.n, 10))
  const r50 = state.w50[i] / Math.max(1, Math.min(state.n, 50))
  return {
    number: i,
    count: state.counts[i],
    overallRate: state.n ? state.counts[i] / state.n : 0,
    expectedRate: state.D / state.K,
    last20: state.w20[i],
    drawsSinceSeen: state.drawsSince(i),
    meanGap: state.meanGap(i),
    gapSd: state.gapSd(i),
    dowCount: state.countsByDow[d * S + i],
    dowRate: state.drawsByDow[d] ? state.countsByDow[d * S + i] / state.drawsByDow[d] : 0,
    dowDraws: state.drawsByDow[d],
    streak: state.streak[i],
    maxStreak: state.maxStreak[i],
    repeatRate: state.transOpp[i] ? state.repeatCount[i] / state.transOpp[i] : 0,
    momentum: r10 - r50,
    hotZ: w20 > 0 ? (state.w20[i] - w20 * p) / sd20 : 0,
    overdueRatio: state.drawsSince(i) / Math.max(1, state.meanGap(i)),
  }
}

function reasonFor(key: string, i: number, state: HistoryState, ctx: SignalContext, st: NumberStats): string {
  const S = state.K + 1
  switch (key) {
    case 'freqAll':
      return `Drawn ${st.count}× overall — ${pct(st.overallRate)} of draws vs ${pct(st.expectedRate)} expected`
    case 'freqDow':
      return `${st.dowCount}× on ${DOW_NAMES[ctx.targetDow]}s (${pct(st.dowRate)} of ${st.dowDraws} draws vs ${pct(st.overallRate)} overall)`
    case 'recencyFast': {
      const ratio = st.overallRate > 0 ? state.ewmaFast[i] / st.overallRate : 0
      return `Very recent activity is ${ratio.toFixed(2)}× its long-run rate (fast decay)`
    }
    case 'recency': {
      const ratio = st.overallRate > 0 ? state.ewma[i] / st.overallRate : 0
      return `Recent activity is ${ratio.toFixed(2)}× its long-run rate`
    }
    case 'recencySlow': {
      const ratio = st.overallRate > 0 ? state.ewmaSlow[i] / st.overallRate : 0
      return `Sustained activity is ${ratio.toFixed(2)}× its long-run rate (slow decay)`
    }
    case 'dowRecent': {
      const S2 = state.K + 1
      const c = state.dowRecent[ctx.targetDow * S2 + i]
      return `${c} hit${c === 1 ? '' : 's'} in the last ${Math.min(state.drawsByDow[ctx.targetDow], 8)} ${DOW_NAMES[ctx.targetDow]} draws`
    }
    case 'window10':
      return `${state.w10[i]} hit${state.w10[i] === 1 ? '' : 's'} in the last 10 draws (expected ${(10 * st.expectedRate).toFixed(1)})`
    case 'window20':
      return `${state.w20[i]} hits in the last 20 draws (expected ${(20 * st.expectedRate).toFixed(1)})`
    case 'window50':
      return `${state.w50[i]} hits in the last 50 draws (expected ${(50 * st.expectedRate).toFixed(1)})`
    case 'zone': {
      let nb = 0
      for (let d = -2; d <= 2; d++) {
        const j = i + d
        if (j >= 1 && j <= state.K) nb += state.counts[j]
      }
      return `Sits in an active zone: numbers ${Math.max(1, i - 2)}–${Math.min(state.K, i + 2)} drawn ${nb}× combined`
    }
    case 'hot':
      return `Running ${st.hotZ >= 0 ? '+' : ''}${st.hotZ.toFixed(1)}σ vs expectation over the last 20 draws`
    case 'momentum':
      return `Rising: ${pct(state.w10[i] / Math.max(1, Math.min(state.n, 10)), 0)} rate in last 10 vs ${pct(state.w50[i] / Math.max(1, Math.min(state.n, 50)), 0)} in last 50`
    case 'overdue':
      return `${st.drawsSinceSeen} draws since last seen — ${st.overdueRatio.toFixed(1)}× its average gap of ${st.meanGap.toFixed(1)}`
    case 'cycle':
      return `Gap rhythm: reappears every ${st.meanGap.toFixed(1)}±${st.gapSd.toFixed(1)} draws; currently at ${st.drawsSinceSeen}`
    case 'repeat':
      // Only headline this signal for numbers that were actually in the last draw;
      // for the rest its (small) contribution is explained by the signal description.
      return ctx.prev && ctx.prev.sorted.includes(i)
        ? `Was in the last draw; historically repeats ${pct(st.repeatRate)} of the time`
        : ''
    case 'follower': {
      if (!ctx.prev) return ''
      let bestJ = 0, bestRate = 0, bestCount = 0
      for (const j of ctx.prev.sorted) {
        if (j > state.K || state.transOpp[j] < 5) continue
        const r = state.trans[j * S + i] / state.transOpp[j]
        if (r > bestRate) { bestRate = r; bestJ = j; bestCount = state.trans[j * S + i] }
      }
      return bestJ
        ? `Followed ${bestJ} (in last draw) ${bestCount}× — ${pct(bestRate)} of the time vs ${pct(st.overallRate)} overall`
        : `Historically follows the numbers just drawn`
    }
    case 'followerDow':
      return `Follows the last draw's numbers specifically on ${DOW_NAMES[ctx.targetDow]}s`
    case 'position':
      return `Matches the value ranges the feed's positions usually produce`
    case 'similarity':
      return `Appeared often after the most similar historical situations`
    case 'hazard': {
      const g = Math.min(HAZARD_GMAX, state.drawsSince(i))
      const exp = state.hazardExp[g]
      const hit = state.hazardHits[g]
      return exp >= 20
        ? `Numbers at a ${g}-draw gap have historically hit ${pct(hit / exp)} of the time here`
        : ''
    }
    case 'mlModel':
      return `Ranked high by the trained regression model that weighs every signal at once`
    default:
      return ''
  }
}

export interface PredictOutput {
  predictions: NumberPrediction[]
  ensemble: Float64Array
}

export function predictNext(
  state: HistoryState,
  ctx: SignalContext,
  weights: Record<string, number>,
  rankHitRate: number[],
  evaluated: number,
  usePosition: boolean,
  mlWeights: number[] | null = null,
): PredictOutput {
  const K = state.K
  const rawSignals = computeRawSignals(state, ctx, usePosition)
  const zs = rawSignals.map((s) => ({ key: s.key, z: zNormalize(s.raw, K) }))

  // The trained combiner's logits join as one more signal (same feature order
  // as the backtest that fit the coefficients)
  if (mlWeights && mlWeights.length > 0) {
    const logits = new Float64Array(K + 1)
    const F = Math.min(mlWeights.length, zs.length)
    for (let s = 0; s < F; s++) {
      const w = mlWeights[s]
      if (w === 0) continue
      const z = zs[s].z
      for (let i = 1; i <= K; i++) logits[i] += w * z[i]
    }
    zs.push({ key: 'mlModel', z: zNormalize(logits, K) })
  }

  const ensemble = new Float64Array(K + 1)
  for (const { key, z } of zs) {
    const w = weights[key] ?? 0
    if (w <= 0) continue
    for (let i = 1; i <= K; i++) ensemble[i] += w * z[i]
  }

  const order: number[] = []
  for (let i = 1; i <= K; i++) order.push(i)
  order.sort((a, b) => ensemble[b] - ensemble[a] || a - b)

  const chance = state.D / K
  const predictions: NumberPrediction[] = order.map((num, pos) => {
    const st = numberStats(state, ctx, num)
    const contributions = zs
      .map(({ key, z }) => ({
        key,
        label: SIGNAL_LABEL[key]?.short ?? key,
        contribution: (weights[key] ?? 0) * z[num],
        reason: '',
      }))
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    for (const c of contributions.slice(0, 6)) c.reason = reasonFor(c.key, num, state, ctx, st)

    const probability = rankHitRate[pos] ?? chance
    const edge = probability / chance
    let confidence: 'High' | 'Medium' | 'Low' = 'Low'
    if (evaluated >= 120 && edge >= 1.12) confidence = 'High'
    else if (evaluated >= 40 && edge >= 1.03) confidence = 'Medium'

    return {
      number: num,
      rank: pos + 1,
      score: ensemble[num],
      probability,
      contributions,
      stats: st,
      confidence,
    }
  })

  return { predictions, ensemble }
}
