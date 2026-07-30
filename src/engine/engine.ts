import type { DriverEntry, Draw, EngineResult, Settings, SimilarSituation, SpecialResult } from './types.ts'
import { HistoryState } from './state.ts'
import { runBacktest, MIN_HISTORY } from './backtest.ts'
import { predictNext } from './predict.ts'
import { buildCombos } from './combos.ts'
import { computeSpecialRawSignals, similarityScores, SIGNAL_LABEL, zNormalize } from './signals.ts'
import {
  currentStreaks, dowProfiles, hotCold, overdueList, positionProfiles,
  topFollowers, topPairs, trends, windowCounts,
} from './analytics.ts'
import { addDays, dowOf } from './dates.ts'

export const MAX_POOL = 150
export const MIN_DRAWS = 12

function emptyResult(message: string): EngineResult {
  return {
    ok: false, message, K: 0, drawSize: 0, drawCount: 0, firstDate: '', lastDate: '',
    scheduleDows: [], nextDate: '', nextDow: 0, inputSorted: true,
    predictions: [], topPick: [], top10: [], bestCombo: null, altCombos: [],
    drivers: [], weightsLearned: false, special: null, eraNotice: null,
    hot: [], cold: [], overdue: [], pairs: [], followers: [], dowProfiles: [],
    rising: [], falling: [], streaks: [], positions: [], similar: [],
    frequency: [], windowFrequency: [],
    backtest: {
      evaluated: 0, minHistory: MIN_HISTORY, chancePick: 0, chance10: 0,
      ensemblePick: 0, ensemble10: 0, baselinePick: 0, baseline10: 0, ens10AtLeast2: 0,
      points: [], byDow: [], signals: [], rankHitRate: [],
    },
    computeMs: 0,
  }
}

/** Determine which weekdays this game draws on (>= 4% of draws, at least 2). */
export function detectSchedule(draws: Draw[]): number[] {
  const byDow = new Uint32Array(7)
  for (const d of draws) byDow[d.dow]++
  const threshold = Math.max(2, Math.floor(draws.length * 0.04))
  const dows: number[] = []
  for (let d = 0; d < 7; d++) if (byDow[d] >= threshold) dows.push(d)
  if (dows.length === 0 && draws.length > 0) dows.push(draws[draws.length - 1].dow)
  return dows
}

export function inferNextDate(draws: Draw[], schedule: number[]): string {
  const last = draws[draws.length - 1].date
  for (let step = 1; step <= 14; step++) {
    const candidate = addDays(last, step)
    if (schedule.includes(dowOf(candidate))) return candidate
  }
  return addDays(last, 1)
}

