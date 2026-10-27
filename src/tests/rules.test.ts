import { describe, expect, it } from 'vitest'
import { bonusEraStart, mainsEraStart, RULE_SCHEDULE, rulesAt, verifyHistory, type RuleKey } from '../engine/rules.ts'
import { runEngine } from '../engine/engine.ts'
import { DEFAULT_SETTINGS, type Draw } from '../engine/types.ts'
import { addDays, dowOf } from '../engine/dates.ts'

/**
 * A history that follows the schedule exactly: one draw on every scheduled
 * day from `from` to `to`, every number inside the pools in force that day.
 * `shape` can bend a draw so a test controls what the numbers reveal.
 */
function scheduledHistory(
  key: RuleKey, from: string, to: string, seed = 1,
  shape?: (date: string, K: number) => number[] | null,
): Draw[] {
  let a = seed >>> 0
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out: Draw[] = []
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const r = rulesAt(key, day)
    if (!r || !r.drawDays.includes(dowOf(day))) continue
    let sorted = shape?.(day, r.K) ?? null
    if (!sorted) {
      const bag = Array.from({ length: r.K }, (_, i) => i + 1)
      for (let j = 0; j < 5; j++) { const k = j + Math.floor(rnd() * (r.K - j)); [bag[j], bag[k]] = [bag[k], bag[j]] }
      sorted = bag.slice(0, 5).sort((x, y) => x - y)
    }
    out.push({ date: day, dow: dowOf(day), numbers: sorted, sorted, special: 1 + Math.floor(rnd() * r.specialK) })
  }
  return out
}

describe('the published rule schedule', () => {
  it('gives every drawing the matrix in force on its date', () => {
    expect(rulesAt('powerball', '1992-04-21')).toBeNull()
    // Changes take effect between drawings: the last 5/59 draw and the first 5/69
    expect(rulesAt('powerball', '2015-10-03')!.K).toBe(59)
    expect(rulesAt('powerball', '2015-10-07')!.K).toBe(69)
    expect(rulesAt('megamillions', '2017-10-27')!.K).toBe(75)
    expect(rulesAt('megamillions', '2017-10-31')!.K).toBe(70)
    expect(rulesAt('megamillions', '2025-04-08')!.specialK).toBe(24)
    for (const list of Object.values(RULE_SCHEDULE)) {
      for (let i = 1; i < list.length; i++) expect(list[i].from > list[i - 1].from).toBe(true)
    }
  })

  it('keeps the white-ball era and the bonus era apart', () => {
    // Mega Millions' 2025 change and Powerball's 2012 change touched only the
    // bonus ball, so neither ends the white-ball era.
    expect(mainsEraStart('megamillions', '2026-10-23')).toBe('2017-10-28')
    expect(bonusEraStart('megamillions', '2026-10-23')).toBe('2025-04-05')
    expect(mainsEraStart('powerball', '2013-06-01')).toBe('2009-01-07')
    expect(bonusEraStart('powerball', '2013-06-01')).toBe('2012-01-15')
    // Powerball's 2021 Monday drawings changed the calendar, not the matrix
    expect(mainsEraStart('powerball', '2026-10-26')).toBe('2015-10-04')
    expect(bonusEraStart('powerball', '2026-10-26')).toBe('2015-10-04')
  })
})

