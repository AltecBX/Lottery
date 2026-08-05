import { describe, expect, it } from 'vitest'
import {
  ConstraintState, contextAt, EMPTY_CONTEXT, extractFeatures, featureCount, featureSpecs,
  positionIntervalProbability, wilson,
} from '../engine/constraints.ts'
import {
  adjacencyAtLeast, analyzeConstraints, clusteredCombos, countRthAtMost, MIN_CONSTRAINT_HISTORY,
  CUT_FAMILIES, MAX_CUT_STEP, reducedPoolAcceptor, reductionLedger, sameDigitCount, sampleUniverse, structuralFamilies,
  positionBandCount, sumAtMostCount, sumBoundedCombos, windowCount,
} from '../engine/constraintlab.ts'
import { orderStatPmf } from '../engine/positions.ts'
import { choose } from '../engine/odds.ts'
import { buildPortfolio } from '../engine/portfolio.ts'
import { runEngine } from '../engine/engine.ts'
import { DEFAULT_SETTINGS } from '../engine/types.ts'
import { dowOf } from '../engine/dates.ts'
import type { Draw } from '../engine/types.ts'

const K = 69
const D = 5

/**
 * A fair machine: every combination equally likely, no structure whatsoever.
 *
 * The bag is rebuilt for every draw, and that detail is the whole test. Carrying
 * one shuffled bag across draws leaves each draw's numbers sitting in the first
 * `size` slots when the next one starts, which correlates consecutive draws —
 * repeats fell to 0.343 per draw against the fair 0.362. The engine duly found
 * eleven rules beating their own space share, and it was right to: the data was
 * not fair. A generator this test relies on has to be provably memoryless.
 */
function fairDraws(n: number, seed = 12345, pool = K, size = D): Draw[] {
  let a = seed >>> 0
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const draws: Draw[] = []
  for (let i = 0; i < n; i++) {
    const bag = new Int32Array(pool)
    for (let b = 0; b < pool; b++) bag[b] = b + 1
    for (let j = 0; j < size; j++) {
      const k = j + Math.floor(rnd() * (pool - j))
      const t = bag[j]; bag[j] = bag[k]; bag[k] = t
    }
    const sorted = Array.from(bag.slice(0, size)).sort((x, y) => x - y)
    const day = new Date(Date.UTC(2015, 0, 3 + i * 3))
    const date = day.toISOString().slice(0, 10)
    draws.push({ date, dow: dowOf(date), numbers: sorted, sorted })
  }
  return draws
}

describe('order-statistic probabilities', () => {
  it('matches the exact hypergeometric identity for every position', () => {
    for (let r = 1; r <= D; r++) {
      let total = 0
      for (let v = 1; v <= K; v++) total += orderStatPmf(K, D, r, v)
      expect(total).toBeCloseTo(1, 10)
    }
  })

  it('is zero outside the range arithmetic allows', () => {
    // the r-th smallest can never be below r, nor above K − (D − r)
    for (let r = 1; r <= D; r++) {
      expect(orderStatPmf(K, D, r, r - 1)).toBe(0)
      expect(orderStatPmf(K, D, r, K - (D - r) + 1)).toBe(0)
      expect(orderStatPmf(K, D, r, r)).toBeGreaterThan(0)
      expect(orderStatPmf(K, D, r, K - (D - r))).toBeGreaterThan(0)
    }
  })

  it('counts an interval exactly, against a brute-force enumeration', () => {
    // small pool so every combination can be enumerated
    const k = 12, d = 4, r = 2, lo = 3, hi = 6
    let hits = 0
    for (let a = 1; a <= k; a++)
      for (let b = a + 1; b <= k; b++)
        for (let c = b + 1; c <= k; c++)
          for (let e = c + 1; e <= k; e++) {
            const v = [a, b, c, e][r - 1]
            if (v >= lo && v <= hi) hits++
          }
    expect(positionIntervalProbability(k, d, r, lo, hi)).toBeCloseTo(hits / choose(k, d), 12)
  })
})

