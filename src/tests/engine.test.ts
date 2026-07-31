import { describe, expect, it } from 'vitest'
import { parseDateToken } from '../engine/dates.ts'
import { drawsToCsv, mergeDraws, parseDelimitedText, parseMoney, rowsToDraws, splitDelimited } from '../engine/parse.ts'
import { HistoryState } from '../engine/state.ts'
import { isotonicDecreasing, runBacktest } from '../engine/backtest.ts'
import { analyzeRepeats } from '../engine/repeats.ts'
import { analyzePositions, orderStatPmf, positionalFit } from '../engine/positions.ts'
import { topIndices, topIndicesPartial } from '../engine/signals.ts'
import { runEngine } from '../engine/engine.ts'
import { detectEra, drawsForEra } from '../engine/era.ts'
import { generateSampleDraws } from '../engine/sample.ts'
import { choose, hitDistribution, jackpotOdds, matchOdds } from '../engine/odds.ts'
import { attachSales, parseSalesRows, parseSocrataRows } from '../engine/sync.ts'
import { analyzeJackpots, projectNextJackpot, ticketValue, US_LOWER_TIERS } from '../engine/jackpot.ts'
import { countdownTo, drawTimeLabel, formatCountdown, nextDrawInstant } from '../engine/drawtime.ts'
import { createGame, daysSinceLastDraw, migrateLegacy } from '../engine/games.ts'
import { DEFAULT_SETTINGS } from '../engine/types.ts'
import type { Draw } from '../engine/types.ts'

const D = (date: string, numbers: number[]): Draw => ({
  date,
  dow: new Date(...(date.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number])).getDay(),
  numbers,
  sorted: [...numbers].sort((a, b) => a - b),
})

describe('date parsing', () => {
  it('parses ISO, US, textual and serial dates', () => {
    expect(parseDateToken('2026-03-30', false)).toMatchObject({ y: 2026, m: 3, d: 30 })
    expect(parseDateToken('3/30/2026', false)).toMatchObject({ y: 2026, m: 3, d: 30 })
    expect(parseDateToken('30/3/2026', false)).toMatchObject({ y: 2026, m: 3, d: 30 })
    expect(parseDateToken('Mar 30, 2026', false)).toMatchObject({ y: 2026, m: 3, d: 30 })
    expect(parseDateToken('30 Mar 2026', false)).toMatchObject({ y: 2026, m: 3, d: 30 })
    expect(parseDateToken(46111, false)).toMatchObject({ y: 2026, m: 3, d: 30 })
  })
  it('honors day-first for ambiguous triples', () => {
    expect(parseDateToken('3/4/2026', false)).toMatchObject({ m: 3, d: 4 })
    expect(parseDateToken('3/4/2026', true)).toMatchObject({ m: 4, d: 3 })
  })
  it('rejects garbage', () => {
    expect(parseDateToken('hello', false)).toBeNull()
    expect(parseDateToken('13/13/2026', false)).toBeNull()
  })
})

describe('parsing delimited text', () => {
  it('parses the 5-number pipe format from the spec', () => {
    const text = 'Date | Day of Week | Number 1 | Number 2 | Number 3 | Number 4 | Number 5\n' +
      '3/30/2026 | Monday | 9 | 13 | 28 | 45 | 51\n' +
      '4/1/2026 | Wednesday | 2 | 9 | 17 | 33 | 40\n'
    const { draws, errors, drawSize } = parseDelimitedText(text)
    expect(errors).toEqual([])
    expect(drawSize).toBe(5)
    expect(draws).toHaveLength(2)
    expect(draws[0]).toMatchObject({ date: '2026-03-30', dow: 1, sorted: [9, 13, 28, 45, 51] })
  })
  it('auto-detects 6-number games', () => {
    const text = '2026-03-30,9,13,28,45,49,3\n2026-04-01,2,9,17,33,40,44'
    const { draws, errors, drawSize } = parseDelimitedText(text)
    expect(errors).toEqual([])
    expect(drawSize).toBe(6)
    expect(draws[0].sorted).toEqual([3, 9, 13, 28, 45, 49])
  })
  it('a draw-size override splits off bonus columns', () => {
    const text = '2026-03-30,9,13,28,45,49,3\n2026-04-01,2,9,17,33,40,44'
    const { draws, drawSize, warnings } = parseDelimitedText(text, 5)
    expect(drawSize).toBe(5)
    expect(draws[0].sorted).toEqual([9, 13, 28, 45, 49])
    expect(warnings.some((w) => w.includes('extra number columns'))).toBe(true)
  })
  it('parses plain CSV without day column and sorts by date', () => {
    const text = '2026-04-01,2,9,17,33,40\n2026-03-30,9,13,28,45,51'
    const { draws, errors } = parseDelimitedText(text)
    expect(errors).toEqual([])
    expect(draws.map((d) => d.date)).toEqual(['2026-03-30', '2026-04-01'])
  })
  it('flags bad rows with reasons', () => {
    const { draws, errors } = parseDelimitedText('2026-03-30,9,9,28,45,51\nnot-a-date,1,2,3,4,5\n2026-04-01,1,2,3,4')
    expect(draws).toHaveLength(0)
    expect(errors).toHaveLength(3)
    expect(errors.some((e) => /duplicate number/.test(e))).toBe(true)
    expect(errors.some((e) => /as a date/.test(e))).toBe(true)
    expect(errors.some((e) => /found 4 numbers, need 5/.test(e))).toBe(true)
  })
  it('ignores minority extra columns and warns', () => {
    const out = rowsToDraws([
      ['2026-03-28', '1', '13', '28', '45', '51'],
      ['2026-03-29', '2', '14', '29', '46', '50'],
      ['2026-03-30', '9', '13', '28', '45', '51', '12'],
    ])
    expect(out.drawSize).toBe(5)
    expect(out.draws[2].sorted).toEqual([9, 13, 28, 45, 51])
    expect(out.warnings.some((w) => w.includes('extra number columns'))).toBe(true)
  })
  it("splits a Powerball-style 'Pball' column into a separate special ball (user's format)", () => {
    const text = 'Draw Date\tDay\tFirst\tSecond\tThird\tFourth\tFifth\tPball\n' +
      '7/27/26\tMonday\t6\t26\t46\t58\t65\t25\n' +
      '7/25/26\tSaturday\t3\t4\t24\t36\t47\t17\n' +
      '7/22/26\tWednesday\t4\t5\t22\t50\t58\t1\n' +
      '7/20/26\tMonday\t2\t9\t44\t53\t59\t8\n'
    const { draws, errors, drawSize, hasSpecial } = parseDelimitedText(text)
    expect(errors).toEqual([])
    expect(drawSize).toBe(5)
    expect(hasSpecial).toBe(true)
    expect(draws[draws.length - 1]).toMatchObject({ date: '2026-07-27', sorted: [6, 26, 46, 58, 65], special: 25 })
  })
  it('detects a bonus ball from value patterns even without a header', () => {
    const rows: string[] = []
    let seed = 5
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 30; i++) {
      const mains = new Set<number>()
      while (mains.size < 5) mains.add(1 + Math.floor(rand() * 69))
      const pb = 1 + Math.floor(rand() * 26)
      const d = new Date(2025, 0, 1 + i * 3)
      rows.push(`${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()},${[...mains].sort((a, b) => a - b).join(',')},${pb}`)
    }
    const { drawSize, hasSpecial, errors } = parseDelimitedText(rows.join('\n'))
    expect(errors).toEqual([])
    expect(drawSize).toBe(5)
    expect(hasSpecial).toBe(true)
  })
  it('does NOT mistake a plain sorted 6-number game for 5+bonus', () => {
    const rows: string[] = []
    let seed = 9
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 30; i++) {
      const nums = new Set<number>()
      while (nums.size < 6) nums.add(1 + Math.floor(rand() * 49))
      const d = new Date(2025, 0, 1 + i * 3)
      rows.push(`${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()},${[...nums].sort((a, b) => a - b).join(',')}`)
    }
    const { drawSize, hasSpecial } = parseDelimitedText(rows.join('\n'))
    expect(drawSize).toBe(6)
    expect(hasSpecial).toBe(false)
  })
  it('merge skips exact duplicates', () => {
    const a = [D('2026-03-30', [1, 2, 3, 4, 5])]
    const b = [D('2026-03-30', [1, 2, 3, 4, 5]), D('2026-04-01', [6, 7, 8, 9, 10])]
    const { merged, added, skipped } = mergeDraws(a, b)
    expect(merged).toHaveLength(2)
    expect(added).toBe(1)
    expect(skipped).toBe(1)
  })
})

