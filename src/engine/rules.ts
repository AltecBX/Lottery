import type { Draw } from './types.ts'
import { addDays, dowOf } from './dates.ts'

/**
 * The rules each drawing was held under, from the published record rather than
 * inferred from the numbers drawn.
 *
 * Era boundaries used to be read off the draws themselves — the first draw to
 * reach a number the old pool could not hold. That is the only option for a
 * game with no published history, and it is wrong in both directions for the
 * games that have one: it placed Powerball's 2015 change at 10 October when the
 * first 5/69 + 1/26 drawing was 7 October (that draw happened not to use a
 * number above 59), and Mega Millions' 2017 change at 24 October when the new
 * matrix began on the 31st, filing two old-matrix draws under the new rules.
 * Worse for a replay, inference cannot be done honestly at the moment of a
 * prediction: the first draw of a new era is the one that would reveal it. The
 * rule changes themselves were announced months ahead, so a schedule is what a
 * player at the time actually knew.
 *
 * Effective dates, not first drawings: every change took effect between two
 * drawings, so "the latest change on or before a drawing's date" is always the
 * matrix that drawing used. Sources: the operators' matrix histories as
 * summarised by Wikipedia's Powerball and Mega Millions articles (matrix
 * tables and the cited first-drawing dates), checked against the record itself
 * by `verifyHistory` — no draw in either published history falls outside the
 * matrix this table gives its date.
 */
export interface RuleSet {
  /** First day in force; every drawing on or after it, until the next entry, used these rules */
  from: string
  /** White-ball pool: numbers 1..K */
  K: number
  /** Bonus-ball pool: 1..specialK */
  specialK: number
  /** Weekdays drawings are held (0 = Sunday) */
  drawDays: number[]
}

export type RuleKey = 'powerball' | 'megamillions'

export const RULE_SCHEDULE: Record<RuleKey, RuleSet[]> = {
  powerball: [
    { from: '1992-04-22', K: 45, specialK: 45, drawDays: [3, 6] },
    { from: '1997-11-05', K: 49, specialK: 42, drawDays: [3, 6] },
    { from: '2002-10-09', K: 53, specialK: 42, drawDays: [3, 6] },
    { from: '2005-08-28', K: 55, specialK: 42, drawDays: [3, 6] },
    { from: '2009-01-07', K: 59, specialK: 39, drawDays: [3, 6] },
    // Only the red ball changed; the white-ball era runs on unbroken.
    { from: '2012-01-15', K: 59, specialK: 35, drawDays: [3, 6] },
    { from: '2015-10-04', K: 69, specialK: 26, drawDays: [3, 6] },
    // Monday drawings added; the matrix is unchanged.
    { from: '2021-08-23', K: 69, specialK: 26, drawDays: [1, 3, 6] },
  ],
  megamillions: [
    { from: '2002-05-15', K: 52, specialK: 52, drawDays: [2, 5] },
    { from: '2005-06-22', K: 56, specialK: 46, drawDays: [2, 5] },
    { from: '2013-10-19', K: 75, specialK: 15, drawDays: [2, 5] },
    { from: '2017-10-28', K: 70, specialK: 25, drawDays: [2, 5] },
    // Only the Mega Ball changed (25 -> 24, with the $5 ticket). Treating this
    // as a new era for the white balls threw away 7.5 years of 5/70 history.
    { from: '2025-04-05', K: 70, specialK: 24, drawDays: [2, 5] },
  ],
}

export const isRuleKey = (k: unknown): k is RuleKey => k === 'powerball' || k === 'megamillions'

/** The rules in force on a date, or null before the game began. */
export function rulesAt(key: RuleKey, date: string): RuleSet | null {
  const list = RULE_SCHEDULE[key]
  let found: RuleSet | null = null
  for (const r of list) if (r.from <= date) found = r
  return found
}

/**
 * The first day of the unbroken run of identical white-ball rules in force on
 * `date`. Main numbers and the bonus ball are separate machines with separate
 * pools, and they change independently — so each has its own era.
 */
export function mainsEraStart(key: RuleKey, date: string): string | null {
  return eraStart(key, date, (r) => r.K)
}

/** The first day of the unbroken run of identical bonus-ball rules in force on `date`. */
export function bonusEraStart(key: RuleKey, date: string): string | null {
  return eraStart(key, date, (r) => r.specialK)
}

