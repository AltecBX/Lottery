import { describe, expect, it } from 'vitest'
import powerballPage from './fixtures/powerball-next-drawing.html?raw'
import megaMillionsPayload from './fixtures/megamillions-latest.json?raw'
import {
  feedJackpotFor,
  feedUrl,
  isPlausibleEntry,
  isoDateInZone,
  parseMegaMillionsPayload,
  parsePowerballPage,
  type JackpotFeed,
} from '../engine/feed.ts'
import { buildLedger, gradeTicket } from '../engine/ticket.ts'
import { buildPortfolio, lowerTierValue, scorePortfolio } from '../engine/portfolio.ts'
import { flipUnits } from '../components/FlipClock.tsx'
import { resolveNextDraw } from '../components/NextDraw.tsx'
import { countdownTo } from '../engine/drawtime.ts'
import type { Draw } from '../engine/types.ts'

const D = (date: string, numbers: number[], special?: number, jackpot?: number): Draw => {
  const draw: Draw = { date, dow: 0, numbers, sorted: [...numbers].sort((a, b) => a - b) }
  if (special !== undefined) draw.special = special
  if (jackpot !== undefined) draw.jackpot = jackpot
  return draw
}

describe('official jackpot feed', () => {
  it('reads the prize and the exact draw instant off the Powerball page', () => {
    const entry = parsePowerballPage(powerballPage)!
    expect(entry.game).toBe('powerball')
    expect(entry.jackpot).toBe(707_000_000)
    expect(entry.cashValue).toBe(309_700_000)
    // 2026-08-02T02:59Z is 10:59 PM Eastern on Aug 1 — the date must be the local one
    expect(entry.drawDate).toBe('2026-08-01')
    expect(entry.drawInstant).toBe('2026-08-02T02:59:00.000Z')
    expect(isPlausibleEntry(entry)).toBe(true)
  })

  it('never mistakes the winners card for the next-draw card', () => {
    const html = powerballPage
    // Everything after the next-draw block is a different card with its own amounts
    const trimmed = `${html}<span class="game-jackpot-number">$2 Billion</span>`
    expect(parsePowerballPage(trimmed)!.jackpot).toBe(707_000_000)
    expect(parsePowerballPage('<html><body>no card here</body></html>')).toBeNull()
  })

  it('reads Mega Millions next prize pool and next drawing time', () => {
    const entry = parseMegaMillionsPayload(megaMillionsPayload)!
    expect(entry.game).toBe('megamillions')
    expect(entry.jackpot).toBe(50_000_000)
    expect(entry.cashValue).toBe(21_500_000)
    expect(entry.drawDate).toBe('2026-07-31')
    // 11:00 PM Eastern in July is UTC-4
    expect(entry.drawInstant).toBe('2026-08-01T03:00:00.000Z')
  })

  it('returns null rather than throwing on junk', () => {
    expect(parseMegaMillionsPayload('not json')).toBeNull()
    expect(parseMegaMillionsPayload('{"d":"{}"}')).toBeNull()
    expect(parseMegaMillionsPayload(JSON.stringify({ d: JSON.stringify({ Jackpot: { NextPrizePool: 0 } }) }))).toBeNull()
  })

  it('rejects implausible amounts', () => {
    expect(isPlausibleEntry(null)).toBe(false)
    expect(isPlausibleEntry({ game: 'powerball', drawDate: '2026-08-01', jackpot: 12, source: '' })).toBe(false)
    expect(isPlausibleEntry({ game: 'powerball', drawDate: 'soon', jackpot: 4e8, source: '' })).toBe(false)
  })

  it('only serves a feed entry to the draw it belongs to', () => {
    const feed: JackpotFeed = {
      updated: '2026-07-31T10:00:00Z',
      games: { powerball: { game: 'powerball', drawDate: '2026-08-01', jackpot: 7.07e8, source: '' } },
    }
    expect(feedJackpotFor(feed, 'powerball', '2026-08-01')!.jackpot).toBe(7.07e8)
    // a stale feed must never price a different draw
    expect(feedJackpotFor(feed, 'powerball', '2026-08-03')).toBeNull()
    expect(feedJackpotFor(feed, 'megamillions', '2026-08-01')).toBeNull()
    expect(feedJackpotFor(null, 'powerball', '2026-08-01')).toBeNull()
    expect(feedJackpotFor(feed, undefined, '2026-08-01')).toBeNull()
  })

  it('asks for the feed next to the page, not at the site root', () => {
    // GitHub Pages serves this app from /Lottery/ — a root-relative URL 404s there
    expect(feedUrl('https://altecbx.github.io/Lottery/', 42))
      .toBe('https://altecbx.github.io/Lottery/jackpots.json?t=42')
    expect(feedUrl('https://altecbx.github.io/Lottery/index.html', 42))
      .toBe('https://altecbx.github.io/Lottery/jackpots.json?t=42')
    expect(feedUrl('http://localhost:4173/', 42)).toBe('http://localhost:4173/jackpots.json?t=42')
  })

  it('converts instants to the right calendar date across a zone boundary', () => {
    expect(isoDateInZone(new Date('2026-08-02T02:59:00Z'), 'America/New_York')).toBe('2026-08-01')
    expect(isoDateInZone(new Date('2026-08-02T02:59:00Z'), 'UTC')).toBe('2026-08-02')
  })
})