describe('history state', () => {
  it('tracks counts, gaps, windows and transitions', () => {
    const s = new HistoryState(20, 5)
    s.push(D('2026-01-05', [1, 2, 3, 4, 5]))
    s.push(D('2026-01-07', [1, 6, 7, 8, 9]))
    s.push(D('2026-01-09', [1, 2, 10, 11, 12]))
    expect(s.counts[1]).toBe(3)
    expect(s.counts[2]).toBe(2)
    expect(s.gapN[2]).toBe(1)
    expect(s.gapSum[2]).toBe(2) // seen at t=0 and t=2
    expect(s.drawsSince(3)).toBe(3)
    expect(s.streak[1]).toBe(3)
    expect(s.maxStreak[1]).toBe(3)
    expect(s.w10[1]).toBe(3)
    // transitions: 6 was in draw 1; 2 appeared in draw 2 right after
    expect(s.trans[6 * 21 + 2]).toBe(1)
    expect(s.transOpp[6]).toBe(1)
    expect(s.repeatCount[1]).toBe(2)
    // pair (1,2) appeared twice together
    expect(s.pairCounts[1 * 21 + 2]).toBe(2)
    // per-weekday recent window: Monday saw draw 0 only
    expect(s.dowRecent[1 * 21 + 1]).toBe(1)
  })
})

describe('isotonic regression', () => {
  it('produces a non-increasing sequence preserving the mean', () => {
    const rates = [0.3, 0.5, 0.2, 0.25, 0.1]
    const out = isotonicDecreasing(rates, [1, 1, 1, 1, 1])
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeLessThanOrEqual(out[i - 1] + 1e-12)
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
    expect(mean(out)).toBeCloseTo(mean(rates), 10)
  })
})

describe('walk-forward backtest', () => {
  const sample = generateSampleDraws()

  it('never leaks future data: replacing the final draw only affects the final point', () => {
    const draws = sample.slice(0, 120)
    const mutated = [...draws.slice(0, 119), D('2026-12-28', [44, 45, 46, 47, 48, 49])]
    const a = runBacktest(draws, 49, 6, false)
    const b = runBacktest(mutated, 49, 6, false)
    expect(a.summary.points.length).toBe(b.summary.points.length)
    for (let i = 0; i < a.summary.points.length - 1; i++) {
      expect(a.summary.points[i]).toEqual(b.summary.points[i])
    }
  })

  it('learns on the structured sample: ensemble beats chance and the rank calibration is monotone', () => {
    const bt = runBacktest(sample, 49, 6, false)
    expect(bt.summary.evaluated).toBeGreaterThan(500)
    expect(bt.summary.ensemble10).toBeGreaterThan(bt.summary.chance10)
    for (let i = 1; i < bt.rankHitRate.length; i++) {
      expect(bt.rankHitRate[i]).toBeLessThanOrEqual(bt.rankHitRate[i - 1] + 1e-12)
    }
    const wSum = Object.values(bt.weights).reduce((a, b) => a + b, 0)
    expect(wSum).toBeCloseTo(1, 6)
    // The generator plants repeat + follower structure; those signals should carry weight
    const repeatPerf = bt.summary.signals.find((s) => s.key === 'repeat')
    expect(repeatPerf && repeatPerf.skill).toBeGreaterThan(0)
  })

  it('records the self-test trail: predicted top-10 and actual numbers per draw', () => {
    const bt = runBacktest(sample.slice(0, 200), 49, 6, false)
    const p = bt.summary.points[bt.summary.points.length - 1]
    expect(p.predictedTop).toHaveLength(10)
    expect(new Set(p.predictedTop).size).toBe(10)
    expect(p.actual).toHaveLength(6)
    const hits = p.actual.filter((n) => p.predictedTop.includes(n)).length
    expect(p.hits10).toBe(hits)
  })
})