describe('checking a history against its own rules', () => {
  const clean = scheduledHistory('powerball', '2015-08-01', '2015-12-31', 7)

  it('passes a history that follows the schedule', () => {
    const check = verifyHistory(clean, 'powerball')
    expect(check.issues).toEqual([])
    expect(check.missing).toEqual([])
    expect(check.rejected.size).toBe(0)
  })

  it('rejects a draw that breaks the matrix of its own date', () => {
    // 65 is a legal number today and was not on 2015-09-05
    const i = clean.findIndex((d) => d.date === '2015-09-05')
    const bad = clean.map((d, j) => (j === i ? { ...d, numbers: [3, 10, 20, 30, 65], sorted: [3, 10, 20, 30, 65] } : d))
    const check = verifyHistory(bad, 'powerball')
    expect([...check.rejected]).toEqual(['2015-09-05'])
    expect(check.issues[0]).toMatchObject({ date: '2015-09-05', kind: 'out-of-range' })
  })

  it('rejects a date two sources disagree about, and lets an exact repeat pass', () => {
    const i = clean.findIndex((d) => d.date === '2015-10-10')
    const conflict = [...clean.slice(0, i + 1), { ...clean[i], special: clean[i].special === 1 ? 2 : 1 }, ...clean.slice(i + 1)]
    const c = verifyHistory(conflict, 'powerball')
    expect(c.rejected.has('2015-10-10')).toBe(true)
    expect(c.issues.find((x) => x.kind === 'duplicate-date')!.detail).toMatch(/two different results/)

    const repeat = [...clean.slice(0, i + 1), { ...clean[i] }, ...clean.slice(i + 1)]
    const r = verifyHistory(repeat, 'powerball')
    expect(r.rejected.size).toBe(0)
    expect(r.issues.map((x) => x.kind)).toEqual(['duplicate-date'])
  })

  it('names every scheduled drawing the history is missing', () => {
    const gappy = clean.filter((d) => d.date !== '2015-11-04' && d.date !== '2015-11-07')
    expect(verifyHistory(gappy, 'powerball').missing).toEqual(['2015-11-04', '2015-11-07'])
  })

  it('flags a draw on a day the game does not draw, without rejecting it', () => {
    const odd = [...clean, { ...clean[clean.length - 1], date: '2016-01-07', dow: dowOf('2016-01-07') }]
    const check = verifyHistory(odd, 'powerball')
    expect(check.issues.map((x) => x.kind)).toContain('off-schedule')
    expect(check.rejected.size).toBe(0)
  })
})

describe('the engine takes its rules from the schedule', () => {
  it('starts the era on the rule change, not on the first draw that happens to reveal it', () => {
    /*
     * Powerball's first 5/69 drawing, 2015-10-07, used nothing above 59, so
     * inferring the era from the numbers placed it three days late and scored
     * a new-matrix draw against the old one. The schedule knew in advance.
     */
    const history = scheduledHistory('powerball', '2014-01-01', '2017-06-30', 3, (date) =>
      date === '2015-10-07' ? [4, 18, 27, 41, 55] : date === '2015-10-10' ? [6, 13, 29, 47, 66] : null)
    const scheduled = runEngine(history, { ...DEFAULT_SETTINGS, ruleKey: 'powerball' })
    expect(scheduled.rules).toMatchObject({ source: 'schedule', mainsFrom: '2015-10-04', K: 69, specialK: 26 })
    expect(scheduled.firstDate).toBe('2015-10-07')
    // Inference needs a number the old pool could not hold, so it starts late
    const inferred = runEngine(history, DEFAULT_SETTINGS)
    expect(inferred.rules!.source).toBe('inferred')
    expect(inferred.firstDate).toBe('2015-10-10')
  })

  it('keeps the white-ball era across a bonus-only change and blanks the old bonus balls', () => {
    const history = scheduledHistory('megamillions', '2023-01-01', '2026-06-30', 5)
    const res = runEngine(history, { ...DEFAULT_SETTINGS, ruleKey: 'megamillions' })
    expect(res.rules).toMatchObject({ mainsFrom: '2017-10-28', bonusFrom: '2025-04-05', K: 70, specialK: 24 })
    // Every 5/70 draw in the file is learned from, not just the 24-ball ones
    expect(res.drawCount).toBe(history.length)
    expect(res.special!.K).toBe(24)
    // and the bonus model is only ever scored on the current bonus pool
    for (const p of res.backtest.points) if (p.specialActual !== undefined) expect(p.date >= '2025-04-05').toBe(true)
  })

  it('never trains on or scores a date its sources disagree about', () => {
    const history = scheduledHistory('powerball', '2019-01-01', '2021-12-31', 9)
    const i = history.findIndex((d) => d.date === '2020-06-03')
    const conflict = [...history.slice(0, i + 1), { ...history[i], special: history[i].special === 1 ? 2 : 1 }, ...history.slice(i + 1)]
    const res = runEngine(conflict, { ...DEFAULT_SETTINGS, ruleKey: 'powerball' })
    expect(res.dataHealth!.rejected.map((r) => r.date)).toEqual(['2020-06-03'])
    expect(res.drawCount).toBe(history.length - 1)
    expect(res.backtest.points.some((p) => p.date === '2020-06-03')).toBe(false)
  })
})
