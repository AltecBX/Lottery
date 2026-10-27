import type { Draw } from './types.ts'
import { runBacktest, type LearnerState } from './backtest.ts'
import { RULE_SCHEDULE, rulesAt, verifyHistory, type RuleKey } from './rules.ts'
import { bonferroniZ } from './stats.ts'

/**
 * The historical replay: stand at a chosen date, predict the next drawing from
 * everything before it, record the prediction, reveal the result, score it,
 * learn from it, and move on — all the way to the latest drawing.
 *
 * Every step uses the rules that applied to that drawing, taken from the
 * published schedule rather than read back off the numbers: a 2014 Powerball
 * draw is predicted and scored as a 5/59 draw, never against the 69-ball pool
 * that arrived in 2015. What the replay leaves open is what a model should do
 * with what it learned when the pool changes, so that is the experiment:
 *
 *  - `reset`: start again at every main-number rule change. Old draws and
 *    learned weights are both dropped. This is what the app does.
 *  - `transfer`: number statistics start again (they describe the old pool),
 *    but how much each signal has been worth, and the combiner's coefficients,
 *    carry over — signals are normalised over whatever pool is in force, so
 *    their skill is pool-independent if it exists at all.
 *  - `pooled`: ignore the change and keep learning from every earlier draw
 *    that fits the new pool, as if it were the same machine.
 *
 * The first MIN_HISTORY draws of an era are scored at chance under reset and
 * transfer — there is no model of the new pool yet — so all three strategies
 * are judged on exactly the same drawings.
 */

export type EraStrategy = 'reset' | 'transfer' | 'pooled'

export const STRATEGY_LABEL: Record<EraStrategy, string> = {
  reset: 'Start again at each rule change',
  transfer: 'Keep what the signals learned',
  pooled: 'Ignore rule changes',
}

export interface ReplayEra {
  from: string
  to: string
  K: number
  /** Drawings scored in this era (on or after the start date) */
  scored: number
  /** Of those, drawings scored at chance because the model had too little of this pool to predict */
  warmup: number
  top10: number
  chance10: number
  z10: number
}

export interface ReplayResult {
  start: string
  strategy: EraStrategy
  /** Last drawing used only for training: the replay's starting knowledge */
  trainedThrough: string
  eras: ReplayEra[]
  n: number
  /** Mean top-10 hits per draw, and the mean chance for the pools in force */
  top10: number
  chance10: number
  excess: number
  z10: number
  lo10: number
  hi10: number
  /**
   * Every scored drawing: date, the pool it was scored in, top-10 hits, and
   * whether the model predicted it or it was scored at chance in a warm-up
   */
  steps: { date: string; K: number; hits10: number; chance10: number; live: boolean; predicted: number[] }[]
  /** Cumulative top-10 hits above chance, thinned for a chart, with the no-edge 95% band's half-width */
  curve: { date: string; excess: number; band: number }[]
}

interface Segment { from: string; to: string; K: number }

/** The main-number eras of a game: runs of schedule entries with one white-ball pool. */
export function mainEras(key: RuleKey): Segment[] {
  const list = RULE_SCHEDULE[key]
  const out: Segment[] = []
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    if (out.length && out[out.length - 1].K === r.K) continue
    if (out.length) out[out.length - 1].to = r.from
    out.push({ from: r.from, to: '9999-12-31', K: r.K })
  }
  return out
}

/**
 * Replay a game's whole verified record from `start`. Draws before `start`
 * are training only; every draw on or after it is predicted, scored against
 * its own era's pool, and then learned from.
 */