function fairRandomDraws(seed: number, n: number, K: number, drawSize: number): Draw[] {
  let a = seed >>> 0
  const rand = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out: Draw[] = []
  const dt = new Date(2020, 0, 6)
  for (let i = 0; i < n; i++) {
    const set = new Set<number>()
    while (set.size < drawSize) set.add(1 + Math.floor(rand() * K))
    const sorted = [...set].sort((x, y) => x - y)
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    out.push({ date: iso, dow: dt.getDay(), numbers: sorted, sorted })
    dt.setDate(dt.getDate() + [2, 2, 3][i % 3])
  }
  return out
}

describe('learned combiner (online regression)', () => {
  it('earns real probability skill on structured data', () => {
    const bt = runBacktest(generateSampleDraws(), 49, 6, false)
    // Positive walk-forward log-likelihood vs uniform = genuine probability skill
    expect(bt.summary.mlSkillNats).toBeGreaterThan(0.05)
    const ml = bt.summary.signals.find((s) => s.key === 'mlModel')
    expect(ml).toBeDefined()
    expect(ml!.skill).toBeGreaterThan(0.15)
    // It should earn more than a uniform share of the ensemble
    expect(ml!.weight).toBeGreaterThan(1 / bt.summary.signals.length)
  })

  it('stays honest on fair random draws: no over-confidence, no stolen weight', () => {
    const bt = runBacktest(fairRandomDraws(777, 700, 69, 5), 69, 5, false)
    // Log-score against uniform must stay near zero (slightly negative is the
    // cost of learning; large negative would mean over-confident noise-fitting)
    expect(Math.abs(bt.summary.mlSkillNats ?? 0)).toBeLessThan(0.06)
    const uniform = 1 / bt.summary.signals.length
    const ml = bt.summary.signals.find((s) => s.key === 'mlModel')
    expect(ml!.weight).toBeLessThan(2 * uniform)
  })

  it('repeat scan: finds a planted exact repeat, honest chance expectation, overlap accounting', () => {
    const draws = fairRandomDraws(9, 200, 49, 6)
    // Plant an exact repeat of draw 10 at the end
    const dup = { ...draws[10], date: '2026-07-30', numbers: [...draws[10].numbers], sorted: [...draws[10].sorted] }
    const r = analyzeRepeats([...draws, dup], 49, 6)
    expect(r.exactRepeats.length).toBeGreaterThanOrEqual(1)
    const found = r.exactRepeats.find((e) => e.numbers.join('-') === draws[10].sorted.join('-'))
    expect(found).toBeDefined()
    expect(found!.dates).toContain('2026-07-30')
    expect(r.maxOverlap).toBe(6)
    // pairsByOverlap must account for every pair exactly once
    const n = 201
    expect(r.pairsByOverlap.reduce((a, b) => a + b, 0)).toBe((n * (n - 1)) / 2)
    // Birthday expectation: C(n,2)/C(49,6)
    expect(r.expectedRepeats).toBeCloseTo(((n * (n - 1)) / 2) / 13983816, 8)
    // Chance-expected overlap counts sum to the total pairs too (pmf sums to 1)
    expect(r.expectedByOverlap.reduce((a, b) => a + b, 0)).toBeCloseTo((n * (n - 1)) / 2, 4)
  })

  it('repeat scan on clean random data: no exact repeat, engine flags the best combo as new', () => {
    const draws = fairRandomDraws(31, 400, 69, 5)
    const r = analyzeRepeats(draws, 69, 5)
    expect(r.exactRepeats).toHaveLength(0)
    expect(r.maxOverlap).toBeLessThan(5)
    const res = runEngine(draws, DEFAULT_SETTINGS)
    expect(res.ok).toBe(true)
    expect(res.repeats).not.toBeNull()
    expect(res.repeats!.totalDraws).toBe(400)
    // A best combo assembled from top-ranked numbers essentially never matches a past draw
    expect(res.bestComboIsNew).toBe(true)
  })

  it('topIndicesPartial matches topIndices exactly, including tie order', () => {
    const K = 69
    for (const seed of [1, 2, 3]) {
      let a = seed >>> 0
      const rand = () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      const arr = new Float64Array(K + 1)
      // deliberately coarse values so ties are common
      for (let i = 1; i <= K; i++) arr[i] = Math.round(rand() * 5) / 5
      for (const m of [1, 3, 10, 25]) {
        expect(topIndicesPartial(arr, K, m)).toEqual(topIndices(arr, K, m))
      }
    }
  })

  it('hazard histogram accounts for every (number, draw) exposure', () => {
    const draws = fairRandomDraws(42, 120, 30, 4)
    const st = new HistoryState(30, 4)
    for (const d of draws) st.push(d)
    let exp = 0, hits = 0
    for (let g = 0; g < st.hazardExp.length; g++) { exp += st.hazardExp[g]; hits += st.hazardHits[g] }
    expect(exp).toBe(120 * 30)
    expect(hits).toBe(120 * 4)
  })
})

function powerballLike(n: number): Draw[] {
  // 5-of-69 mains + 1-of-26 special with a mildly hot special value
  let seed = 0xbeef
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const draws: Draw[] = []
  for (let i = 0; i < n; i++) {
    const mains = new Set<number>()
    while (mains.size < 5) mains.add(1 + Math.floor(rand() * 69))
    const special = rand() < 0.18 ? 21 : 1 + Math.floor(rand() * 26)
    const dt = new Date(2024, 0, 1 + Math.floor(i / 3) * 7 + [0, 2, 5][i % 3])
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    const sorted = [...mains].sort((a, b) => a - b)
    draws.push({ date: iso, dow: dt.getDay(), numbers: sorted, sorted, special })
  }
  return draws
}