export function runEngine(draws: Draw[], settings: Settings): EngineResult {
  const started = performance.now()
  if (draws.length < MIN_DRAWS) {
    return emptyResult(
      draws.length === 0
        ? 'No historical data yet. Import a CSV/Excel file or load the sample dataset.'
        : `Only ${draws.length} draws loaded — at least ${MIN_DRAWS} are needed for meaningful analysis (${MIN_HISTORY + 20}+ recommended so backtesting can learn signal weights).`,
    )
  }

  // Numbers per draw: every row must agree
  const sizes = new Set(draws.map((d) => d.sorted.length))
  if (sizes.size > 1) {
    const found = [...sizes].sort((a, b) => a - b).join(' and ')
    return emptyResult(`Your history mixes draws with ${found} numbers. Re-import so every draw has the same count (set "Numbers per draw" in Settings if your file has bonus columns).`)
  }
  const D = draws[0].sorted.length

  let maxObserved = 0
  for (const d of draws) for (const n of d.sorted) maxObserved = Math.max(maxObserved, n)
  const K = settings.poolMax > 0 ? settings.poolMax : maxObserved
  if (maxObserved > K) {
    return emptyResult(`Your data contains ${maxObserved}, above the configured pool maximum of ${K}. Raise "Highest number" in Settings.`)
  }
  if (K > MAX_POOL) {
    return emptyResult(`Pool sizes above ${MAX_POOL} are not supported (largest number seen: ${maxObserved}).`)
  }
  if (K < D + 4) {
    return emptyResult(`The number pool is too small to analyze (highest number must be at least ${D + 4}).`)
  }

  const inputSorted = draws.every((d) => d.numbers.every((v, idx) => idx === 0 || v >= d.numbers[idx - 1]))
  const usePosition = !inputSorted

  // Bonus/special ball: model it when (nearly) every draw carries one
  const withSpecial = draws.filter((d) => d.special !== undefined && d.special >= 1)
  let specialKs = 0
  if (withSpecial.length >= draws.length * 0.9 && withSpecial.length >= MIN_DRAWS) {
    let maxS = 0
    for (const d of withSpecial) maxS = Math.max(maxS, d.special!)
    specialKs = settings.specialMax > 0 ? settings.specialMax : maxS
    if (specialKs > 99 || maxS > specialKs) specialKs = 0
    if (specialKs > 0 && specialKs < 2) specialKs = 0
  }

  // Era check: has the number pool visibly changed over the history (rule change)?
  let eraNotice: EngineResult['eraNotice'] = null
  if (draws.length >= 200) {
    const earlySlice = draws.slice(0, Math.floor(draws.length * 0.3))
    let earlyMax = 0
    for (const d of earlySlice) for (const n of d.sorted) earlyMax = Math.max(earlyMax, n)
    if (maxObserved >= earlyMax + 6) {
      let cutoffDate = ''
      let cutoffIndex = 0
      for (let i = 0; i < draws.length; i++) {
        if (draws[i].sorted.some((n) => n > earlyMax)) { cutoffDate = draws[i].date; cutoffIndex = i; break }
      }
      eraNotice = { earlyMax, currentMax: maxObserved, cutoffDate, affected: cutoffIndex }
    }
  }

  // ---- Walk-forward backtest (learns the ensemble weights, leak-free) ----
  const bt = runBacktest(draws, K, D, usePosition, specialKs)

  // ---- Full-history state for the live prediction ----
  const state = new HistoryState(K, D)
  for (const d of draws) state.push(d)

  const scheduleDows = detectSchedule(draws)
  const nextDate = settings.nextDate && /^\d{4}-\d{2}-\d{2}$/.test(settings.nextDate)
    ? settings.nextDate
    : inferNextDate(draws, scheduleDows)
  const nextDow = dowOf(nextDate)

  const activeWeights = bt.weights
  const ctx = { targetDow: nextDow, prev: draws[draws.length - 1] }
  const { predictions } = predictNext(state, ctx, activeWeights, bt.rankHitRate, bt.summary.evaluated, usePosition)
  const combos = buildCombos(state, predictions)

  const weightEntries = Object.entries(activeWeights).sort((a, b) => b[1] - a[1])
  const uniform = weightEntries.length > 0 ? 1 / weightEntries.length : 0
  const weightsLearned = weightEntries.length > 0 && weightEntries[0][1] > 1.5 * uniform
  const drivers: DriverEntry[] = weightsLearned
    ? weightEntries.slice(0, 5).filter(([, w]) => w > 0.005).map(([key, weight]) => ({
        key,
        label: SIGNAL_LABEL[key]?.label ?? key,
        description: SIGNAL_LABEL[key]?.description ?? '',
        weight,
      }))
    : []

  // Bonus-ball live prediction
  let special: SpecialResult | null = null
  if (specialKs > 0 && bt.specialWeights && bt.specialRankHitRate) {
    const sRaws = computeSpecialRawSignals(state, nextDow, specialKs)
    const sZs = sRaws.map((r) => zNormalize(r.raw, specialKs))
    const sEns = new Float64Array(specialKs + 1)
    sRaws.forEach((r, i) => {
      const w = bt.specialWeights![r.key] ?? 0
      if (w <= 0) return
      for (let v = 1; v <= specialKs; v++) sEns[v] += w * sZs[i][v]
    })
    const order: number[] = []
    for (let v = 1; v <= specialKs; v++) order.push(v)
    order.sort((a, b) => sEns[b] - sEns[a] || a - b)
    special = {
      K: specialKs,
      picks: order.slice(0, 4).map((v, idx) => ({
        number: v,
        probability: bt.specialRankHitRate![idx] ?? 1 / specialKs,
        count: state.sCounts[v],
        drawsSinceSeen: state.sDrawsSince(v),
      })),
    }
  }

  // Similar situations, annotated against the current top-10
  const top10Set = new Set(predictions.slice(0, 10).map((p) => p.number))
  const { matches } = similarityScores(state, ctx, 6)
  const similar: SimilarSituation[] = matches.map((m) => {
    const outcome = state.history[m.t].sorted
    return {
      index: m.t,
      date: state.history[m.t].date,
      dow: state.history[m.t].dow,
      similarity: m.sim,
      contextNumbers: state.history[m.t - 1].sorted,
      outcome,
      matchesWithPrediction: outcome.filter((n) => top10Set.has(n)),
    }
  })

  const { hot, cold } = hotCold(state)
  const { rising, falling } = trends(state)

  const frequency: { number: number; count: number }[] = []
  for (let i = 1; i <= K; i++) frequency.push({ number: i, count: state.counts[i] })

  const result: EngineResult = {
    ok: true,
    K,
    drawSize: D,
    drawCount: draws.length,
    firstDate: draws[0].date,
    lastDate: draws[draws.length - 1].date,
    scheduleDows,
    nextDate,
    nextDow,
    inputSorted,
    predictions,
    topPick: predictions.slice(0, D),
    top10: predictions.slice(0, 10),
    bestCombo: combos.best,
    altCombos: combos.alts,
    drivers,
    weightsLearned,
    special,
    eraNotice,
    hot,
    cold,
    overdue: overdueList(state),
    pairs: topPairs(state),
    followers: topFollowers(state),
    dowProfiles: dowProfiles(state, scheduleDows),
    rising,
    falling,
    streaks: currentStreaks(state),
    positions: positionProfiles(state),
    similar,
    frequency,
    windowFrequency: windowCounts(draws, K, settings.exploreWindow),
    backtest: bt.summary,
    computeMs: Math.round(performance.now() - started),
  }
  return result
}