describe('feature extraction', () => {
  const specs = featureSpecs(K, D)
  const idx = (key: string) => specs.findIndex((s) => s.key === key)

  it('measures a known combination correctly', () => {
    const f = extractFeatures([3, 4, 5, 40, 62], K, EMPTY_CONTEXT)
    expect(f[idx('pos1')]).toBe(3)
    expect(f[idx('pos5')]).toBe(62)
    expect(f[idx('gap1')]).toBe(1)
    expect(f[idx('gap4')]).toBe(22)
    expect(f[idx('sum')]).toBe(114)
    expect(f[idx('sumLow2')]).toBe(7)
    expect(f[idx('sumLow3')]).toBe(12)
    expect(f[idx('sumHigh2')]).toBe(102)
    expect(f[idx('spread')]).toBe(59)
    expect(f[idx('consec')]).toBe(2)
    expect(f[idx('runs')]).toBe(1)
    expect(f[idx('maxGap')]).toBe(35)
    expect(f[idx('minGap')]).toBe(1)
    expect(f[idx('odd')]).toBe(2)
    expect(f[idx('prime')]).toBe(2) // 3 and 5; 4, 40, 62 are composite
    expect(f[idx('lastDigitDup')]).toBe(0)
    expect(f.length).toBe(featureCount(D))
  })

  it('leaves conditional features undefined with no previous draw', () => {
    const f = extractFeatures([1, 2, 3, 4, 5], K, EMPTY_CONTEXT)
    expect(Number.isNaN(f[idx('repeatPrev')])).toBe(true)
    expect(Number.isNaN(f[idx('dSum')])).toBe(true)
  })

  it('measures repeats and deltas against real history', () => {
    const draws: Draw[] = [
      { date: '2020-01-01', dow: 3, numbers: [1, 2, 3, 4, 5], sorted: [1, 2, 3, 4, 5] },
      { date: '2020-01-04', dow: 6, numbers: [3, 4, 50, 60, 69], sorted: [3, 4, 50, 60, 69] },
    ]
    const f = extractFeatures(draws[1].sorted, K, contextAt(draws, 1))
    expect(f[idx('repeatPrev')]).toBe(2) // 3 and 4 carried over
    expect(f[idx('dSum')]).toBe(186 - 15)
    expect(f[idx('dSpread')]).toBe(66 - 4)
  })

  it('never lets an unseen value fall to zero probability', () => {
    const state = new ConstraintState(K, D)
    for (const d of fairDraws(300)) state.push(extractFeatures(d.sorted, K, EMPTY_CONTEXT), d.dow)
    const sumIdx = idx('sum')
    const { count, p } = state.at(sumIdx, 20) // a sum that will not have occurred
    expect(count).toBe(0)
    expect(p).toBeGreaterThan(0)
  })

  it('never derives an interval outside what arithmetic allows', () => {
    const state = new ConstraintState(K, D)
    for (const d of fairDraws(400)) state.push(extractFeatures(d.sorted, K, EMPTY_CONTEXT), d.dow)
    featureSpecs(K, D).forEach((spec, i) => {
      for (const alpha of [0.0005, 0.03]) {
        const { lo, hi } = state.interval(i, alpha)
        expect(lo).toBeGreaterThanOrEqual(spec.hardMin)
        expect(hi).toBeLessThanOrEqual(spec.hardMax)
        expect(lo).toBeLessThanOrEqual(hi)
      }
    })
  })

  it('gives the same interval whether asked one at a time or in a batch', () => {
    const state = new ConstraintState(K, D)
    for (const d of fairDraws(500, 999)) state.push(extractFeatures(d.sorted, K, EMPTY_CONTEXT), d.dow)
    const alphas = [0.0005, 0.002, 0.01, 0.03]
    const batch = alphas.map(() => ({ lo: 0, hi: 0 }))
    for (let i = 0; i < featureSpecs(K, D).length; i++) {
      state.intervalsFor(i, alphas, batch)
      alphas.forEach((a, ai) => expect(batch[ai]).toEqual(state.interval(i, a)))
    }
  })
})

describe('Wilson interval', () => {
  it('brackets a proportion and stays inside [0,1] at the extremes', () => {
    const mid = wilson(50, 100)
    expect(mid.lo).toBeLessThan(0.5)
    expect(mid.hi).toBeGreaterThan(0.5)
    const perfect = wilson(200, 200)
    expect(perfect.hi).toBe(1)
    expect(perfect.lo).toBeGreaterThan(0.97)
    expect(perfect.lo).toBeLessThan(1) // never claims certainty
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 })
  })
})

describe('the uniform sample', () => {
  it('reproduces the exact order-statistic distribution', () => {
    const specs = featureSpecs(K, D)
    const s = sampleUniverse(K, D, 20000, specs, 7)
    const p1 = specs.findIndex((x) => x.key === 'pos1')
    let mean = 0
    for (let i = 0; i < s.size; i++) mean += s.values[p1][i]
    mean /= s.size
    // E[1st of 5 from 69] = (K+1)/(D+1) = 11.67
    expect(mean).toBeGreaterThan(11.0)
    expect(mean).toBeLessThan(12.4)
  })

  it('is deterministic for a given seed', () => {
    const specs = featureSpecs(K, D)
    const a = sampleUniverse(K, D, 500, specs, 42)
    const b = sampleUniverse(K, D, 500, specs, 42)
    expect(a.combos[17]).toEqual(b.combos[17])
  })
})