describe('bonus-ball model', () => {
  const draws = powerballLike(400)
  const res = runEngine(draws, DEFAULT_SETTINGS)

  it('models the special ball in its own pool and logs its self-tests', () => {
    expect(res.ok).toBe(true)
    expect(res.drawSize).toBe(5)
    expect(res.special).not.toBeNull()
    expect(res.special!.K).toBeGreaterThanOrEqual(25)
    expect(res.special!.picks.length).toBe(4)
    for (const p of res.special!.picks) {
      expect(p.number).toBeGreaterThanOrEqual(1)
      expect(p.number).toBeLessThanOrEqual(res.special!.K)
      expect(p.probability).toBeGreaterThan(0)
    }
    expect(res.backtest.special).toBeDefined()
    expect(res.backtest.special!.evaluated).toBeGreaterThan(300)
    const last = res.backtest.points[res.backtest.points.length - 1]
    expect(last.specialTop).toHaveLength(3)
    expect(typeof last.specialActual).toBe('number')
    // The planted hot special (21) should be catchable: top-3 above chance
    expect(res.backtest.special!.top3).toBeGreaterThan(res.backtest.special!.chance3)
  })

  it('special leakage guard: replacing the final draw leaves earlier points identical', () => {
    const mutated = [...draws.slice(0, -1), { ...draws[draws.length - 1], special: 5, date: '2026-12-30' }]
    const a = runEngine(draws, DEFAULT_SETTINGS)
    const b = runEngine(mutated, DEFAULT_SETTINGS)
    for (let i = 0; i < a.backtest.points.length - 1; i++) {
      expect(a.backtest.points[i]).toEqual(b.backtest.points[i])
    }
  })
})

describe('column (order-statistic) analysis', () => {
  const draws = fairRandomDraws(5, 900, 69, 5)

  it('order-statistic pmf is a proper distribution matching the known mean', () => {
    const K = 69, D = 5
    for (let r = 1; r <= D; r++) {
      let mass = 0
      let mean = 0
      for (let v = 1; v <= K; v++) {
        const p = orderStatPmf(K, D, r, v)
        expect(p).toBeGreaterThanOrEqual(0)
        mass += p
        mean += v * p
      }
      expect(mass).toBeCloseTo(1, 9)
      // E[r-th of D from 1..K] = r(K+1)/(D+1)
      expect(mean).toBeCloseTo((r * (K + 1)) / (D + 1), 6)
    }
    // impossible placements carry zero mass
    expect(orderStatPmf(69, 5, 1, 66)).toBe(0)
    expect(orderStatPmf(69, 5, 5, 4)).toBe(0)
  })

  it('measures each column against its own history and tracks theory', () => {
    const pa = analyzePositions(draws, 69, 5, true)
    expect(pa.columns).toHaveLength(5)
    pa.columns.forEach((c, i) => {
      expect(c.draws).toBe(900)
      // columns are strictly ordered: every value in column i < column i+1's max
      expect(c.theoryMean).toBeCloseTo(((i + 1) * 70) / 6, 6)
      // a fair game's observed column mean tracks the theoretical one
      expect(Math.abs(c.mean - c.theoryMean)).toBeLessThan(3)
      expect(c.min).toBeLessThanOrEqual(c.p10)
      expect(c.p10).toBeLessThanOrEqual(c.median)
      expect(c.median).toBeLessThanOrEqual(c.p90)
      expect(c.p90).toBeLessThanOrEqual(c.max)
    })
    // the lowest ball never reaches the top of the pool, the highest never the bottom
    expect(pa.columns[0].max).toBeLessThan(69)
    expect(pa.columns[4].min).toBeGreaterThan(1)
  })

  it('positional fit flags shapes the history has never produced', () => {
    const pa = analyzePositions(draws, 69, 5, true)
    const typical = [pa.columns[0].median, pa.columns[1].median, pa.columns[2].median, pa.columns[3].median, pa.columns[4].median]
    const ok = positionalFit(pa, typical)
    expect(ok.impossibleColumns).toHaveLength(0)
    expect(ok.plausibility).toBeGreaterThan(0.5)
    // five clustered high numbers: the low columns are far outside anything drawn
    const absurd = [65, 66, 67, 68, 69]
    const bad = positionalFit(pa, absurd)
    expect(bad.impossibleColumns.length).toBeGreaterThan(0)
    expect(bad.plausibility).toBeLessThan(0.5)
  })

  it('engine exposes the column analysis and scores its own best combo', () => {
    const res = runEngine(draws, DEFAULT_SETTINGS)
    expect(res.ok).toBe(true)
    expect(res.positionAnalysis?.columns).toHaveLength(5)
    expect(res.positionAnalysis?.sorted).toBe(true)
    expect(res.bestComboFit).not.toBeNull()
    // the builder should not propose a shape this history has never produced
    expect(res.bestComboFit!.impossibleColumns).toHaveLength(0)
  })
})