describe('which prize figure the app uses', () => {
  const res = { nextDate: '2026-08-01', K: 69, drawSize: 5 } as never
  const feed: JackpotFeed = {
    updated: '2026-07-31T10:00:00Z',
    games: {
      powerball: {
        game: 'powerball', drawDate: '2026-08-01', jackpot: 7.07e8, cashValue: 3.097e8,
        drawInstant: '2026-08-02T02:59:00.000Z', source: '',
      },
    },
  }
  const game = { id: 'powerball', name: 'Powerball', syncKey: 'powerball', draws: [], settings: {} } as never

  it('prefers the operator’s figure and its published instant', () => {
    const info = resolveNextDraw(res, game, [], feed, '22:59')
    expect(info).toMatchObject({ amount: 7.07e8, origin: 'official', cashValue: 3.097e8 })
    expect(info.target!.toISOString()).toBe('2026-08-02T02:59:00.000Z')
  })

  it('lets a typed amount win, and drops the cash value with it', () => {
    const typed = { ...(game as object), nextJackpot: 1.2e9, nextJackpotFor: '2026-08-01' } as never
    const info = resolveNextDraw(res, typed, [], feed, '22:59')
    expect(info).toMatchObject({ amount: 1.2e9, origin: 'manual' })
    // no published lump sum exists for a hand-typed figure, so none may be shown
    expect(info.cashValue).toBeUndefined()
  })

  it('ignores a typed amount once its draw has passed', () => {
    const stale = { ...(game as object), nextJackpot: 1.2e9, nextJackpotFor: '2026-07-29' } as never
    expect(resolveNextDraw(res, stale, [], feed, '22:59')).toMatchObject({ amount: 7.07e8, origin: 'official' })
  })

  it('falls back to the scheduled time when the feed has nothing', () => {
    const info = resolveNextDraw(res, game, [], null, '22:59')
    expect(info.origin).toBe('none')
    expect(info.target!.toISOString()).toBe('2026-08-02T02:59:00.000Z')
    expect(info.drawLabel).toBe('10:59 PM ET')
  })
})

describe('ticket grading and the ledger', () => {
  const draw = D('2026-08-01', [3, 16, 36, 50, 61], 19, 7.07e8)

  it('prices each tier from the published table', () => {
    expect(gradeTicket({ numbers: [3, 16, 36, 50, 61], special: 19 }, draw, 5)).toMatchObject({
      jackpot: true, prize: 7.07e8, mains: 5, specialHit: true,
    })
    expect(gradeTicket({ numbers: [3, 16, 36, 50, 61], special: 20 }, draw, 5).prize).toBe(1_000_000)
    expect(gradeTicket({ numbers: [3, 16, 36, 50, 2], special: 19 }, draw, 5).prize).toBe(50_000)
    expect(gradeTicket({ numbers: [3, 16, 36, 50, 2], special: 20 }, draw, 5).prize).toBe(100)
    expect(gradeTicket({ numbers: [3, 16, 36, 1, 2], special: 20 }, draw, 5).prize).toBe(7)
    expect(gradeTicket({ numbers: [1, 2, 4, 5, 6], special: 19 }, draw, 5).prize).toBe(4)
    expect(gradeTicket({ numbers: [1, 2, 4, 5, 6], special: 20 }, draw, 5)).toMatchObject({ prize: 0, label: 'no match' })
  })

  it('settles tickets against their own draw and leaves future ones pending', () => {
    const draws = [D('2026-07-29', [1, 2, 3, 4, 5], 6), draw]
    const ledger = buildLedger(
      [
        { numbers: [3, 16, 36, 50, 2], special: 20, forDate: '2026-08-01' }, // 4 mains = $100
        { numbers: [9, 12, 22, 44, 55], special: 3, forDate: '2026-08-05' }, // draw not in yet
        { numbers: [1, 2, 3, 4, 5], special: 6 }, // legacy ticket, no date
      ],
      draws, 5,
    )
    expect(ledger.rows.map((r) => r.status)).toEqual(['settled', 'pending', 'open'])
    expect(ledger.settled).toBe(1)
    expect(ledger.pending).toBe(1)
    // the undated ticket is graded against the newest draw but never counted in the money
    expect(ledger.spent).toBe(4)
    expect(ledger.won).toBe(100)
    expect(ledger.net).toBe(96)
    expect(ledger.rows[2].draw!.date).toBe('2026-08-01')
    expect(ledger.rows[2].grade!.mains).toBe(1)
    expect(ledger.best!.grade.mains).toBe(4)
  })

  it('honours a per-ticket cost', () => {
    const ledger = buildLedger([{ numbers: [1, 2, 3, 4, 5], forDate: '2026-08-01', cost: 3 }], [draw], 5)
    expect(ledger.spent).toBe(3)
  })
})