describe('walk-forward constraint backtest', () => {
  const draws = fairDraws(700)
  const lab = analyzeConstraints(draws, K, D)!

  it('produces a lab once there is enough history', () => {
    expect(lab).not.toBeNull()
    expect(lab.evaluated).toBe(draws.length - MIN_CONSTRAINT_HISTORY)
    expect(lab.universe).toBe(choose(K, D))
  })

  it('refuses to run on too little history', () => {
    expect(analyzeConstraints(fairDraws(100), K, D)).toBeNull()
  })

  it('never leaks the future: changing later draws cannot move earlier verdicts', () => {
    // Two histories of identical length sharing their first 500 draws. Every
    // evaluated step in the first half falls inside that shared prefix, so if
    // any rule were fitted with knowledge of what came later, its first-half
    // survival would move when the tail is swapped. It must not.
    const shared = fairDraws(500, 777)
    const a = [...shared, ...fairDraws(200, 1001)]
    const b = [...shared, ...fairDraws(200, 2002)]
    const la = analyzeConstraints(a, K, D)!
    const lb = analyzeConstraints(b, K, D)!
    expect(la.evaluated).toBe(lb.evaluated)
    const half = Math.floor(la.evaluated / 2)
    expect(MIN_CONSTRAINT_HISTORY + half).toBeLessThan(500) // the half really is inside the shared prefix

    const byId = new Map(lb.rules.map((r) => [r.id, r]))
    let compared = 0
    for (const r of la.rules) {
      const other = byId.get(r.id)!
      expect(other.firstHalfSurvival).toBeCloseTo(r.firstHalfSurvival, 12)
      compared++
    }
    expect(compared).toBeGreaterThan(100)
  })

  it('keeps every derived range inside the arithmetic bounds', () => {
    for (const r of lab.rules) {
      expect(r.lo).toBeGreaterThanOrEqual(r.hardMin)
      expect(r.hi).toBeLessThanOrEqual(r.hardMax)
    }
  })

  it('counts survivors consistently: space share and survival are both proportions', () => {
    for (const r of lab.rules) {
      expect(r.spaceShare).toBeGreaterThanOrEqual(0)
      expect(r.spaceShare).toBeLessThanOrEqual(1)
      expect(r.survival).toBeGreaterThanOrEqual(0)
      expect(r.survival).toBeLessThanOrEqual(1)
      expect(r.survivalLo).toBeLessThanOrEqual(r.survival + 1e-9)
      expect(r.survivalHi).toBeGreaterThanOrEqual(r.survival - 1e-9)
    }
  })

  it('only ever combines rules that do not depend on the previous draw', () => {
    const conditional = new Set(featureSpecs(K, D).filter((s) => s.conditional).map((s) => s.key))
    for (const mode of lab.modes) {
      for (const id of mode.ruleIds) {
        const rule = lab.rules.find((r) => r.id === id)!
        expect(conditional.has(rule.featureKey)).toBe(false)
      }
    }
  })

  it('honours each mode’s survival floor on the draws it selected from', () => {
    for (const mode of lab.modes) {
      if (mode.ruleIds.length === 0) continue
      expect(mode.combinationsAfter).toBeLessThanOrEqual(mode.combinationsBefore)
      expect(mode.spaceShare).toBeLessThanOrEqual(1)
    }
  })

  it('reports a Pareto path that only ever tightens', () => {
    for (let i = 1; i < lab.pareto.length; i++) {
      expect(lab.pareto[i].spaceShare).toBeLessThanOrEqual(lab.pareto[i - 1].spaceShare + 1e-9)
    }
  })
})

describe('the fair generator really is fair', () => {
  it('repeats numbers from the previous draw at exactly the chance rate', () => {
    // D of K drawn twice independently share D²/K numbers on average — 25/69
    // here. Serial correlation shows up in this number before anywhere else,
    // and every claim in the suite below depends on there being none.
    const draws = fairDraws(4000, 20260804)
    let repeats = 0
    for (let i = 1; i < draws.length; i++) {
      for (const v of draws[i].sorted) if (draws[i - 1].sorted.includes(v)) repeats++
    }
    expect(repeats / (draws.length - 1)).toBeCloseTo((D * D) / K, 1)
  })
})

describe('fair synthetic data must not manufacture an edge', () => {
  /**
   * The whole feature rests on one identity: for a uniform draw, the chance the
   * winner survives a filter equals the share of combinations that filter
   * keeps. On data generated to be exactly fair, every rule must sit on that
   * line — any systematic gap would mean the estimator, not the lottery, is
   * producing the edge.
   */
  const lab = analyzeConstraints(fairDraws(900, 4242), K, D)!

  it('finds no rule with a real edge over its own space share', () => {
    const proven = lab.rules.filter((r) => r.provenEdge)
    // 136 correlated tests: the odd 2σ is expected, a pile of them is not
    expect(proven.length).toBeLessThan(8)
  })

  it('keeps survival and space share matched on average', () => {
    const usable = lab.rules.filter((r) => r.usable && r.spaceShare < 0.999)
    expect(usable.length).toBeGreaterThan(10)
    const meanGap = usable.reduce((s, r) => s + (r.survival - r.spaceShare), 0) / usable.length
    // averaged over every rule the two must agree to well under a percentage point
    expect(Math.abs(meanGap)).toBeLessThan(0.01)
  })

  it('never reports a mode that cuts space for free', () => {
    for (const mode of lab.modes) {
      if (mode.ruleIds.length === 0) continue
      // 2σ is the threshold the panel uses to call an edge real, so on fair
      // draws no mode may reach it in either direction.
      expect(Math.abs(mode.holdoutEdgeZ)).toBeLessThan(2)
      // The identity has to hold on the draws the optimiser never saw. Checking
      // the full record instead would be measuring the greedy's own selection
      // bias, which is real, expected, and reported separately below.
      const seOut = Math.sqrt((mode.spaceShare * (1 - mode.spaceShare)) / Math.max(1, mode.holdoutDraws))
      expect(Math.abs(mode.holdoutSurvival - mode.spaceShare)).toBeLessThan(3 * seOut + 0.005)
    }
  })

  it('shows the optimiser flattering itself, which is why the holdout is reported', () => {
    // The greedy picked these rules on the first half, so the in-sample figure
    // is inflated by construction — on fair data it still reads positive. If
    // the held-out number ever stopped being the lower of the two, the holdout
    // would have stopped doing its job.
    const selected = lab.modes.filter((m) => m.ruleIds.length > 0)
    expect(selected.length).toBeGreaterThan(0)
    for (const mode of selected) expect(mode.edgeZ).toBeGreaterThan(mode.holdoutEdgeZ)
  })

  it('measures space share at the same intervals survival was tested with', () => {
    // Scoring walk-forward survival against the final interval's space share
    // overstated every mode by about two percentage points. The two estimates
    // now come from the same rule, so a mode that keeps 96% of winners must be
    // keeping close to 96% of the space — not 90%.
    for (const mode of lab.modes) {
      if (mode.ruleIds.length === 0) continue
      const funnelEnd = mode.funnel[mode.funnel.length - 1]
      expect(funnelEnd.spaceShare).toBeCloseTo(mode.spaceShare, 6)
      const removed = mode.funnel.reduce((s, f) => s + f.removed, 0)
      expect(removed).toBeCloseTo(1 - mode.spaceShare, 6)
    }
  })

  it('states plainly when nothing beat the fair line', () => {
    const proven = lab.rules.filter((r) => r.provenEdge)
    if (proven.length === 0) expect(lab.verdict).toMatch(/fair machine|No constraint/i)
  })
})

