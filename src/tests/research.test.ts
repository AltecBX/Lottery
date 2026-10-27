import { describe, expect, it } from 'vitest'
import { compareModels, splitSteps } from '../engine/research.ts'
import { compareStrategies, mainEras, runReplay } from '../engine/replay.ts'
import { jointTheory, studyTopPositions, topShare } from '../engine/tailstudy.ts'
import { MIN_HISTORY } from '../engine/backtest.ts'
import { METHOD_FROZEN_ON } from '../engine/constraintlab.ts'
import { rulesAt, type RuleKey } from '../engine/rules.ts'
import { generateSampleDraws } from '../engine/sample.ts'
import { buildCombos } from '../engine/combos.ts'
import { HistoryState } from '../engine/state.ts'
import { runEngine } from '../engine/engine.ts'
import { choose } from '../engine/odds.ts'
import { addDays, dowOf } from '../engine/dates.ts'
import { DEFAULT_SETTINGS, type Draw } from '../engine/types.ts'

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(r: () => number, K: number, D = 5): number[] {
  const bag = Array.from({ length: K }, (_, i) => i + 1)
  for (let j = 0; j < D; j++) { const k = j + Math.floor(r() * (K - j)); [bag[j], bag[k]] = [bag[k], bag[j]] }
  return bag.slice(0, D).sort((a, b) => a - b)
}

/** Fair draws every third day from `start`, each from a pool of K. */
function fairDraws(n: number, seed: number, K = 69, start = '2000-01-01'): Draw[] {
  const r = rng(seed)
  const out: Draw[] = []
  let date = start
  for (let i = 0; i < n; i++) {
    const sorted = pick(r, K)
    out.push({ date, dow: dowOf(date), numbers: sorted, sorted })
    date = addDays(date, 3)
  }
  return out
}

/** A fair history on a game's real schedule, each draw from the pool in force that day. */
function scheduleDraws(key: RuleKey, from: string, to: string, seed: number): Draw[] {
  const r = rng(seed)
  const out: Draw[] = []
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const rules = rulesAt(key, day)
    if (!rules || !rules.drawDays.includes(dowOf(day))) continue
    const sorted = pick(r, rules.K)
    out.push({ date: day, dow: dowOf(day), numbers: sorted, sorted, special: 1 + Math.floor(r() * rules.specialK) })
  }
  return out
}

/** Same dates, every draw from index `from` on replaced by a fresh fair one. */
function replaceFrom(draws: Draw[], from: number, seed: number, K = 69): Draw[] {
  const r = rng(seed)
  return draws.map((d, i) => {
    if (i < from) return d
    const sorted = pick(r, K)
    return { ...d, numbers: sorted, sorted }
  })
}

describe('comparing models on draws none of them was tuned on', () => {
  const fair = fairDraws(900, 314)
  const cmp = compareModels(fair, 69, 5)!

  it('splits the record in time, with the frozen-method draws apart', () => {
    const dates = Array.from({ length: 100 }, (_, i) => addDays('2026-08-01', i))
    const s = splitSteps(dates)
    expect(s.map((x) => x.key)).toEqual(['explore', 'validate', 'test', 'prospective'])
    for (let i = 1; i < s.length; i++) expect(s[i].from).toBe(s[i - 1].to)
    expect(dates[s[3].from] > METHOD_FROZEN_ON).toBe(true)
    expect(dates[s[2].to - 1] <= METHOD_FROZEN_ON).toBe(true)
  })

  it('keeps the existing model and finds no edge on fair draws', () => {
    expect(cmp.decision.kept).toBe('ensemble')
    expect(cmp.models.filter((m) => m.verdict === 'retained')).toEqual([])
    expect(cmp.chance.verdict).toBe('no-evidence')
    // Seven rivals at a 5% family-wise error: the bar is well above 2σ
    expect(cmp.zNeeded).toBeGreaterThan(2.3)
  })

  it('finds the edge in data that has one', () => {
    const sample = generateSampleDraws()
    const K = Math.max(...sample.flatMap((d) => d.sorted))
    const s = compareModels(sample, K, 5)!
    expect(s.chance.verdict).toBe('beats-chance')
    expect(s.models[0].splits.test!.z10).toBeGreaterThan(3)
  })

  it('cannot let the final test shape the validation verdicts', () => {
    // Replace every draw from the start of the final test on. Predictions are
    // made from earlier draws only, so nothing scored before then may move —
    // including which alternatives were carried to the test at all.
    const testFrom = MIN_HISTORY + splitSteps(fair.slice(MIN_HISTORY).map((d) => d.date)).find((s) => s.key === 'test')!.from
    const altered = compareModels(replaceFrom(fair, testFrom, 2718), 69, 5)!
    for (let m = 0; m < cmp.models.length; m++) {
      expect(altered.models[m].splits.explore).toEqual(cmp.models[m].splits.explore)
      expect(altered.models[m].splits.validate).toEqual(cmp.models[m].splits.validate)
      expect(altered.models[m].verdict === 'failed-validation').toBe(cmp.models[m].verdict === 'failed-validation')
    }
    // The probe has teeth: the test split itself did change
    expect(altered.models[0].splits.test).not.toEqual(cmp.models[0].splits.test)
  })

  it('measures how much the signals overlap', () => {
    expect(cmp.redundancy.signals).toBe(20)
    expect(cmp.redundancy.effective).toBeGreaterThan(1)
    expect(cmp.redundancy.effective).toBeLessThan(cmp.redundancy.signals)
  })
})