describe('portfolio coverage', () => {
  const scores = (() => {
    const s = new Float64Array(70)
    for (let i = 1; i <= 69; i++) s[i] = 1 / i // a clear, deterministic ranking
    return s
  })()
  const opts = { scores, K: 69, D: 5, specialK: 26, specialPicks: [19, 3, 21], count: 5, spread: 1, trials: 4000 }

  it('spreads numbers across tickets and repeats none of them', () => {
    const spread = buildPortfolio(opts)
    expect(spread.tickets).toHaveLength(5)
    expect(spread.stats.distinctNumbers).toBe(25)
    for (const t of spread.tickets) expect(new Set(t.numbers).size).toBe(5)
  })

  it('spreads the bonus ball past the model’s short candidate list', () => {
    // the engine only ranks a handful of bonus candidates; the rest of the pool fills in
    const spread = buildPortfolio(opts)
    const specials = spread.tickets.map((t) => t.special)
    expect(new Set(specials).size).toBe(5)
    expect(specials.slice(0, 3)).toEqual([19, 3, 21])
    // matching the bonus alone already pays, so spread must not lose to a quick pick here
    expect(spread.stats.pAnyPrize).toBeGreaterThan(spread.concentrated.pAnyPrize)
  })

  it('collapses to a single repeated pick at zero spread', () => {
    const same = buildPortfolio({ ...opts, spread: 0 })
    expect(same.stats.distinctNumbers).toBe(5)
    expect(same.tickets.every((t) => t.numbers.join(',') === same.tickets[0].numbers.join(','))).toBe(true)
    expect(new Set(same.tickets.map((t) => t.special)).size).toBe(1)
  })

  it('spreading raises the chance something hits, concentration raises the ceiling', () => {
    const spread = buildPortfolio(opts)
    const same = buildPortfolio({ ...opts, spread: 0 })
    expect(spread.stats.pAtLeast3).toBeGreaterThan(same.stats.pAtLeast3)
    // five identical tickets never do better than one, so the same numbers repeated
    // can only match what a single ticket matches
    expect(same.stats.avgBestMatch).toBeLessThan(spread.stats.avgBestMatch)
  })

  it('is deterministic for the same inputs', () => {
    const a = buildPortfolio(opts)
    const b = buildPortfolio(opts)
    expect(a.stats).toEqual(b.stats)
    expect(a.quickPick).toEqual(b.quickPick)
  })

  it('prices the lower tiers exactly, matching Powerball’s published return', () => {
    // The fixed tiers on a $2 Powerball ticket are worth about 32 cents
    const ev = lowerTierValue(69, 5, 26)
    expect(ev).toBeGreaterThan(0.31)
    expect(ev).toBeLessThan(0.33)
    // and it is blind to how many tickets you buy or how they overlap
    expect(lowerTierValue(70, 5, 24)).toBeGreaterThan(0.2)
  })

  it('matches the hypergeometric chance for a single ticket', () => {
    // P(3+ of 5 from a 5-of-69 draw) ≈ 0.00181
    const stats = scorePortfolio([{ numbers: [1, 2, 3, 4, 5] }], 69, 5, 0, 200000, 42)
    expect(stats.pAtLeast3).toBeGreaterThan(0.0012)
    expect(stats.pAtLeast3).toBeLessThan(0.0026)
  })
})

describe('flip clock units', () => {
  const at = (ms: number) => countdownTo(new Date(ms), 0)

  it('rolls days into hours until the hours would need three digits', () => {
    const short = flipUnits(at((40 * 3600 + 13 * 60 + 18) * 1000))
    expect(short.map((u) => u.label)).toEqual(['Hours', 'Minutes', 'Seconds'])
    expect(short[0].value).toBe(40)

    const long = flipUnits(at(120 * 3600 * 1000))
    expect(long.map((u) => u.label)).toEqual(['Days', 'Hours', 'Minutes', 'Seconds'])
    expect(long[0].value).toBe(5)
    expect(long[1].value).toBe(0)
  })

  it('clamps to zero once the draw has passed', () => {
    const past = flipUnits(at(-5000))
    expect(past.every((u) => u.value === 0)).toBe(true)
  })
})