describe('rule-era separation', () => {
  /** 400 fair draws on a 59-ball pool, then 500 on 69 — Powerball's 2015 change. */
  const acrossPoolChange = () => {
    const old = fairDraws(400, 11, 59, D)
    const modern = fairDraws(500, 22, 69, D).map((d, i) => ({
      ...d,
      date: new Date(Date.UTC(2019, 0, 3 + i * 3)).toISOString().slice(0, 10),
    }))
    return [...old, ...modern]
  }

  it('drops the retired pool instead of fitting ranges across the change', () => {
    const lab = analyzeConstraints(acrossPoolChange(), 69, D)
    expect(lab).not.toBeNull()
    expect(lab!.eraTrim).not.toBeNull()
    expect(lab!.eraTrim!.earlyMax).toBeLessThanOrEqual(59)
    expect(lab!.eraTrim!.currentMax).toBe(69)
    // Only the modern draws may be scored, so the walk-forward record cannot be
    // longer than the modern era minus the history each rule needs to exist.
    expect(lab!.evaluated).toBeLessThanOrEqual(500 - MIN_CONSTRAINT_HISTORY)
    expect(lab!.eraTrim!.excluded).toBeGreaterThanOrEqual(400)
  })

  it('does not manufacture an edge from the retired pool', () => {
    // Fitted across the change, "the 5th number stays under 60" holds for 400 of
    // 900 draws and reads as a colossal edge against a 69-ball sample. Scoped to
    // one era it is what it always was on fair draws: nothing.
    const lab = analyzeConstraints(acrossPoolChange(), 69, D)!
    const pos5 = lab.rules.filter((r) => r.featureKey === `pos${D}`)
    expect(pos5.length).toBeGreaterThan(0)
    for (const r of pos5) expect(r.edgeZ).toBeLessThan(4)
    expect(lab.rules.filter((r) => r.provenEdge).length).toBeLessThan(8)
  })

  it('uses the current pool when a shrinking pool inflated the detected maximum', () => {
    // Mega Millions went the other way: 75 mains down to 70. The lab must size
    // its universe on 70, not on a ball the game no longer has.
    const old = fairDraws(400, 33, 75, D)
    const modern = fairDraws(500, 44, 70, D).map((d, i) => ({
      ...d,
      date: new Date(Date.UTC(2019, 0, 3 + i * 3)).toISOString().slice(0, 10),
    }))
    const lab = analyzeConstraints([...old, ...modern], 75, D)
    expect(lab).not.toBeNull()
    expect(lab!.K).toBe(70)
    expect(lab!.universe).toBe(choose(70, D))
  })
})

