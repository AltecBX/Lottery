import type { Draw } from './types.ts'
import { isotonicDecreasing, MIN_HISTORY, runBacktest, type StepTrace } from './backtest.ts'
import { bonferroniZ, normalQuantile } from './stats.ts'
import { METHOD_FROZEN_ON } from './constraintlab.ts'

/**
 * Controlled comparisons of the prediction model against a short list of
 * alternatives, each one there to answer a single question about the existing
 * design, on draws none of them was tuned on.
 *
 * The protocol is fixed before any number is looked at:
 *  - every model predicts each draw from earlier draws only (walk-forward);
 *  - the era's scored draws are split in time: the first half is exploration
 *    (reported, never used to decide), the next quarter is validation (where
 *    an alternative must beat the existing model by the bar its number of
 *    rivals requires), the last quarter is the test (looked at once, only for
 *    alternatives that passed validation);
 *  - draws after METHOD_FROZEN_ON are the prospective test, which no design
 *    decision anywhere in the app has seen;
 *  - the primary measure is top-10 hits, the figure the app leads with.
 *    Everything else is reported, not used to decide.
 *
 * An alternative replaces the existing model only by passing both gates. If
 * none does, the existing model stays — and if it cannot beat chance on the
 * test either, that is the finding, and it is reported as such.
 */

export type SplitKey = 'explore' | 'validate' | 'test' | 'prospective'

export const SPLIT_LABEL: Record<SplitKey, string> = {
  explore: 'Exploration',
  validate: 'Validation',
  test: 'Final test',
  prospective: 'Since frozen',
}

export interface SplitRange { key: SplitKey; from: string; to: string; n: number }

export interface ScoreLine {
  n: number
  /** Mean hits among the model's top 5 and top 10 */
  top5: number
  top10: number
  chance5: number
  chance10: number
  /** Top-10 hits above chance, in standard errors (exact hypergeometric variance) */
  z10: number
  /** 95% interval for mean top-10 hits */
  lo10: number
  hi10: number
  /** How high the drawn numbers sat in the whole ranking, against chance, in standard errors */
  rankZ: number
  /** Paired top-10 difference from the existing model, in standard errors (0 for the model itself) */
  pairedZ: number
  /** Paired mean difference in top-10 hits per draw */
  pairedDiff: number
}

export interface ModelResult {
  key: string
  label: string
  question: string
  splits: Partial<Record<SplitKey, ScoreLine>>
  all: ScoreLine
  verdict: 'baseline' | 'retained' | 'failed-validation' | 'failed-test'
}

export interface ModelComparison {
  K: number
  D: number
  from: string
  to: string
  splits: SplitRange[]
  models: ModelResult[]
  /** The bar an alternative must clear on validation: Bonferroni over the alternatives */
  zNeeded: number
  decision: { kept: string; text: string }
  /** The existing model against chance, judged once on the final test */
  chance: { z: number; verdict: 'beats-chance' | 'no-evidence'; text: string }
  /**
   * The existing model's own probability claims, checked on draws its
   * calibration never saw: what it said top-10 would hit, and what did.
   */
  calibration: { n: number; predicted10: number; observed10: number; chance10: number; z: number }
  /** The combiner's average log-score above uniform, out of sample, in nats per draw */
  mlLogScore: { validate: number; test: number }
  /** How much the 19 signals say the same thing */
  redundancy: { signals: number; effective: number; pairs: { a: string; b: string; r: number }[] }
  /** Bonus-ball model against chance, per split */
  bonus: { K: number; splits: Partial<Record<SplitKey, { n: number; top1: number; top3: number; chance1: number; chance3: number; z3: number }>> } | null
  /**
   * Cumulative top-10 hits above chance, per model, thinned for a chart, with
   * the half-width of the band a model with no edge stays inside 95% of the time
   */
  curve: { date: string; values: number[]; band: number }[]
}

interface ModelSpec {
  key: string
  label: string
  question: string
  score: (s: StepTrace, ctx: { frozen: Record<string, number> | null; slowProbs: Float64Array | null }) => Float64Array | null
}