describe('the historical replay', () => {
  // Powerball's real schedule across the 2015 change: 5/59 then 5/69
  const history = scheduleDraws('powerball', '2012-01-01', '2018-12-31', 77)

  it('scores every drawing against the pool in force that day, and none before the start', () => {
    for (const strategy of ['reset', 'transfer', 'pooled'] as const) {
      const r = runReplay(history, 'powerball', '2014-12-31', strategy)
      expect(r.n).toBe(history.filter((d) => d.date >= '2014-12-31').length)
      for (const s of r.steps) {
        expect(s.date >= '2014-12-31').toBe(true)
        expect(s.K).toBe(rulesAt('powerball', s.date)!.K)
        for (const n of s.predicted) expect(n).toBeLessThanOrEqual(s.K)
      }
      // A 2014 draw is a 5/59 draw: never predicted or scored against 69 balls
      expect(r.steps.filter((s) => s.date < '2015-10-04').every((s) => s.K === 59)).toBe(true)
      expect(r.trainedThrough < '2014-12-31').toBe(true)
    }
  })

  it('scores the new pool at chance until it has a model of it', () => {
    const r = runReplay(history, 'powerball', '2014-12-31', 'reset')
    const era69 = r.eras.find((e) => e.K === 69)!
    expect(era69.warmup).toBe(MIN_HISTORY)
    const pooled = runReplay(history, 'powerball', '2014-12-31', 'pooled')
    expect(pooled.eras.find((e) => e.K === 69)!.warmup).toBe(0)
  })

  it('never lets a later drawing change an earlier verdict, under any strategy', () => {
    const cut = history.findIndex((d) => d.date >= '2016-06-01')
    const r = rng(9)
    const altered = history.map((d, i) => {
      if (i < cut) return d
      const sorted = pick(r, rulesAt('powerball', d.date)!.K)
      return { ...d, numbers: sorted, sorted }
    })
    for (const strategy of ['reset', 'transfer', 'pooled'] as const) {
      const full = runReplay(history, 'powerball', '2014-12-31', strategy).steps
      const fullAltered = runReplay(altered, 'powerball', '2014-12-31', strategy).steps
      const a = full.filter((s) => s.date < '2016-06-01')
      const b = fullAltered.filter((s) => s.date < '2016-06-01')
      expect(b).toEqual(a)
      // and the probe has teeth: later verdicts did move
      expect(fullAltered.filter((s) => s.date >= '2016-06-01')).not.toEqual(full.filter((s) => s.date >= '2016-06-01'))
    }
  })

  it('finds no strategy better than another on fair draws', () => {
    const c = compareStrategies(history, 'powerball', '2014-12-31')
    expect(c.pairs).toHaveLength(3)
    for (const p of c.pairs) expect(Math.abs(p.z)).toBeLessThan(c.zNeeded)
    expect(c.verdict).toMatch(/No strategy did measurably better/)
  })

  it('reads the eras off the schedule', () => {
    expect(mainEras('powerball').map((e) => e.K)).toEqual([45, 49, 53, 55, 59, 69])
    expect(mainEras('megamillions').map((e) => e.K)).toEqual([52, 56, 75, 70])
  })
})