describe('jackpot, winner location and sales', () => {
  it('parses money in every common shape', () => {
    expect(parseMoney('$1,020,000,000')).toBe(1_020_000_000)
    expect(parseMoney('1.02B')).toBeCloseTo(1.02e9, 3)
    expect(parseMoney('245M')).toBe(245_000_000)
    expect(parseMoney('$90 million')).toBe(90_000_000)
    expect(parseMoney(75_000_000)).toBe(75_000_000)
    expect(parseMoney('')).toBeNull()
    expect(parseMoney('rolled over')).toBeNull()
    expect(parseMoney(0)).toBeNull()
  })

  it('reads jackpot and winner-location columns without disturbing the numbers', () => {
    const text = [
      'Draw Date,Day,First,Second,Third,Fourth,Fifth,Pball,Jackpot,Winner Location',
      '07/29/2026,Wednesday,30,36,40,42,57,2,"$1,200,000",',
      '07/27/2026,Monday,6,26,46,58,65,25,"$980,000,000",Middlebury VT',
    ].join('\n')
    const out = parseDelimitedText(text)
    expect(out.drawSize).toBe(5)
    expect(out.hasSpecial).toBe(true)
    expect(out.draws).toHaveLength(2)
    const monday = out.draws.find((d) => d.date === '2026-07-27')!
    expect(monday.sorted).toEqual([6, 26, 46, 58, 65])
    expect(monday.special).toBe(25)
    expect(monday.jackpot).toBe(980_000_000)
    expect(monday.winnerLocation).toBe('Middlebury VT')
    // blank location must not become a phantom winner
    expect(out.draws.find((d) => d.date === '2026-07-29')!.winnerLocation).toBeUndefined()
  })

  it('CSV export round-trips jackpot and winner location', () => {
    const draws: Draw[] = [
      { ...D('2026-07-27', [6, 26, 46, 58, 65]), special: 25, jackpot: 980_000_000, winnerLocation: 'Middlebury, VT' },
      { ...D('2026-07-29', [30, 36, 40, 42, 57]), special: 2 },
    ]
    const csv = drawsToCsv(draws)
    const header = csv.split('\n')[0].split(',')
    expect(header).toContain('Jackpot')
    expect(header).toContain('Winner Location')
    // every row must carry exactly as many fields as the header declares
    const rows = csv.split('\n').slice(1)
    for (const r of rows) expect(splitDelimited(r)[0]).toHaveLength(header.length)
    const back = parseDelimitedText(csv)
    expect(back.errors).toEqual([])
    const won = back.draws.find((d) => d.date === '2026-07-27')!
    expect(won.jackpot).toBe(980_000_000)
    expect(won.winnerLocation).toBe('Middlebury, VT')
    expect(back.draws.find((d) => d.date === '2026-07-29')!.winnerLocation).toBeUndefined()
  })

  it("reads the Louisiana Lottery CSV layout: pb_ball is the bonus, multiplier and cash value are not numbers", () => {
    // Exact header/row shape from https://louisianalottery.com/csv/powerball.csv
    const text = [
      'pb_drawing_date,pb_number_1,pb_number_2,pb_number_3,pb_number_4,pb_number_5,pb_ball,pb_jackpot,pb_jackpot_win_loc,pb_multi,pb_cash_value',
      '2026-07-29,30,36,40,42,57,2,667700000,,2,292500000',
      '2026-07-27,6,26,46,58,65,25,637800000,,2,279300000',
      '2015-03-25,7,19,23,50,54,14,40000000,"New Jersey",2,26845638',
      // the file appends a second table whose rows have no date — must be ignored
      ',,,,,,,,,,',
      ',4082,2025-09-08,20000000,9200000,6,,,,,',
    ].join('\n')
    const out = parseDelimitedText(text)
    expect(out.errors).toEqual([])
    expect(out.drawSize).toBe(5)
    expect(out.hasSpecial).toBe(true)
    expect(out.draws).toHaveLength(3)
    const newest = out.draws[out.draws.length - 1]
    // the multiplier (2) must NOT have been absorbed as a sixth main number
    expect(newest.sorted).toEqual([30, 36, 40, 42, 57])
    expect(newest.special).toBe(2)
    expect(newest.jackpot).toBe(667_700_000)
    const won = out.draws.find((d) => d.date === '2015-03-25')!
    expect(won.winnerLocation).toBe('New Jersey')
    expect(won.special).toBe(14)
  })

  it('reads the Mega Millions CSV layout, where the multiplier sits before the jackpot', () => {
    const text = [
      'mm_drawing_date,mm_number_1,mm_number_2,mm_number_3,mm_number_4,mm_number_5,mm_ball,mm_multi,mm_jackpot,mm_jackpot_win_loc,mm_cash_value',
      '2026-07-28,34,48,49,59,70,12,,800000000,Florida,344200000',
      '2026-07-24,2,5,42,44,60,1,,743000000,,323400000',
    ].join('\n')
    const out = parseDelimitedText(text)
    expect(out.errors).toEqual([])
    expect(out.drawSize).toBe(5)
    expect(out.hasSpecial).toBe(true)
    const first = out.draws.find((d) => d.date === '2026-07-28')!
    expect(first.sorted).toEqual([34, 48, 49, 59, 70])
    expect(first.special).toBe(12)
    expect(first.jackpot).toBe(800_000_000)
    expect(first.winnerLocation).toBe('Florida')
  })

  it('appending a jackpot CSV enriches draws already synced from the results API', () => {
    const synced = [{ ...D('2026-07-29', [30, 36, 40, 42, 57]), special: 2 }]
    const fromCsv = parseDelimitedText([
      'pb_drawing_date,pb_number_1,pb_number_2,pb_number_3,pb_number_4,pb_number_5,pb_ball,pb_jackpot,pb_jackpot_win_loc,pb_multi,pb_cash_value',
      '2026-07-29,30,36,40,42,57,2,667700000,"Lake Charles, LA",2,292500000',
    ].join('\n')).draws
    const { merged, added } = mergeDraws(synced, fromCsv)
    expect(added).toBe(0)
    expect(merged).toHaveLength(1)
    expect(merged[0].jackpot).toBe(667_700_000)
    expect(merged[0].winnerLocation).toBe('Lake Charles, LA')
  })

  it('sales rows map to a date lookup and attach only where dates line up', () => {
    const sales = parseSalesRows([
      { bus_day: '2026-07-29T00:00:00.000', total: '2299478' },
      { bus_day: '2026-07-28T00:00:00.000', total: '928668' },
      { bus_day: 'bad', total: '5' },
      { bus_day: '2026-07-27T00:00:00.000', total: '0' },
    ])
    expect(sales.size).toBe(2)
    expect(sales.get('2026-07-29')).toBe(2299478)
    const draws = [D('2026-07-29', [1, 2, 3, 4, 5]), D('2026-07-27', [6, 7, 8, 9, 10])]
    const { draws: withSales, matched } = attachSales(draws, sales)
    expect(matched).toBe(1)
    expect(withSales[0].sales).toBe(2299478)
    expect(withSales[1].sales).toBeUndefined()
  })

  it('merging the same draw again fills in jackpot/location/sales without duplicating', () => {
    const base = [D('2026-07-27', [6, 26, 46, 58, 65])]
    const richer = [{ ...D('2026-07-27', [6, 26, 46, 58, 65]), jackpot: 9.8e8, winnerLocation: 'VT', sales: 123 }]
    const { merged, added, skipped } = mergeDraws(base, richer)
    expect(added).toBe(0)
    expect(skipped).toBe(1)
    expect(merged).toHaveLength(1)
    expect(merged[0].jackpot).toBe(9.8e8)
    expect(merged[0].winnerLocation).toBe('VT')
    expect(merged[0].sales).toBe(123)
  })

  it('summarises jackpots and finds no link between jackpot size and the numbers', () => {
    const draws = fairRandomDraws(11, 240, 69, 5).map((d, i) => ({
      ...d,
      // jackpot unrelated to the numbers, so the test must come back null-effect
      jackpot: 20_000_000 + (i % 30) * 40_000_000,
      ...(i === 239 ? { winnerLocation: 'Buffalo NY' } : {}),
    }))
    const j = analyzeJackpots(draws)
    expect(j.withJackpot).toBe(240)
    expect(j.biggest!.amount).toBe(20_000_000 + 29 * 40_000_000)
    expect(j.winners).toHaveLength(1)
    expect(j.rolloverRun).toBe(0)
    expect(j.jackpotVsNumbers).not.toBeNull()
    expect(Math.abs(j.jackpotVsNumbers!.t)).toBeLessThan(2)
  })

  it('ticket value: bigger jackpots raise EV, and heavy sales discount it for sharing', () => {
    const solo = ticketValue(69, 5, 26, 100_000_000, null, 2, US_LOWER_TIERS)
    const bigger = ticketValue(69, 5, 26, 900_000_000, null, 2, US_LOWER_TIERS)
    expect(bigger.grossEv).toBeGreaterThan(solo.grossEv)
    expect(solo.splitChance).toBeNull()
    const crowded = ticketValue(69, 5, 26, 900_000_000, 400_000_000, 2, US_LOWER_TIERS)
    expect(crowded.splitChance).toBeGreaterThan(0.7)
    expect(crowded.adjustedEv).toBeLessThan(bigger.grossEv)
    expect(bigger.jackpotOdds).toBe(292_201_338)
  })
})