const sumZ = (s: StepTrace, pick: (k: string) => number): Float64Array => {
  const out = new Float64Array(s.K + 1)
  for (let j = 0; j < s.keys.length; j++) {
    const w = pick(s.keys[j])
    if (!w) continue
    const z = s.zs[j]
    for (let i = 1; i <= s.K; i++) out[i] += w * z[i]
  }
  return out
}
const signal = (key: string) => (s: StepTrace) => {
  const j = s.keys.indexOf(key)
  return j >= 0 ? s.zs[j] : null
}

/**
 * The existing model and its rivals. Kept short on purpose: every extra rival
 * raises the bar for all of them, and each of these answers a question the
 * design rests on.
 */
export const MODELS: ModelSpec[] = [
  {
    key: 'ensemble', label: 'Existing model',
    question: 'The ensemble the app uses: signals weighted by their own track record, re-learned every draw.',
    score: (s) => s.ens,
  },
  {
    key: 'equal', label: 'Equal weights',
    question: 'Does learning the weights help at all, or would averaging every signal do as well?',
    score: (s) => sumZ(s, () => 1),
  },
  {
    key: 'frozen', label: 'Weights frozen',
    question: 'Do the per-draw weight updates help, or would weights learned once on the exploration draws do as well?',
    score: (s, c) => (c.frozen ? sumZ(s, (k) => c.frozen![k] ?? 0) : s.ens),
  },
  {
    key: 'ml', label: 'Learned combiner',
    question: 'Does the online regression beat the simpler ensemble it feeds?',
    score: (s) => s.mlProbs,
  },
  {
    key: 'mlSlow', label: 'Combiner, slower and more regularised',
    question: 'Was the combiner tuned too hot? Same model at a quarter of the learning rate and ten times the penalty.',
    score: (_s, c) => c.slowProbs,
  },
  {
    key: 'freqAll', label: 'Plain frequency',
    question: 'Does anything beat counting how often each number has come up?',
    score: signal('freqAll'),
  },
  {
    key: 'recency', label: 'Recency (20-draw half-life)',
    question: 'Should recent draws count more than old ones?',
    score: signal('recency'),
  },
  {
    key: 'window50', label: 'Last 50 draws only',
    question: 'Is a short training window better than the whole era?',
    score: signal('window50'),
  },
]

/** Rank of `a` in the descending order of `score` (ties to the lower number), 1-based. */
function rankOf(score: Float64Array, K: number, a: number): number {
  const v = score[a]
  let r = 1
  for (let i = 1; i <= K; i++) {
    const u = score[i]
    if (u > v || (u === v && i < a)) r++
  }
  return r
}

/** Chronological split of the scored steps, with the prospective draws apart. */
export function splitSteps(dates: string[]): { key: SplitKey; from: number; to: number }[] {
  let hist = dates.length
  while (hist > 0 && dates[hist - 1] > METHOD_FROZEN_ON) hist--
  const a = Math.floor(hist * 0.5)
  const b = Math.floor(hist * 0.75)
  return [
    { key: 'explore' as const, from: 0, to: a },
    { key: 'validate' as const, from: a, to: b },
    { key: 'test' as const, from: b, to: hist },
    { key: 'prospective' as const, from: hist, to: dates.length },
  ].filter((s) => s.to > s.from)
}