describe('sorted-spreadsheet shapes, priced exactly', () => {
  it('counts combinations with a small r-th number by brute force agreement', () => {
    // Small enough to enumerate completely: K=12, D=3
    const k = 12, d = 3
    for (const r of [1, 2, 3]) {
      for (const v of [2, 4, 6]) {
        let brute = 0
        for (let a = 1; a <= k - 2; a++)
          for (let b = a + 1; b <= k - 1; b++)
            for (let c = b + 1; c <= k; c++) {
              const sorted = [a, b, c]
              if (sorted[r - 1] <= v) brute++
            }
        expect(countRthAtMost(k, d, r, v)).toBe(brute)
      }
    }
  })

  it('prices the shapes a sorted spreadsheet reveals, on the real Powerball geometry', () => {
    const lab = analyzeConstraints(fairDraws(900, 606), K, D)!
    const byKey = new Map(lab.presets.map((p) => [p.key, p]))
    // "4th number 5 or under": 4 of 5 numbers inside 1..5
    expect(byKey.get('pos4low')!.combos).toBe(5 * 64 + 1)
    // "5th number 9 or under": all five inside 1..9
    expect(byKey.get('pos5low')!.combos).toBe(choose(9, 5))
    // one straight run anywhere in 1..69
    expect(byKey.get('run')!.combos).toBe(69 - 5 + 1)
    // the calendar zone
    expect(byKey.get('dates')!.combos).toBe(choose(31, 5))
    for (const p of lab.presets) {
      expect(p.share).toBeCloseTo(p.combos / lab.universe, 12)
      // On fair data the observed count must sit near what the share predicts —
      // this is the whole "the draws mirror the space" claim, tested.
      const sd = Math.sqrt(Math.max(p.expected, 0.05))
      expect(Math.abs(p.observed - p.expected)).toBeLessThanOrEqual(4 * sd + 1)
    }
  })

  it('never suggests an exact past jackpot when asked not to', () => {
    const scores = new Float64Array(K + 1)
    for (let n = 1; n <= K; n++) scores[n] = 1 + (K - n) * 0.01
    const shape = { lo: [1, 2, 3, 4, 5], hi: [65, 66, 67, 68, 69], sumLo: 21, sumHi: 330 }
    // Ban whatever it would otherwise pick first, then ban its next answer too
    const free = buildPortfolio({ scores, K, D, specialK: 0, specialPicks: [], count: 3, spread: 0.5, shape, trials: 50 })
    const banned = new Set(free.tickets.map((t) => t.numbers.join('-')))
    const constrained = buildPortfolio({
      scores, K, D, specialK: 0, specialPicks: [], count: 3, spread: 0.5, shape, exclude: banned, trials: 50,
    })
    for (const t of constrained.tickets) {
      expect(banned.has(t.numbers.join('-'))).toBe(false)
    }
  })
})

describe('the reduction ledger', () => {
  it('counts window and same-digit families exactly, against brute force', () => {
    const k = 16, d = 3
    let w = 0, dg = 0
    for (let a = 1; a <= k - 2; a++)
      for (let b = a + 1; b <= k - 1; b++)
        for (let c = b + 1; c <= k; c++) {
          if (c - a <= 4) w++
          // "at least 4 share a digit" is impossible at D=3; test the D=4 form separately
        }
    expect(windowCount(k, d, 5)).toBe(w)
    const k4 = 30, d4 = 4
    for (let a = 1; a <= k4 - 3; a++)
      for (let b = a + 1; b <= k4 - 2; b++)
        for (let c = b + 1; c <= k4 - 1; c++)
          for (let e = c + 1; e <= k4; e++) {
            const per = new Array(10).fill(0)
            let mx = 0
            for (const n of [a, b, c, e]) mx = Math.max(mx, ++per[n % 10])
            if (mx >= 4) dg++
          }
    expect(sameDigitCount(k4, d4)).toBe(dg)
  })

  it('runs the full deduction and never double-counts a combination', () => {
    const draws = fairDraws(900, 12321)
    const lab = analyzeConstraints(draws, K, D)!
    const mode = lab.modes[2]
    const led = reductionLedger(lab, mode, draws, 26)
    expect(led.start).toBe(lab.universe * 26)
    // The rows must reconcile exactly with the remainder
    const removed = led.rows.reduce((s, r) => s + r.removed, 0)
    expect(led.start - removed).toBe(led.remaining)
    expect(led.remaining).toBe(led.rows[led.rows.length - 1].remaining)
    // Past main-sets: never more than distinct draws × bonus pool
    const past = led.rows.find((r) => r.key === 'past')!
    expect(past.removed).toBeLessThanOrEqual(draws.length * 26)
    expect(past.exact).toBe(true)
    // The mode's Monte Carlo row dominates and the exact rows stay small:
    // 1-2-3-4-x (321), all inside 1..9 (126), and the ≥3-adjacency family
    // (8,385, which contains every straight run), minus overlap and mode cuts
    const families = led.rows.find((r) => r.key === 'families')!
    expect(families.removed).toBeLessThanOrEqual((321 + 126 + 8385) * 26)
    expect(led.remainingShare).toBeGreaterThan(0.8)
    expect(led.remainingShare).toBeLessThan(1)
  })

  it('reports the real cost of retiring past winners when a main-set repeated', () => {
    const base = fairDraws(400, 777)
    // Plant a repeat: the 50th draw's mains appear again near the end
    const repeat = { ...base[380], numbers: base[50].sorted, sorted: base[50].sorted }
    const draws = [...base.slice(0, 380), repeat, ...base.slice(381)]
    const lab = analyzeConstraints(draws, K, D)!
    const led = reductionLedger(lab, lab.modes[0], draws, 26)
    expect(led.mainRepeats).toBe(1)
    expect(led.repeatExample).not.toBeNull()
    expect(led.repeatExample!.numbers).toEqual(base[50].sorted)
    const past = led.rows.find((r) => r.key === 'past')!
    expect(past.winnersNote).toContain('1 real winner')
  })
})