describe('draw countdown', () => {
  it('resolves the official draw time through daylight saving', () => {
    // Powerball draws 22:59 America/New_York. In August that is UTC-4 -> 02:59Z next day
    const summer = nextDrawInstant('2026-08-01', 'powerball')!
    expect(summer.toISOString()).toBe('2026-08-02T02:59:00.000Z')
    // In January it is UTC-5 -> 03:59Z next day
    const winter = nextDrawInstant('2026-01-10', 'powerball')!
    expect(winter.toISOString()).toBe('2026-01-11T03:59:00.000Z')
    // Mega Millions draws one minute later
    expect(nextDrawInstant('2026-08-04', 'megamillions')!.toISOString()).toBe('2026-08-05T03:00:00.000Z')
    // a game with no official time falls back to a local wall-clock time, so
    // imported and custom games still get a live countdown
    const custom = nextDrawInstant('2026-08-01', undefined, '20:30')!
    expect(custom.getFullYear()).toBe(2026)
    expect(custom.getHours()).toBe(20)
    expect(custom.getMinutes()).toBe(30)
    expect(nextDrawInstant('not-a-date', undefined)).toBeNull()
    // and the label names whichever clock is in play
    expect(drawTimeLabel('powerball')).toBe('10:59 PM ET')
    expect(drawTimeLabel(undefined, '20:30')).toBe('8:30 PM')
  })

  it('counts down and flips to past after the draw moment', () => {
    const target = new Date('2026-08-02T02:59:00.000Z')
    const c = countdownTo(target, Date.parse('2026-07-30T22:00:00.000Z'))
    expect(c.past).toBe(false)
    expect(c.days).toBe(2)
    expect(c.hours).toBe(4)
    expect(c.minutes).toBe(59)
    expect(formatCountdown(c)).toBe('2d 04:59:00')
    const inside = countdownTo(target, Date.parse('2026-08-02T00:30:30.000Z'))
    expect(inside.days).toBe(0)
    expect(formatCountdown(inside)).toBe('02:28:30')
    expect(countdownTo(target, Date.parse('2026-08-02T03:00:00.000Z')).past).toBe(true)
  })

  it('projects the next jackpot from rollovers, and from resets after a win', () => {
    const base = fairRandomDraws(21, 12, 69, 5)
    // a clean roll-up of +$20M per draw, no winner yet
    const rolling = base.map((d, i) => ({ ...d, jackpot: 100_000_000 + i * 20_000_000 }))
    const roll = projectNextJackpot(rolling)!
    expect(roll.basis).toBe('rollover')
    expect(roll.amount).toBe(rolling[rolling.length - 1].jackpot! + 20_000_000)

    // once the latest draw has a winner, the next prize resets instead
    const won = rolling.map((d, i) => (i === 3 || i === rolling.length - 1 ? { ...d, winnerLocation: 'Texas' } : d))
    const reset = projectNextJackpot(won)!
    expect(reset.basis).toBe('reset')
    expect(reset.amount).toBe(won[4].jackpot)

    expect(projectNextJackpot(base)).toBeNull() // no jackpot data at all
  })
})