function scoreLine(
  K: number, D: number, h5: Int8Array, h10: Int8Array, rank: Float64Array, base10: Int8Array, from: number, to: number,
): ScoreLine {
  const n = to - from
  const p = D / K
  const chance5 = 5 * p
  const chance10 = 10 * p
  if (n <= 0) return { n: 0, top5: 0, top10: 0, chance5, chance10, z10: 0, lo10: 0, hi10: 0, rankZ: 0, pairedZ: 0, pairedDiff: 0 }
  let s5 = 0, s10 = 0, sr = 0, sd = 0, sdd = 0
  for (let t = from; t < to; t++) {
    s5 += h5[t]; s10 += h10[t]; sr += rank[t]
    const d = h10[t] - base10[t]
    sd += d; sdd += d * d
  }
  // Hits in a fixed top-m against a uniformly drawn D-subset: hypergeometric
  const var10 = 10 * p * (1 - p) * (K - 10) / (K - 1)
  const se10 = Math.sqrt(var10 / n)
  const top10 = s10 / n
  // Mean rank of the D drawn numbers against a uniform draw without replacement
  const meanRank = sr / n
  const varRank = ((K * K - 1) / 12) * ((K - D) / (D * (K - 1)))
  const rankZ = ((K + 1) / 2 - meanRank) / Math.sqrt(varRank / n)
  const md = sd / n
  const vd = Math.max(0, sdd / n - md * md)
  const pairedZ = vd > 0 ? md / Math.sqrt(vd / n) : 0
  return {
    n, top5: s5 / n, top10, chance5, chance10,
    z10: (top10 - chance10) / se10,
    lo10: top10 - 1.96 * se10, hi10: top10 + 1.96 * se10,
    rankZ, pairedZ, pairedDiff: md,
  }
}

/**
 * Run the comparison on one era's draws. `draws` must all be under one set of
 * main-number rules; the caller (the engine, or the replay) decides which.
 */