describe('the 4th and 5th numbers', () => {
  it('prices every restriction exactly', () => {
    // Brute force on a small pool: every 5-set of 1..20
    const K = 20, D = 5
    const T = jointTheory(K, D)
    let total = 0
    for (let a = 1; a <= K; a++) for (let b = a + 1; b <= K; b++) total += T[a * (K + 1) + b]
    expect(total).toBeCloseTo(1, 12)
    let inBand = 0, cell = 0, all = 0
    const walk = (start: number, set: number[]) => {
      if (set.length === D) {
        all++
        if (set[D - 1] >= 12 && set[D - 1] <= 17) inBand++
        if (set[D - 2] === 9 && set[D - 1] === 15) cell++
        return
      }
      for (let v = start; v <= K; v++) walk(v + 1, [...set, v])
    }
    walk(1, [])
    expect(all).toBe(choose(K, D))
    expect(topShare(K, D, 12, 17)).toBeCloseTo(inBand / all, 12)
    expect(T[9 * (K + 1) + 15]).toBeCloseTo(cell / all, 12)
  })

  it('calls nothing predictive on fair draws', () => {
    const s = studyTopPositions(fairDraws(1100, 4040), 69, 5)!
    for (const r of s.restrictions) expect(r.verdict).toBe('chance')
    expect(Math.abs(s.correlation.z)).toBeLessThan(3)
  })

  it('finds a restriction that really works, and says it is predictive', () => {
    // A machine that rarely lets the top two numbers sit more than 20 apart
    const r = rng(12)
    const draws: Draw[] = []
    let date = '2000-01-01'
    while (draws.length < 1100) {
      const sorted = pick(r, 69)
      if (sorted[4] - sorted[3] > 20 && r() < 0.7) continue
      draws.push({ date, dow: dowOf(date), numbers: sorted, sorted })
      date = addDays(date, 3)
    }
    const s = studyTopPositions(draws, 69, 5)!
    const gap = s.restrictions.find((x) => x.key === 'topGap')!
    expect(gap.verdict).toBe('predictive')
    expect(gap.survival).toBeGreaterThan(gap.share)
    expect(s.joint.z).toBeGreaterThan(3)
  })

  it('judges each draw by a restriction fitted before it', () => {
    const draws = fairDraws(1000, 5150)
    const a = studyTopPositions(draws, 69, 5)!
    const b = studyTopPositions(replaceFrom(draws, 800, 61), 69, 5)!
    // The first third of the scored draws ends well before draw 800
    for (let i = 0; i < a.restrictions.length; i++) expect(b.restrictions[i].periods[0]).toEqual(a.restrictions[i].periods[0])
    expect(b.restrictions.map((r) => r.periods[2])).not.toEqual(a.restrictions.map((r) => r.periods[2]))
  })
})

describe('building combinations inside the reduced pool', () => {
  const draws = generateSampleDraws()
  const res = runEngine(draws, DEFAULT_SETTINGS)
  const K = res.K
  const state = new HistoryState(K, res.drawSize)
  for (const d of draws) state.push(d)
  const top12 = new Set(res.predictions.slice(0, 12).map((p) => p.number))

  it('widens the candidate numbers before ever leaving the pool', () => {
    // A pool that excludes every ticket made only of the top twelve
    const accept = (s: number[]) => s.some((n) => !top12.has(n))
    const out = buildCombos(state, res.predictions, 8, null, accept)
    expect(out.best!.inPool).toBe(true)
    expect(out.best!.candidates!).toBeGreaterThan(12)
    for (const c of [out.best!, ...out.alts]) expect(accept(c.numbers)).toBe(true)
  })

  it('flags a ticket from outside the pool when nothing inside it can be built', () => {
    const out = buildCombos(state, res.predictions, 8, null, () => false)
    expect(out.best!.inPool).toBe(false)
    expect(out.best!.notes).toContain('outside the reduced pool — best available')
  })

  it('leaves combinations unflagged when there is no pool', () => {
    const out = buildCombos(state, res.predictions, 8, null, null)
    expect(out.best!.inPool).toBeUndefined()
  })
})

describe('the prediction log keeps what was shown', () => {
  const draws = generateSampleDraws()
  const res = runEngine(draws, DEFAULT_SETTINGS)

  it('keeps the first prediction for a draw and never rewrites it', async () => {
    const { recordSnapshot, snapshotOf } = await import('../engine/snapshots.ts')
    const first = snapshotOf(res, new Date('2026-10-27T10:00:00Z'))!
    expect(first.date).toBe(res.nextDate)
    expect(first.top10).toEqual(res.top10.map((p) => p.number))
    const book = recordSnapshot({}, 'g', first)
    const later = { ...first, savedAt: '2026-10-27T20:00:00.000Z', top10: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }
    expect(recordSnapshot(book, 'g', later)).toBe(book)
    expect(book.g).toEqual([first])
    const other = recordSnapshot(book, 'h', later)
    expect(other.g).toEqual([first])
    expect(other.h).toEqual([later])
  })

  it('records the weights each prediction used and what the last update changed', () => {
    const pts = res.backtest.points
    expect(pts[0].weightsTop).toHaveLength(3)
    expect(pts[0].weightShift).toBeUndefined()
    expect(pts.slice(1).every((p) => p.weightShift !== undefined)).toBe(true)
    const w = pts[pts.length - 1].weightsTop!
    for (let i = 1; i < w.length; i++) expect(w[i][1]).toBeLessThanOrEqual(w[i - 1][1])
  })
})