describe('weekday significance', () => {
  it('reports ordinary variation on fair draws and flags a planted bias', () => {
    const fair = runEngine(fairRandomDraws(3, 600, 49, 6), DEFAULT_SETTINGS)
    expect(fair.weekdayTest.length).toBeGreaterThan(0)
    for (const t of fair.weekdayTest) expect(Math.abs(t.z)).toBeLessThan(3)

    // Force number 7 into every Friday draw — the test must notice
    const rigged = fairRandomDraws(4, 600, 49, 6).map((d) => {
      if (d.dow !== 5) return d
      const nums = [7, ...d.sorted.filter((n) => n !== 7)].slice(0, 6)
      return { ...d, numbers: [...nums].sort((a, b) => a - b), sorted: [...nums].sort((a, b) => a - b) }
    })
    const res = runEngine(rigged, DEFAULT_SETTINGS)
    const fri = res.weekdayTest.find((t) => t.dow === 5)
    expect(fri).toBeDefined()
    expect(fri!.z).toBeGreaterThan(3)
  })
})

describe('odds math', () => {
  it('reproduces the published Powerball odds', () => {
    expect(choose(69, 5)).toBe(11238513)
    expect(jackpotOdds(69, 5, 26)).toBe(292201338)
    expect(Math.round(matchOdds(69, 5, 5))).toBe(11238513)
    const dist = hitDistribution(69, 5, 5)
    expect(dist.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    // catching zero is the most likely outcome for any 5-of-69 pick
    expect(dist[0]).toBeGreaterThan(0.6)
    expect(dist[1]).toBeGreaterThan(0.2)
  })
})

describe('official results sync parsing', () => {
  it('maps Powerball Socrata rows (mains + PB in one field)', () => {
    const out = parseSocrataRows([
      { draw_date: '2026-07-29T00:00:00.000', winning_numbers: '30 36 40 42 57 02' },
      { draw_date: '2026-07-25T00:00:00.000', winning_numbers: '03 04 24 36 47 17' },
      { draw_date: 'bad', winning_numbers: '1 2 3 4 5 6' },
    ], 'powerball')
    expect(out.draws).toHaveLength(2)
    expect(out.hasSpecial).toBe(true)
    expect(out.draws[1]).toMatchObject({ date: '2026-07-29', sorted: [30, 36, 40, 42, 57], special: 2, dow: 3 })
  })
  it('maps Mega Millions rows (mega_ball separate)', () => {
    const out = parseSocrataRows([
      { draw_date: '2026-07-28T00:00:00.000', winning_numbers: '10 20 30 40 50', mega_ball: '7' },
    ], 'megamillions')
    expect(out.draws).toHaveLength(1)
    expect(out.draws[0]).toMatchObject({ sorted: [10, 20, 30, 40, 50], special: 7 })
  })
})

describe('multi-game model', () => {
  it('migrates a legacy Powerball-shaped history with sync enabled', () => {
    const draws: Draw[] = [
      { ...D('2026-07-27', [6, 26, 46, 58, 65]), special: 25 },
      { ...D('2026-07-25', [3, 4, 24, 36, 47]), special: 17 },
    ]
    const out = migrateLegacy(draws, DEFAULT_SETTINGS)
    expect(out).not.toBeNull()
    expect(out!.games).toHaveLength(1)
    expect(out!.games[0]).toMatchObject({ name: 'Powerball', syncKey: 'powerball' })
    expect(out!.activeId).toBe(out!.games[0].id)
  })
  it('migrates an unknown-shaped history without a sync source', () => {
    const draws: Draw[] = [D('2026-07-27', [6, 26, 46, 58, 65, 12])]
    const out = migrateLegacy(draws, null)
    expect(out!.games[0].syncKey).toBeUndefined()
    expect(out!.games[0].name).toBe('My game')
  })
  it('returns null with nothing to migrate, and creates clean games', () => {
    expect(migrateLegacy(null, null)).toBeNull()
    expect(migrateLegacy([], DEFAULT_SETTINGS)).toBeNull()
    const g = createGame('powerball', 'Powerball', 'powerball')
    expect(g.draws).toHaveLength(0)
    expect(g.syncKey).toBe('powerball')
    expect(daysSinceLastDraw(g, Date.now())).toBe(Infinity)
  })
})

describe('era detection', () => {
  const seeded = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }

  /** A history of `n` draws where the pools change at `changeAt`. */
  const withEraChange = (
    n: number, changeAt: number,
    early: { main: number; special: number }, late: { main: number; special: number },
  ): Draw[] => {
    const rand = seeded(4242)
    const draws: Draw[] = []
    for (let i = 0; i < n; i++) {
      const rules = i < changeAt ? early : late
      const mains = new Set<number>()
      while (mains.size < 5) mains.add(1 + Math.floor(rand() * rules.main))
      const dt = new Date(2010, 0, 1 + Math.floor(i / 3) * 7 + [0, 2, 5][i % 3])
      const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
      const sorted = [...mains].sort((a, b) => a - b)
      const draw: Draw = { date: iso, dow: dt.getDay(), numbers: sorted, sorted }
      if (rules.special > 0) draw.special = 1 + Math.floor(rand() * rules.special)
      draws.push(draw)
    }
    return draws
  }

  it('finds a pool that grew, from the long stretch that never reaches the new top', () => {
    const draws = withEraChange(900, 450, { main: 59, special: 0 }, { main: 69, special: 0 })
    const era = detectEra(draws)!
    expect(era).not.toBeNull()
    expect(era.earlyMax).toBeLessThanOrEqual(59)
    expect(era.currentMax).toBe(69)
    expect(era.cutoffIndex).toBeGreaterThanOrEqual(430)
    expect(era.cutoffIndex).toBeLessThanOrEqual(470)
    expect(era.kept + era.excluded).toBe(900)
  })

  it('finds a bonus pool that shrank — the Powerball 2015 case', () => {
    // mains 59 -> 69 and the bonus ball 35 -> 26 on the same day
    const draws = withEraChange(900, 450, { main: 59, special: 35 }, { main: 69, special: 26 })
    const era = detectEra(draws)!
    expect(era.currentSpecialMax).toBe(26)
    expect(era.earlySpecialMax).toBeGreaterThan(26)
    // The last draw exceeding the new bonus pool comes weeks before the change,
    // so the boundary must be refined forward — never earlier than the real one.
    expect(era.cutoffIndex).toBeGreaterThanOrEqual(450)
    expect(era.cutoffIndex).toBeLessThanOrEqual(453)
    // no draw in the kept era may be impossible under the current rules
    for (const d of draws.slice(era.cutoffIndex)) {
      expect(Math.max(...d.sorted)).toBeLessThanOrEqual(69)
      expect(d.special!).toBeLessThanOrEqual(26)
    }
  })

  it('stays quiet on a stable pool', () => {
    expect(detectEra(generateSampleDraws())).toBeNull()
    expect(detectEra(withEraChange(600, 600, { main: 69, special: 26 }, { main: 69, special: 26 }))).toBeNull()
  })

  it('refuses to split when it would leave too little history', () => {
    expect(detectEra(withEraChange(300, 260, { main: 59, special: 0 }, { main: 69, special: 0 }))).toBeNull()
    expect(detectEra([])).toBeNull()
  })

  it('filters without ever mutating or deleting the stored history', () => {
    const draws = withEraChange(900, 450, { main: 59, special: 35 }, { main: 69, special: 26 })
    const era = detectEra(draws)!
    const current = drawsForEra(draws, 'current', era)
    expect(current).toHaveLength(era.kept)
    expect(drawsForEra(draws, 'all', era)).toHaveLength(900)
    // the source array is untouched, so switching back in Settings restores everything
    expect(draws).toHaveLength(900)
    expect(drawsForEra(draws, 'current', null)).toHaveLength(900)
  })

  it('shrinks the detected pools to the current rules, which is what fixes the odds', () => {
    const draws = withEraChange(900, 450, { main: 59, special: 35 }, { main: 69, special: 26 })
    const all = runEngine(draws, { ...DEFAULT_SETTINGS, era: 'all' })
    const current = runEngine(drawsForEra(draws, 'current', detectEra(draws)), DEFAULT_SETTINGS)
    expect(all.special!.K).toBe(35)
    expect(current.special!.K).toBe(26)
    expect(current.drawCount).toBeLessThan(all.drawCount)
  })
})