export function compareModels(draws: Draw[], K: number, D: number, specialKs = 0): ModelComparison | null {
  if (draws.length < MIN_HISTORY + 80) return null
  const N = draws.length
  const nModels = MODELS.length
  const h5 = MODELS.map(() => new Int8Array(N))
  const h10 = MODELS.map(() => new Int8Array(N))
  const rank = MODELS.map(() => new Float64Array(N))
  const dates: string[] = []
  const mlLL = new Float64Array(N)
  // Prequential calibration of the existing model: rank hit-rates fitted only
  // on steps already scored, then asked about the next one.
  const hitsAtRank = new Float64Array(K + 1)
  const predicted10 = new Float64Array(N)
  // Signal redundancy: mean correlation across numbers, per pair
  let corr: Float64Array | null = null
  let sigKeys: string[] = []
  let corrSteps = 0

  // The slower combiner needs its own walk-forward; only its probabilities are used.
  const slow: Float64Array[] = []
  runBacktest(draws, K, D, false, 0, {
    ml: { eta: 0.005, l2: 1e-2 },
    trace: (s) => { slow.push(Float64Array.from(s.mlProbs)) },
  })

  // Dates first, so the split (and the frozen-weight point) is known up front.
  const stepDates = draws.slice(MIN_HISTORY).map((d) => d.date)
  const splits = splitSteps(stepDates)
  const freezeAt = splits.find((s) => s.key === 'validate')?.from ?? Infinity
  let frozen: Record<string, number> | null = null

  let step = 0
  const bt = runBacktest(draws, K, D, false, specialKs, {
    trace: (s) => {
      if (step === freezeAt) frozen = { ...s.weights }
      dates.push(s.date)
      const ctx = { frozen: step >= freezeAt ? frozen : null, slowProbs: slow[step] ?? null }
      for (let m = 0; m < nModels; m++) {
        const sc = MODELS[m].score(s, ctx) ?? s.ens
        let a5 = 0, a10 = 0, rs = 0
        for (const a of s.actual) {
          const r = rankOf(sc, K, a)
          rs += r
          if (r <= 5) a5++
          if (r <= 10) a10++
        }
        h5[m][step] = a5; h10[m][step] = a10; rank[m][step] = rs / s.actual.length
      }
      for (const a of s.actual) mlLL[step] += Math.log(Math.max(1e-300, s.mlProbs[a]) * K)

      // Calibration as the app would have stated it before this draw
      const M = 30
      const rates: number[] = []
      for (let r = 1; r <= K; r++) rates.push((hitsAtRank[r] + M * (D / K)) / (step + M))
      const cal = isotonicDecreasing(rates, rates.map(() => 1))
      let p10 = 0
      for (let r = 0; r < Math.min(10, K); r++) p10 += cal[r]
      predicted10[step] = p10
      for (const a of s.actual) hitsAtRank[rankOf(s.ens, K, a)]++

      if (!corr) { sigKeys = s.keys.slice(); corr = new Float64Array(sigKeys.length * sigKeys.length) }
      if (step % 3 === 0) {
        const S = sigKeys.length
        for (let x = 0; x < S; x++) {
          const zx = s.zs[x]
          for (let y = x; y < S; y++) {
            const zy = s.zs[y]
            let c = 0
            for (let i = 1; i <= K; i++) c += zx[i] * zy[i]
            corr[x * S + y] += c / K
          }
        }
        corrSteps++
      }
      step++
    },
  })

  const baseIdx = 0
  const zNeeded = bonferroniZ(nModels - 1)
  const splitRanges: SplitRange[] = splits.map((s) => ({ key: s.key, from: dates[s.from], to: dates[s.to - 1], n: s.to - s.from }))
  const lineFor = (m: number, from: number, to: number) => scoreLine(K, D, h5[m], h10[m], rank[m], h10[baseIdx], from, to)

  const validate = splits.find((s) => s.key === 'validate')
  const test = splits.find((s) => s.key === 'test')
  const passedValidation = MODELS.map((_, m) => m !== baseIdx && !!validate && lineFor(m, validate.from, validate.to).pairedZ >= zNeeded)
  const nPassed = passedValidation.filter(Boolean).length
  const testBar = nPassed > 0 ? bonferroniZ(nPassed) : Infinity

  const models: ModelResult[] = MODELS.map((spec, m) => {
    const lines: Partial<Record<SplitKey, ScoreLine>> = {}
    for (const s of splits) lines[s.key] = lineFor(m, s.from, s.to)
    let verdict: ModelResult['verdict'] = 'baseline'
    if (m !== baseIdx) {
      if (!passedValidation[m]) verdict = 'failed-validation'
      else verdict = test && lines.test!.pairedZ >= testBar ? 'retained' : 'failed-test'
    }
    return { key: spec.key, label: spec.label, question: spec.question, splits: lines, all: lineFor(m, 0, step), verdict }
  })

  const retained = models.filter((m) => m.verdict === 'retained').sort((a, b) => (b.splits.test?.pairedZ ?? 0) - (a.splits.test?.pairedZ ?? 0))
  const decision = retained.length
    ? { kept: retained[0].key, text: `${retained[0].label} beat the existing model on validation by ${models.find((m) => m.key === retained[0].key)!.splits.validate!.pairedZ.toFixed(1)}σ (the bar for ${nModels - 1} rivals is ${zNeeded.toFixed(1)}σ) and held up on the final test.` }
    : {
        kept: 'ensemble',
        text: nPassed
          ? `${nPassed === 1 ? 'One alternative' : `${nPassed} alternatives`} cleared validation but not the final test, so the existing model stays.`
          : `No alternative beat the existing model on validation by the ${zNeeded.toFixed(1)}σ that ${nModels - 1} rivals require, so it stays — none was carried to the final test.`,
      }

  const base = models[baseIdx]
  const testZ = base.splits.test?.z10 ?? 0
  const chanceBar = normalQuantile(0.95)
  const chance = {
    z: testZ,
    verdict: (testZ >= chanceBar ? 'beats-chance' : 'no-evidence') as 'beats-chance' | 'no-evidence',
    text: testZ >= chanceBar
      ? `On the ${base.splits.test!.n} final-test draws the existing model's top 10 caught ${base.splits.test!.top10.toFixed(3)} numbers a draw against ${base.splits.test!.chance10.toFixed(3)} by chance — ${testZ.toFixed(1)}σ, past the ${chanceBar.toFixed(2)}σ a single pre-set test needs.`
      : `On the ${base.splits.test?.n ?? 0} final-test draws the existing model's top 10 caught ${(base.splits.test?.top10 ?? 0).toFixed(3)} numbers a draw against ${(base.splits.test?.chance10 ?? 0).toFixed(3)} by chance (${testZ >= 0 ? '+' : ''}${testZ.toFixed(1)}σ). That is not evidence of beating chance — it is what a fair draw produces.`,
  }

  // Calibration on validation + test only: the calibration had seen none of it
  const held = validate ? validate.from : 0
  const heldTo = test ? test.to : step
  let pSum = 0, oSum = 0
  for (let t = held; t < heldTo; t++) { pSum += predicted10[t]; oSum += h10[baseIdx][t] }
  const nCal = heldTo - held
  const p = D / K
  const var10 = 10 * p * (1 - p) * (K - 10) / (K - 1)
  const calibration = {
    n: nCal,
    predicted10: nCal ? pSum / nCal : 0,
    observed10: nCal ? oSum / nCal : 0,
    chance10: 10 * p,
    z: nCal ? (oSum - pSum) / Math.sqrt(var10 * nCal) : 0,
  }

  const meanLL = (from: number, to: number) => {
    let s = 0
    for (let t = from; t < to; t++) s += mlLL[t]
    return to > from ? s / (to - from) : 0
  }
  const mlLogScore = { validate: validate ? meanLL(validate.from, validate.to) : 0, test: test ? meanLL(test.from, test.to) : 0 }

  // Effective number of independent signals: n² / Σ r², the participation ratio
  const S = sigKeys.length
  const R = new Float64Array(S * S)
  let sumSq = 0
  const pairs: { a: string; b: string; r: number }[] = []
  if (corr && corrSteps) {
    for (let x = 0; x < S; x++) {
      for (let y = x; y < S; y++) {
        const r = (corr as Float64Array)[x * S + y] / corrSteps
        R[x * S + y] = R[y * S + x] = r
        sumSq += x === y ? r * r : 2 * r * r
        if (x !== y) pairs.push({ a: sigKeys[x], b: sigKeys[y], r })
      }
    }
  }
  pairs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
  const redundancy = { signals: S, effective: sumSq > 0 ? (S * S) / sumSq : S, pairs: pairs.slice(0, 6) }

  // Bonus ball against chance, per split, from the backtest's own self-test
  let bonus: ModelComparison['bonus'] = null
  if (specialKs > 0 && bt.summary.special) {
    const pts = bt.summary.points
    const out: NonNullable<ModelComparison['bonus']>['splits'] = {}
    for (const s of splits) {
      let n = 0, t1 = 0, t3 = 0
      for (let t = s.from; t < s.to; t++) {
        const pt = pts[t]
        if (pt.specialActual === undefined || !pt.specialTop) continue
        n++
        if (pt.specialTop[0] === pt.specialActual) t1++
        if (pt.specialTop.includes(pt.specialActual)) t3++
      }
      const c3 = Math.min(3, specialKs) / specialKs
      out[s.key] = { n, top1: n ? t1 / n : 0, top3: n ? t3 / n : 0, chance1: 1 / specialKs, chance3: c3, z3: n ? (t3 - n * c3) / Math.sqrt(n * c3 * (1 - c3)) : 0 }
    }
    bonus = { K: specialKs, splits: out }
  }

  // Cumulative excess top-10 hits, thinned to about 150 points (var10 as above)
  const curve: ModelComparison['curve'] = []
  const every = Math.max(1, Math.round(step / 150))
  const cum = new Float64Array(nModels)
  for (let t = 0; t < step; t++) {
    for (let m = 0; m < nModels; m++) cum[m] += h10[m][t] - 10 * p
    if (t % every === 0 || t === step - 1) {
      curve.push({ date: dates[t], values: Array.from(cum, (v) => Math.round(v * 100) / 100), band: Math.round(196 * Math.sqrt(var10 * (t + 1))) / 100 })
    }
  }

  return {
    K, D, from: dates[0], to: dates[step - 1], splits: splitRanges, models, zNeeded, decision, chance,
    calibration, mlLogScore, redundancy, bonus, curve,
  }
}
