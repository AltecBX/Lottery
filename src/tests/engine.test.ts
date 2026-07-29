import { describe, expect, it } from 'vitest'
import { parseDateToken } from '../engine/dates.ts'
import { mergeDraws, parseDelimitedText, rowsToDraws } from '../engine/parse.ts'
import { HistoryState } from '../engine/state.ts'
import { isotonicDecreasing, runBacktest } from '../engine/backtest.ts'
import { runEngine } from '../engine/engine.ts'
import { generateSampleDraws } from '../engine/sample.ts'
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
  it('parses the pipe format from the spec', () => {
    const text = 'Date | Day of Week | Number 1 | Number 2 | Number 3 | Number 4 | Number 5\n' +
      '3/30/2026 | Monday | 9 | 13 | 28 | 45 | 51\n' +
      '4/1/2026 | Wednesday | 2 | 9 | 17 | 33 | 40\n'
    const { draws, errors } = parseDelimitedText(text)
    expect(errors).toEqual([])
    expect(draws).toHaveLength(2)
    expect(draws[0]).toMatchObject({ date: '2026-03-30', dow: 1, sorted: [9, 13, 28, 45, 51] })
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
    expect(errors[0]).toMatch(/duplicate number/)
    expect(errors[1]).toMatch(/date/)
    expect(errors[2]).toMatch(/found 4 numbers/)
  })
  it('ignores extra columns and warns', () => {
    const out = rowsToDraws([['2026-03-30', '9', '13', '28', '45', '51', '12']])
    expect(out.draws[0].sorted).toEqual([9, 13, 28, 45, 51])
    expect(out.warnings.some((w) => w.includes('Extra columns'))).toBe(true)
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
    const s = new HistoryState(20)
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
    const mutated = [...draws.slice(0, 119), D('2026-12-28', [50, 51, 52, 53, 54])]
    const a = runBacktest(draws, 56, false)
    const b = runBacktest(mutated, 56, false)
    expect(a.summary.points.length).toBe(b.summary.points.length)
    for (let i = 0; i < a.summary.points.length - 1; i++) {
      expect(a.summary.points[i]).toEqual(b.summary.points[i])
    }
  })

  it('learns on the structured sample: ensemble beats chance and the rank calibration is monotone', () => {
    const bt = runBacktest(sample, 56, false)
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
})

describe('full engine', () => {
  const sample = generateSampleDraws()
  const res = runEngine(sample, DEFAULT_SETTINGS)

  it('produces a complete, coherent result', () => {
    expect(res.ok).toBe(true)
    expect(res.K).toBe(56)
    expect(res.top5).toHaveLength(5)
    expect(res.top10).toHaveLength(10)
    expect(res.predictions).toHaveLength(56)
    expect(res.predictions[0].rank).toBe(1)
    expect(res.predictions[0].probability).toBeGreaterThanOrEqual(res.predictions[9].probability)
    expect(res.bestCombo).not.toBeNull()
    expect(res.bestCombo!.numbers).toHaveLength(5)
    expect(new Set(res.bestCombo!.numbers).size).toBe(5)
    expect(res.altCombos.length).toBeGreaterThan(0)
    expect(res.similar.length).toBeGreaterThan(0)
    expect(res.hot.length).toBeGreaterThan(0)
    expect(res.pairs.length).toBeGreaterThan(0)
    expect(res.scheduleDows).toEqual([1, 3, 6])
    // last sample draw is Mon 2026-07-27 -> next scheduled is Wed 2026-07-29
    expect(res.nextDate).toBe('2026-07-29')
    expect(res.nextDow).toBe(3)
  })

  it('estimated probabilities are calibrated (sum roughly to 5 numbers per draw)', () => {
    const total = res.predictions.reduce((s, p) => s + p.probability, 0)
    expect(total).toBeGreaterThan(3.5)
    expect(total).toBeLessThan(6.5)
  })

  it('every top prediction explains itself', () => {
    for (const p of res.top10) {
      expect(p.contributions.length).toBeGreaterThan(0)
      // at least one positively contributing signal must carry a human-readable reason
      expect(p.contributions.some((c) => c.contribution > 0 && c.reason)).toBe(true)
      expect(['High', 'Medium', 'Low']).toContain(p.confidence)
    }
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
    expect(r.top5.some((p) => p.score !== 0)).toBe(true)
    expect(r.predictions[0].contributions.some((c) => c.contribution !== 0)).toBe(true)
    expect(r.top5.map((p) => p.number)).not.toEqual([1, 2, 3, 4, 5])
    for (const p of r.top10) expect(p.confidence).toBe('Low')
  })
})
