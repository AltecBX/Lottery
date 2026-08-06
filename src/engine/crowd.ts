/**
 * Combinations lots of other people also play.
 *
 * Everything else in this app is about which numbers come up, and the honest
 * answer there is always the same: nothing changes the odds. This file is about
 * the one quantity a player genuinely controls, which is not whether a ticket
 * wins but what it pays when it does. A jackpot is split between everyone
 * holding it, so two tickets with identical odds are worth different amounts
 * the moment one of them is a combination thousands of other people also chose.
 *
 * The markers below are facts about a combination, not claims about how often
 * it is drawn. "Every number is 31 or lower" says a ticket can be filled in
 * entirely from birthdays and anniversaries; it says nothing whatsoever about
 * that ticket's chance of coming up, which is exactly the chance of every other
 * combination. Draws like that happen at their proper rate and always will —
 * 1 in 66 for the calendar range on a 5/69 game — and the panel says so.
 *
 * The reason this is worth acting on is that acting on it is free. Preferring a
 * combination without a marker costs nothing, because every combination is
 * equally likely; it only removes the co-winners. That is the whole argument,
 * and it needs no estimate of how many people play birthdays to hold. The app
 * already applied it to past jackpot combinations for the same reason.
 */

export interface CrowdMarker {
  key: string
  /** Chip-sized label */
  label: string
  /** One line: what the combination is, and why others land on it */
  note: string
}

/** Highest number reachable from a day of the month. */
export const CALENDAR_MAX = 31

const isRun = (s: number[]): boolean => s.every((v, i) => i === 0 || v === s[i - 1] + 1)

const step = (s: number[]): number | null => {
  if (s.length < 3) return null
  const d = s[1] - s[0]
  return s.every((v, i) => i === 0 || v - s[i - 1] === d) ? d : null
}

/**
 * Every reason this combination is likely to be on other people's tickets too.
 * Empty for the overwhelming majority of combinations, which is the point.
 */
export function crowdMarkers(sorted: number[], K: number, pastWinners?: Set<string>): CrowdMarker[] {
  const out: CrowdMarker[] = []
  const s = [...sorted].sort((a, b) => a - b)
  if (s.length === 0) return out

  if (pastWinners?.has(s.join('-'))) {
    out.push({
      key: 'pastWinner',
      label: 'Drawn before',
      note: 'This exact combination has won before. Combinations with a story get replayed by people who remember them.',
    })
  }

  // Dates. The narrowest form first, so a ticket only ever carries one of these.
  if (s[s.length - 1] <= 12) {
    out.push({
      key: 'months',
      label: 'All 1–12',
      note: 'Every number fits a month, so this can be filled in from a row of dates. A small range that a lot of people reach for.',
    })
  } else if (s[s.length - 1] <= CALENDAR_MAX && K > CALENDAR_MAX) {
    out.push({
      key: 'calendar',
      label: 'All 1–31',
      note: `Every number is a possible day of the month, so this ticket can be filled in entirely from birthdays. Numbers above ${CALENDAR_MAX} are chosen far less often, and that is where a jackpot stays yours.`,
    })
  }

  const d = step(s)
  if (isRun(s)) {
    out.push({
      key: 'run',
      label: 'A straight run',
      note: 'Consecutive numbers. People play these to prove a point about randomness, and enough of them do it together.',
    })
  } else if (d !== null && d > 0) {
    out.push({
      key: 'evenStep',
      label: `Every ${d} apart`,
      note: `An even progression stepping by ${d} — a pattern that reads as deliberate, and a lot of slips get filled in this way.`,
    })
  }

  if (s.every((n) => n % 5 === 0)) {
    out.push({
      key: 'fives',
      label: 'All multiples of 5',
      note: 'Round numbers are picked much more often than their share of the pool.',
    })
  }

  if (s.length > 1 && s.every((n) => n % 10 === s[0] % 10)) {
    out.push({
      key: 'sameDigit',
      label: 'All end the same',
      note: 'Every number ends in the same digit — a column on the slip, and an easy pattern to land on.',
    })
  }

  return out
}

/** A test the ticket dealer can use: true when nothing marks this as a crowded pick. */
export function uncrowded(K: number, pastWinners?: Set<string>): (sorted: number[]) => boolean {
  return (sorted: number[]) => crowdMarkers(sorted, K, pastWinners).length === 0
}

/**
 * How often this game actually produces a combination inside the calendar
 * range, counted from its own record. Included so the marker can never be read
 * as "this cannot come up" — it can, at exactly this rate.
 */
export function calendarRate(K: number, D: number, drawnSets: number[][]): { seen: number; of: number; expected: number } {
  let seen = 0
  for (const s of drawnSets) if (s.length > 0 && Math.max(...s) <= CALENDAR_MAX) seen++
  // C(31,D) / C(K,D), computed as a product to stay exact at lottery scale
  let expected = 1
  for (let i = 0; i < D; i++) expected *= (CALENDAR_MAX - i) / (K - i)
  return { seen, of: drawnSets.length, expected }
}