describe('generating the prediction from the reduced pool', () => {
  it('counts clustered and sum families exactly, against brute force', () => {
    // adjacency ≥ 3 at small scale
    const k = 14, d = 5
    let brute = 0
    for (let a = 1; a <= k - 4; a++)
      for (let b = a + 1; b <= k - 3; b++)
        for (let c = b + 1; c <= k - 2; c++)
          for (let e = c + 1; e <= k - 1; e++)
            for (let f = e + 1; f <= k; f++) {
              const s = [a, b, c, e, f]
              let adj = 0
              for (let i = 1; i < 5; i++) if (s[i] - s[i - 1] === 1) adj++
              if (adj >= 3) brute++
            }
    expect(adjacencyAtLeast(k, d, 3)).toBe(brute)
    const members = [...clusteredCombos(k, d)]
    expect(members.length).toBe(brute)
    expect(new Set(members.map((m) => m.join('-'))).size).toBe(brute)
    // sum DP vs brute force
    let sumBrute = 0
    for (let a = 1; a <= k - 2; a++)
      for (let b = a + 1; b <= k - 1; b++)
        for (let c = b + 1; c <= k; c++) if (a + b + c <= 20) sumBrute++
    expect(sumAtMostCount(k, 3, 20)).toBe(sumBrute)
    // and the mirror symmetry on the real geometry: sum ≤ s ↔ sum ≥ 350 − s
    expect(sumAtMostCount(69, 5, 50)).toBe(choose(69, 5) - sumAtMostCount(69, 5, 299))
  })

  it('the acceptor rejects every clustered example and every past winner', () => {
    const draws = fairDraws(900, 5150)
    const lab = analyzeConstraints(draws, K, D)!
    const balanced = lab.modes.find((m) => m.key === 'balanced')!
    const pastKeys = new Set(draws.map((d) => d.sorted.join('-')))
    const accept = reducedPoolAcceptor(lab, balanced, pastKeys)
    expect(accept([62, 63, 64, 65, 66])).toBe(false)
    expect(accept([1, 63, 64, 65, 66])).toBe(false)
    expect(accept([1, 2, 3, 65, 66])).toBe(false)
    expect(accept([1, 2, 3, 4, 50])).toBe(false)  // next-to-largest ≤ 5
    expect(accept([2, 3, 5, 8, 9])).toBe(false)   // everything under 10
    expect(accept(draws[100].sorted)).toBe(false) // a past winner
    // and a normal middle-of-the-space shape passes
    expect(accept([8, 21, 34, 47, 61])).toBe(true)
  })

  it('the engine generates its combination inside its own reduced pool', () => {
    const draws = fairDraws(900, 6001)
    const res = runEngine(draws, DEFAULT_SETTINGS)
    expect(res.ok).toBe(true)
    expect(res.bestCombo).not.toBeNull()
    const lab = res.constraintLab!
    const balanced = lab.modes.find((m) => m.key === 'balanced')!
    const pastKeys = new Set(draws.map((d) => d.sorted.join('-')))
    const accept = reducedPoolAcceptor(lab, balanced, pastKeys)
    expect(accept(res.bestCombo!.numbers)).toBe(true)
    expect(res.bestCombo!.notes).toContain('inside the reduced pool')
    for (const alt of res.altCombos) expect(accept(alt.numbers)).toBe(true)
  })
})