describe('full engine', () => {
  const sample = generateSampleDraws()
  const res = runEngine(sample, DEFAULT_SETTINGS)

  it('produces a complete, coherent 6-number result', () => {
    expect(res.ok).toBe(true)
    expect(res.K).toBe(49)
    expect(res.drawSize).toBe(6)
    expect(res.topPick).toHaveLength(6)
    expect(res.top10).toHaveLength(10)
    expect(res.predictions).toHaveLength(49)
    expect(res.predictions[0].rank).toBe(1)
    expect(res.predictions[0].probability).toBeGreaterThanOrEqual(res.predictions[9].probability)
    expect(res.bestCombo).not.toBeNull()
    expect(res.bestCombo!.numbers).toHaveLength(6)
    expect(new Set(res.bestCombo!.numbers).size).toBe(6)
    expect(res.altCombos.length).toBeGreaterThan(0)
    expect(res.similar.length).toBeGreaterThan(0)
    expect(res.hot.length).toBeGreaterThan(0)
    expect(res.pairs.length).toBeGreaterThan(0)
    expect(res.scheduleDows).toEqual([1, 3, 6])
    // last sample draw is Mon 2026-07-27 -> next scheduled is Wed 2026-07-29
    expect(res.nextDate).toBe('2026-07-29')
    expect(res.nextDow).toBe(3)
  })

  it('estimated probabilities are calibrated (sum roughly to 6 numbers per draw)', () => {
    const total = res.predictions.reduce((s, p) => s + p.probability, 0)
    expect(total).toBeGreaterThan(4.5)
    expect(total).toBeLessThan(7.5)
  })

  it('every top prediction explains itself', () => {
    for (const p of res.top10) {
      expect(p.contributions.length).toBeGreaterThan(0)
      // at least one positively contributing signal must carry a human-readable reason
      expect(p.contributions.some((c) => c.contribution > 0 && c.reason)).toBe(true)
      expect(['High', 'Medium', 'Low']).toContain(p.confidence)
    }
  })

  it('still analyzes 5-number histories (auto-detected)', () => {
    const five = sample.slice(0, 120).map((d) => ({
      date: d.date,
      dow: d.dow,
      numbers: d.sorted.slice(0, 5),
      sorted: d.sorted.slice(0, 5),
    }))
    const r = runEngine(five, DEFAULT_SETTINGS)
    expect(r.ok).toBe(true)
    expect(r.drawSize).toBe(5)
    expect(r.topPick).toHaveLength(5)
    expect(r.bestCombo!.numbers).toHaveLength(5)
  })

  it('rejects mixed draw sizes with a clear message', () => {
    const mixed = [...sample.slice(0, 30), D('2026-07-28', [1, 2, 3, 4, 5])]
    const r = runEngine(mixed, DEFAULT_SETTINGS)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/mixes draws/)
  })

  it('refuses tiny datasets gracefully', () => {
    const r = runEngine(sample.slice(0, 5), DEFAULT_SETTINGS)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/at least/)
  })

  it('uses uniform signal weights when history is too short to backtest (12-30 draws)', () => {
    const r = runEngine(sample.slice(0, 20), DEFAULT_SETTINGS)
    expect(r.ok).toBe(true)
    expect(r.backtest.evaluated).toBe(0)
    // signals must actually contribute — an empty weight map would zero every
    // score and rank numbers 1,2,3,... purely by the numeric tie-break
    expect(r.topPick.some((p) => p.score !== 0)).toBe(true)
    expect(r.predictions[0].contributions.some((c) => c.contribution !== 0)).toBe(true)
    expect(r.topPick.map((p) => p.number)).not.toEqual([1, 2, 3, 4, 5, 6])
    for (const p of r.top10) expect(p.confidence).toBe('Low')
  })
})