function eraStart(key: RuleKey, date: string, field: (r: RuleSet) => number): string | null {
  const list = RULE_SCHEDULE[key]
  let at = -1
  for (let i = 0; i < list.length; i++) if (list[i].from <= date) at = i
  if (at < 0) return null
  const v = field(list[at])
  let start = at
  while (start > 0 && field(list[start - 1]) === v) start--
  return list[start].from
}

/** Scheduled drawings strictly after `after` and strictly before `before`, in date order. */
export function scheduledBetween(key: RuleKey, after: string, before: string): string[] {
  const out: string[] = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(after)) return out
  for (let day = addDays(after, 1); day < before; day = addDays(day, 1)) {
    const r = rulesAt(key, day)
    if (r && r.drawDays.includes(dowOf(day))) out.push(day)
  }
  return out
}

/**
 * Drawings whose results should be out by `today` and are absent from a
 * history ending at `latest`. Each drawing gets a day's grace — the morning
 * after, its result is a sync away rather than missing — so one counts as
 * overdue from the second day on. This is what lets a sync tell "nothing new
 * has been drawn" apart from "the source has not caught up".
 */
export function overdueDrawings(key: RuleKey, latest: string, today: string): string[] {
  return scheduledBetween(key, latest, addDays(today, -1))
}

/** One problem found in a history, tied to the draw it concerns. */
export interface HistoryIssue {
  date: string
  kind: 'out-of-range' | 'duplicate-date' | 'out-of-order' | 'off-schedule' | 'wrong-size' | 'before-game'
  detail: string
}

export interface HistoryCheck {
  issues: HistoryIssue[]
  /** Scheduled drawings between the first and last draw held that the history lacks */
  missing: string[]
  /** Dates of draws that must not be trained on or scored: they break their own era's rules */
  rejected: Set<string>
}

/**
 * Check a history against the rules each draw was held under: order,
 * duplicates, numbers inside that draw's own pools, drawing weekdays, and
 * scheduled drawings that are absent. A draw that breaks its own era's matrix
 * is a misread row, not a lottery result, so it is rejected — never trained on
 * or scored.
 */
export function verifyHistory(draws: Draw[], key: RuleKey, D = 5): HistoryCheck {
  const issues: HistoryIssue[] = []
  const rejected = new Set<string>()
  const seen = new Map<string, string>()
  for (let i = 0; i < draws.length; i++) {
    const d = draws[i]
    if (i > 0 && d.date < draws[i - 1].date) issues.push({ date: d.date, kind: 'out-of-order', detail: `follows ${draws[i - 1].date}` })
    const sig = `${d.sorted.join('-')}|${d.special ?? ''}`
    const prev = seen.get(d.date)
    if (prev !== undefined) {
      issues.push({ date: d.date, kind: 'duplicate-date', detail: prev === sig ? 'the same draw twice' : `two different results: ${prev} and ${sig}` })
      if (prev !== sig) rejected.add(d.date)
    }
    seen.set(d.date, sig)
    const r = rulesAt(key, d.date)
    if (!r) {
      issues.push({ date: d.date, kind: 'before-game', detail: 'dated before the game began' })
      rejected.add(d.date)
      continue
    }
    if (d.sorted.length !== D) {
      issues.push({ date: d.date, kind: 'wrong-size', detail: `${d.sorted.length} main numbers` })
      rejected.add(d.date)
    }
    const badMain = d.sorted.filter((n) => n < 1 || n > r.K)
    const badSpecial = d.special !== undefined && (d.special < 1 || d.special > r.specialK)
    if (badMain.length || badSpecial || new Set(d.sorted).size !== d.sorted.length) {
      issues.push({
        date: d.date,
        kind: 'out-of-range',
        detail: `rules on this date are 1–${r.K} + 1–${r.specialK}; got ${d.sorted.join('-')}${d.special !== undefined ? ` + ${d.special}` : ''}`,
      })
      rejected.add(d.date)
    }
    if (!r.drawDays.includes(dowOf(d.date))) {
      issues.push({ date: d.date, kind: 'off-schedule', detail: 'not a scheduled drawing day' })
    }
  }
  const missing: string[] = []
  if (draws.length > 1) {
    const have = new Set(draws.map((d) => d.date))
    for (let day = draws[0].date; day <= draws[draws.length - 1].date; day = addDays(day, 1)) {
      const r = rulesAt(key, day)
      if (r && r.drawDays.includes(dowOf(day)) && !have.has(day)) missing.push(day)
    }
  }
  return { issues, missing, rejected }
}