describe('the deep cut and the record-total boundary', () => {
  const draws = fairDraws(900, 20265)
  const lab = analyzeConstraints(draws, K, D)!

  it('enumerates sum-bounded combinations in exact agreement with the DP count', () => {
    let n = 0
    const seen = new Set<string>()
    for (const combo of sumBoundedCombos(K, D, 90)) {
      n++
      seen.add(combo.join('-'))
      expect(combo.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(90)
    }
    expect(n).toBe(sumAtMostCount(K, D, 90))
    expect(seen.size).toBe(n)
  })

  it('records the era sum extremes and cuts at them', () => {
    expect(lab.sumRecord).not.toBeNull()
    const rec = lab.sumRecord!
    expect(rec.min).toBeGreaterThanOrEqual(15)
    expect(rec.max).toBeLessThanOrEqual(335)
    const balanced = lab.modes.find((m) => m.key === 'balanced')!
    const accept = reducedPoolAcceptor(lab, balanced, new Set())
    // A spread-out, non-clustered set summing 325 — beyond any fair record here
    expect(accept([61, 63, 65, 67, 69])).toBe(false)
    // With the Balanced bands active the record-total regions are usually
    // already inside the cut, and the row must then honestly read zero rather
    // than deduct them twice.
    const led = reductionLedger(lab, balanced, draws, 26)
    const sums = led.rows.find((r) => r.key === 'sums')!
    expect(sums.exact).toBe(true)
    expect(sums.winnersNote).toMatch(/would have cost \d+ real winners/)
    const removed = led.rows.reduce((s, r) => s + r.removed, 0)
    expect(led.start - removed).toBe(led.remaining)
    // With no bands in the way, the row must carry the full enumerated regions
    // less only the true overlaps with past draws and the families.
    const bare = { ...balanced, ruleIds: [] }
    const ledBare = reductionLedger(lab, bare, draws, 26)
    const sumsBare = ledBare.rows.find((r) => r.key === 'sums')!
    const regionCap = (sumAtMostCount(K, D, rec.min) + sumAtMostCount(K, D, D * (K + 1) - rec.max)) * 26
    expect(sumsBare.removed).toBeGreaterThan(0)
    expect(sumsBare.removed).toBeLessThanOrEqual(regionCap)
  })

  it('offers the deep cut, and its bill obeys the identity', () => {
    const deep = lab.modes.find((m) => m.key === 'deep')!
    expect(deep.ruleIds.length).toBeGreaterThan(3)
    // Removing about a third of the space must cost about a third of winners —
    // anything else would mean the machinery is inventing an edge.
    expect(deep.spaceShare).toBeLessThan(0.8)
    expect(deep.spaceShare).toBeGreaterThan(0.45)
    expect(Math.abs(deep.survival - deep.spaceShare)).toBeLessThan(0.08)
  })

  it('keeps every Play-together ticket inside the reduced pool', () => {
    const balanced = lab.modes.find((m) => m.key === 'balanced')!
    const pastKeys = new Set(draws.map((d) => d.sorted.join('-')))
    const accept = reducedPoolAcceptor(lab, balanced, pastKeys)
    const scores = new Float64Array(K + 1)
    for (let n = 1; n <= K; n++) scores[n] = 1 + ((n * 37) % 50) * 0.01
    const shape = {
      lo: lab.positionBands.map((b) => b.lo),
      hi: lab.positionBands.map((b) => b.hi),
      sumLo: lab.sumRecord!.min + 1,
      sumHi: lab.sumRecord!.max - 1,
    }
    const pf = buildPortfolio({
      scores, K, D, specialK: 26, specialPicks: [5, 9], count: 6, spread: 0.7,
      shape, exclude: pastKeys, accept, trials: 60,
    })
    for (const t of pf.tickets) expect(accept(t.numbers)).toBe(true)
  })
})

describe('screening new pattern families', () => {
  it('counts every structural family exactly, against brute force', () => {
    const k = 24, d = 4
    const fams = structuralFamilies(k, d)
    const brute = new Map(fams.map((f) => [f.key, 0]))
    for (let a = 1; a <= k - 3; a++)
      for (let b = a + 1; b <= k - 2; b++)
        for (let c = b + 1; c <= k - 1; c++)
          for (let e = c + 1; e <= k; e++) {
            const s = [a, b, c, e]
            for (const f of fams) if (f.test(s)) brute.set(f.key, brute.get(f.key)! + 1)
          }
    for (const f of fams) expect(f.combos).toBe(brute.get(f.key))
  })

  it('cuts only families that are tiny and unseen, and keeps the rest', () => {
    // 3-19-35-51-67 fell on 2026-04-29: evenly spaced is 561 of 11.2M
    // combinations and it still happened, so it must never be cut.
    const fams = structuralFamilies(K, D)
    const cut = fams.filter((f) => CUT_FAMILIES.has(f.key))
    const kept = fams.filter((f) => !CUT_FAMILIES.has(f.key))
    expect(cut.map((f) => f.key).sort())
      .toEqual(['digitSum', 'evenStepTight', 'fib', 'mult5', 'oneDecade', 'sameDigit', 'slipRow', 'squareCube', 'tightSpan'])
    for (const f of cut) expect(f.combos / choose(K, D)).toBeLessThan(0.0002)
    expect(kept.find((f) => f.key === 'evenSpaced')!.test([3, 19, 35, 51, 67])).toBe(true)

    const draws = fairDraws(900, 4711)
    const lab = analyzeConstraints(draws, K, D)!
    const balanced = lab.modes.find((m) => m.key === 'balanced')!
    const accept = reducedPoolAcceptor(lab, balanced, new Set())
    expect(accept([41, 43, 46, 47, 49])).toBe(false)   // one decade
    expect(accept([10, 25, 40, 55, 65])).toBe(false)   // multiples of five
    expect(accept([7, 17, 27, 37, 47])).toBe(false)    // one last digit
    expect(accept([1, 15, 29, 43, 57])).toBe(false)    // a line across the play slip
    expect(accept([1, 4, 9, 16, 25])).toBe(false)      // squares
    expect(accept([2, 3, 5, 8, 13])).toBe(false)       // Fibonacci
    expect(accept([9, 18, 27, 36, 45])).toBe(false)    // one digit sum
    expect(accept([14, 15, 16, 17, 18])).toBe(false)   // five in a row
    expect(accept([1, 2, 3, 4, 6])).toBe(false)        // four in a row plus one
    expect(accept([14, 16, 18, 20, 21])).toBe(false)   // clustered without adjacency
    expect(accept([3, 19, 35, 51, 67])).toBe(true)     // evenly spaced — it happened
    // One slip column is measured but never cut: 9,295 tickets, about one due
    // per era. Asserted on the family itself, since the shape bands reject this
    // particular combination for an unrelated reason.
    expect(kept.find((f) => f.key === 'slipColumn')!.test([2, 5, 9, 12, 14])).toBe(true)
    expect(CUT_FAMILIES.has('slipColumn')).toBe(false)
  })

  it('cuts every even progression up to step 11 and keeps the wider ones', () => {
    const fams = structuralFamilies(K, D)
    const tight = fams.find((f) => f.key === 'evenStepTight')!
    const parent = fams.find((f) => f.key === 'evenSpaced')!

    // The whole family, step by step: 1..MAX_CUT_STEP in, the rest out.
    for (let step = 1; step <= Math.floor((K - 1) / (D - 1)); step++) {
      for (let a = 1; a + (D - 1) * step <= K; a++) {
        const combo = Array.from({ length: D }, (_, i) => a + i * step)
        expect(tight.test(combo)).toBe(step <= MAX_CUT_STEP)
        expect(parent.test(combo)).toBe(true)
      }
    }
    expect(tight.combos).toBe(495)
    expect(parent.combos - tight.combos).toBe(66)   // steps 12..17, where the real draw sits

    // Zero sightings is what a fair machine predicts here, so "never happened"
    // is not evidence — it is the null result. 495 of 11.2M over the whole
    // record expects well under one hit, which is why this cut is cheap rather
    // than informative, and why the parent family stays uncut.
    expect((3535 * tight.combos) / choose(K, D)).toBeLessThan(0.5)

    const draws = fairDraws(900, 4711)
    const lab = analyzeConstraints(draws, K, D)!
    const accept = reducedPoolAcceptor(lab, lab.modes.find((m) => m.key === 'balanced')!, new Set())
    for (let step = 1; step <= MAX_CUT_STEP; step++) {
      for (let a = 1; a + (D - 1) * step <= K; a++) {
        expect(accept(Array.from({ length: D }, (_, i) => a + i * step))).toBe(false)
      }
    }
    // The boundary is drawn where the single observed hit sits, so the wider
    // steps have to survive the acceptor — including the draw itself.
    expect(accept([3, 19, 35, 51, 67])).toBe(true)
  })

  it('rejects sliced floors, and the break rate tracks how thin the slice is', () => {
    const base = fairDraws(1200, 8123)
    const draws = base.map((d, i) => ({ ...d, special: 1 + (i * 7) % 26 }))
    const lab = analyzeConstraints(draws, K, D)!
    expect(lab.rejected.length).toBeGreaterThan(0)
    const perBall = lab.rejected.find((r) => r.label.includes('bonus ball'))!
    expect(perBall.rate).toBeGreaterThan(0.02)
    // Every rejected rule must beat the pooled floor's break rate by design,
    // and the thinnest slice must be the worst offender.
    expect(lab.rejected[0].rate).toBeGreaterThanOrEqual(lab.rejected[lab.rejected.length - 1].rate)
    for (const r of lab.rejected) {
      expect(r.broke).toBeGreaterThan(0)
      expect(r.chances).toBeGreaterThan(100)
      expect(r.note).toMatch(/draws behind each floor/)
    }
  })
})

describe('testing the machine rather than the rules', () => {
  it('counts joint position bands exactly, against brute force', () => {
    const k = 20, d = 4
    const lo = [1, 3, 6, 10]
    const hi = [8, 12, 16, 20]
    let brute = 0
    for (let a = 1; a <= k - 3; a++)
      for (let b = a + 1; b <= k - 2; b++)
        for (let c = b + 1; c <= k - 1; c++)
          for (let e = c + 1; e <= k; e++) {
            const s = [a, b, c, e]
            if (s.every((n, i) => n >= lo[i] && n <= hi[i])) brute++
          }
    expect(positionBandCount(k, d, lo, hi)).toBe(brute)
    // Bands covering everything keep the whole space
    expect(positionBandCount(k, d, [1, 1, 1, 1], [k, k, k, k])).toBe(choose(k, d))
  })

  it('passes every fairness test on data generated to be fair', () => {
    // The bonus ball has to be drawn, not dealt round-robin: a perfect cycle
    // gives chi-square ≈ 0, which the test correctly reads as too even to be
    // random and flags at −3.5σ. Real randomness is lumpier than that.
    let a = 424242
    const roll = () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const draws = fairDraws(1400, 90909).map((d) => ({ ...d, special: 1 + Math.floor(roll() * 26) }))
    const lab = analyzeConstraints(draws, K, D)!
    expect(lab.fairness.length).toBeGreaterThanOrEqual(5)
    for (const f of lab.fairness) {
      expect(Math.abs(f.z)).toBeLessThan(3)
      expect(f.verdict).toBe('as expected')
    }
    // The uniformity test is the one that decides the rest, so name it
    expect(lab.fairness.some((f) => f.key === 'uniform')).toBe(true)
  })

  it('catches a bonus pool that comes out too evenly to be random', () => {
    // Dealt in strict rotation rather than drawn: every value appears the same
    // number of times, chi-square collapses to nothing, and that is as much a
    // failure of randomness as a jammed ball is.
    const draws = fairDraws(1300, 7788).map((d, i) => ({ ...d, special: 1 + (i * 11) % 26 }))
    const lab = analyzeConstraints(draws, K, D)!
    const bonus = lab.fairness.find((f) => f.key === 'bonus')!
    expect(bonus.z).toBeLessThan(-3)
    expect(bonus.verdict).toBe('off the line')
  })

  it('catches a machine that is not fair', () => {
    // Ball 7 jammed into every draw: the frequency test must light up, and so
    // must the whole-combination test, since the space is no longer uniform.
    const base = fairDraws(1400, 5309)
    const rigged = base.map((d) => {
      const s = [...new Set([7, ...d.sorted.slice(1)])].sort((a, b) => a - b)
      while (s.length < D) s.push(s[s.length - 1] + 1)
      return { ...d, numbers: s, sorted: s }
    })
    const lab = analyzeConstraints(rigged, K, D)!
    const balls = lab.fairness.find((f) => f.key === 'balls')!
    expect(balls.z).toBeGreaterThan(3)
    expect(balls.verdict).toBe('off the line')
  })
})