export function runReplay(allDraws: Draw[], key: RuleKey, start: string, strategy: EraStrategy, D = 5): ReplayResult {
  const check = verifyHistory(allDraws, key, D)
  const draws = allDraws.filter((d) => !check.rejected.has(d.date) && rulesAt(key, d.date))
  const eras = mainEras(key)
  const steps: ReplayResult['steps'] = []
  const eraOut: ReplayEra[] = []
  let learner: LearnerState | undefined

  for (const era of eras) {
    const inEra = draws.filter((d) => d.date >= era.from && d.date < era.to)
    if (!inEra.length) continue
    const scoredHere = inEra.filter((d) => d.date >= start)
    // An era wholly before the start still trains a transferring learner
    if (!scoredHere.length && strategy !== 'transfer') continue

    let history: Draw[] = inEra
    let offset = 0
    if (strategy === 'pooled') {
      // Every earlier draw the new pool could have produced, as if one machine
      const prior = draws.filter((d) => d.date < era.from && d.sorted.every((n) => n <= era.K))
      history = [...prior, ...inEra]
      offset = prior.length
    }
    const ens = new Map<number, number[]>()
    const bt = runBacktest(history, era.K, D, false, 0, {
      warm: strategy === 'transfer' ? learner : undefined,
      trace: (s) => {
        if (s.t < offset || s.date < start) return
        let h = 0
        const order: number[] = []
        for (let i = 1; i <= era.K; i++) order.push(i)
        order.sort((a, b) => s.ens[b] - s.ens[a] || a - b)
        const top = order.slice(0, 10)
        for (const a of s.actual) if (top.includes(a)) h++
        ens.set(s.t, top)
        steps.push({ date: s.date, K: era.K, hits10: h, chance10: (10 * D) / era.K, live: true, predicted: top })
      },
    })
    learner = bt.learner

    // Draws the model could not yet predict: scored at exactly chance
    let warmup = 0
    for (let t = offset; t < history.length; t++) {
      const d = history[t]
      if (d.date < start || ens.has(t)) continue
      warmup++
      steps.push({ date: d.date, K: era.K, hits10: (10 * D) / era.K, chance10: (10 * D) / era.K, live: false, predicted: [] })
    }
    if (!scoredHere.length) continue
    const mine = steps.filter((s) => s.date >= era.from && s.date < era.to && s.date >= start)
    const n = mine.length
    const c10 = (10 * D) / era.K
    const p = D / era.K
    const v = 10 * p * (1 - p) * (era.K - 10) / (era.K - 1)
    const live = n - warmup
    const sum = mine.reduce((a, s) => a + s.hits10, 0)
    eraOut.push({
      from: era.from, to: inEra[inEra.length - 1].date, K: era.K, scored: n, warmup,
      top10: n ? sum / n : 0, chance10: c10,
      z10: live > 0 ? (sum - n * c10) / Math.sqrt(v * live) : 0,
    })
  }

  steps.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  let sum = 0, chance = 0, variance = 0
  for (const s of steps) {
    sum += s.hits10
    chance += s.chance10
    // Warm-up draws are scored at their expectation and add no variance
    if (s.live) {
      const p = D / s.K
      variance += 10 * p * (1 - p) * (s.K - 10) / (s.K - 1)
    }
  }
  const n = steps.length
  const sd = Math.sqrt(variance)
  const curve: ReplayResult['curve'] = []
  const every = Math.max(1, Math.round(n / 150))
  let cum = 0
  let cumVar = 0
  steps.forEach((s, i) => {
    cum += s.hits10 - s.chance10
    if (s.live) {
      const p = D / s.K
      cumVar += 10 * p * (1 - p) * (s.K - 10) / (s.K - 1)
    }
    if (i % every === 0 || i === n - 1) curve.push({ date: s.date, excess: Math.round(cum * 100) / 100, band: Math.round(196 * Math.sqrt(cumVar)) / 100 })
  })
  const before = draws.filter((d) => d.date < start)
  return {
    start, strategy,
    trainedThrough: before.length ? before[before.length - 1].date : '',
    eras: eraOut, n,
    top10: n ? sum / n : 0,
    chance10: n ? chance / n : 0,
    excess: sum - chance,
    z10: sd > 0 ? (sum - chance) / sd : 0,
    lo10: n ? (sum - 1.96 * sd) / n : 0,
    hi10: n ? (sum + 1.96 * sd) / n : 0,
    steps, curve,
  }
}

export interface StrategyComparison {
  start: string
  results: ReplayResult[]
  /** Paired top-10 differences on the same drawings, a − b */
  pairs: { a: EraStrategy; b: EraStrategy; n: number; diff: number; z: number }[]
  /** Bonferroni bar over the pairs */
  zNeeded: number
  verdict: string
}

/**
 * All three strategies from one start date, judged against each other on the
 * same drawings. A difference counts only past the bar three comparisons
 * need; short of it the app keeps `reset`, the one strategy that never trains
 * on a pool the game no longer uses.
 */
export function compareStrategies(allDraws: Draw[], key: RuleKey, start: string, D = 5): StrategyComparison {
  const strategies: EraStrategy[] = ['reset', 'transfer', 'pooled']
  const results = strategies.map((s) => runReplay(allDraws, key, start, s, D))
  const pairs: StrategyComparison['pairs'] = []
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const byDate = new Map(results[j].steps.map((s) => [s.date, s.hits10]))
      let n = 0, sd = 0, sdd = 0
      for (const s of results[i].steps) {
        const other = byDate.get(s.date)
        if (other === undefined) continue
        const d = s.hits10 - other
        n++; sd += d; sdd += d * d
      }
      const mean = n ? sd / n : 0
      const v = n ? Math.max(0, sdd / n - mean * mean) : 0
      pairs.push({ a: strategies[i], b: strategies[j], n, diff: mean, z: v > 0 ? mean / Math.sqrt(v / n) : 0 })
    }
  }
  const zNeeded = bonferroniZ(pairs.length, 0.05 / 2)
  const real = pairs.filter((p) => Math.abs(p.z) >= zNeeded)
  const verdict = real.length
    ? real.map((p) => `${STRATEGY_LABEL[p.z > 0 ? p.a : p.b]} beat ${STRATEGY_LABEL[p.z > 0 ? p.b : p.a].toLowerCase()} by ${Math.abs(p.diff).toFixed(3)} hits a draw (${Math.abs(p.z).toFixed(1)}σ).`).join(' ')
    : `No strategy did measurably better than another: the largest difference was ${Math.max(...pairs.map((p) => Math.abs(p.z))).toFixed(1)}σ, inside the ${zNeeded.toFixed(1)}σ three comparisons need. The app keeps starting again at each rule change — the only strategy that never trains on a pool the game no longer uses.`
  return { start, results, pairs, zNeeded, verdict }
}
