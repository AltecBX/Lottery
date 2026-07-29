import type { Draw, EngineResult, Settings, SimilarSituation } from './types.ts'
import { HistoryState } from './state.ts'
import { runBacktest, MIN_HISTORY } from './backtest.ts'
import { predictNext } from './predict.ts'
import { buildCombos } from './combos.ts'
import { similarityScores } from './signals.ts'
import {
  currentStreaks, dowProfiles, hotCold, overdueList, positionProfiles,
  topFollowers, topPairs, trends, windowCounts,
} from './analytics.ts'
import { addDays, dowOf } from './dates.ts'

export const MAX_POOL = 150
export const MIN_DRAWS = 12

function emptyResult(message: string): EngineResult {
  return {
    ok: false, message, K: 0, drawCount: 0, firstDate: '', lastDate: '',
    scheduleDows: [], nextDate: '', nextDow: 0, inputSorted: true,
    predictions: [], top5: [], top10: [], bestCombo: null, altCombos: [],
    hot: [], cold: [], overdue: [], pairs: [], followers: [], dowProfiles: [],
    rising: [], falling: [], streaks: [], positions: [], similar: [],
    frequency: [], windowFrequency: [],
    backtest: {
      evaluated: 0, minHistory: MIN_HISTORY, chance5: 0, chance10: 0,
      ensemble5: 0, ensemble10: 0, baseline5: 0, baseline10: 0, ens10AtLeast2: 0,
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

  let maxObserved = 0
  for (const d of draws) for (const n of d.sorted) maxObserved = Math.max(maxObserved, n)
  const K = settings.poolMax > 0 ? settings.poolMax : maxObserved
  if (maxObserved > K) {
    return emptyResult(`Your data contains ${maxObserved}, above the configured pool maximum of ${K}. Raise "Highest number" in Settings.`)
  }
  if (K > MAX_POOL) {
    return emptyResult(`Pool sizes above ${MAX_POOL} are not supported (largest number seen: ${maxObserved}).`)
  }
  if (K < 10) {
    return emptyResult('The number pool is too small to analyze (highest number must be at least 10).')
  }

  const inputSorted = draws.every((d) => d.numbers.every((v, idx) => idx === 0 || v >= d.numbers[idx - 1]))
  const usePosition = !inputSorted

  // ---- Walk-forward backtest (learns the ensemble weights, leak-free) ----
  const bt = runBacktest(draws, K, usePosition)

  // ---- Full-history state for the live prediction ----
  const state = new HistoryState(K)
  for (const d of draws) state.push(d)

  const scheduleDows = detectSchedule(draws)
  const nextDate = settings.nextDate && /^\d{4}-\d{2}-\d{2}$/.test(settings.nextDate)
    ? settings.nextDate
    : inferNextDate(draws, scheduleDows)
  const nextDow = dowOf(nextDate)

  const ctx = { targetDow: nextDow, prev: draws[draws.length - 1] }
  const { predictions } = predictNext(state, ctx, bt.weights, bt.rankHitRate, bt.summary.evaluated, usePosition)
  const combos = buildCombos(state, predictions)

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
    drawCount: draws.length,
    firstDate: draws[0].date,
    lastDate: draws[draws.length - 1].date,
    scheduleDows,
    nextDate,
    nextDow,
    inputSorted,
    predictions,
    top5: predictions.slice(0, 5),
    top10: predictions.slice(0, 10),
    bestCombo: combos.best,
    altCombos: combos.alts,
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
