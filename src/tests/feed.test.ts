import { describe, expect, it } from 'vitest'
import { parseSalesRows, parseSocrataRows } from '../engine/sync.ts'
import { parseDelimitedText, rowsToDraws } from '../engine/parse.ts'
import { analyzeJackpots, projectNextJackpot } from '../engine/jackpot.ts'
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
import { buildPortfolio, exactPortfolioStats, lowerTierValue, scorePortfolio } from '../engine/portfolio.ts'
import { calendarRate, crowdMarkers, uncrowded } from '../engine/crowd.ts'
import { choose, matchOdds } from '../engine/odds.ts'
import { flipUnits } from '../components/FlipClock.tsx'
import { resolveNextDraw } from '../components/NextDraw.tsx'
import { boardCells } from '../components/PredictionBoard.tsx'
import { missedDraws, missingResults } from '../engine/play.ts'
import { MEGA_MILLIONS_2025, POWERBALL, maxMultiplier, meanMultiplier, minMultiplier, pricingFor } from '../engine/pricing.ts'
import { ticketValue, US_LOWER_TIERS } from '../engine/jackpot.ts'
import { decodeHistory, encodeHistory, fillFromPrior, historyUrl } from '../engine/history.ts'
import { dowOf } from '../engine/dates.ts'
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

  it('deals five distinct bonus balls that change with the seed', () => {
    /*
     * Two failed designs live in this test's history. Indexing the bonus by
     * ticket position ignored the seed entirely — the same five balls on every
     * deal. Rotating the ranked order fixed that and put 15-16-17-18-19 on the
     * user's screen, because everything after the ranked picks is 1..K
     * ascending and a rotated window of it is consecutive integers. The dealer
     * now samples without replacement, weighted by the model's own claims.
     */
    const spread = buildPortfolio(opts)
    const specials = spread.tickets.map((t) => t.special!)
    expect(new Set(specials).size).toBe(5)
    for (const s of specials) { expect(s).toBeGreaterThanOrEqual(1); expect(s).toBeLessThanOrEqual(26) }
    // not a consecutive run — the tell of the rotation bug
    const sorted = [...specials].sort((a, b) => a - b)
    expect(sorted.every((v, i) => i === 0 || v - sorted[i - 1] === 1)).toBe(false)
    // and the seed genuinely re-deals them
    const other = buildPortfolio({ ...opts, seed: 99 }).tickets.map((t) => t.special!)
    expect(other.join(',')).not.toBe(specials.join(','))
    // matching the bonus alone already pays, so spread must not lose to a quick pick here
    expect(spread.stats.pAnyPrize).toBeGreaterThan(spread.concentrated.pAnyPrize)
  })

  it('does not deal the same top numbers into every ticket of every deal', () => {
    /*
     * The user's screenshot: three consecutive deals where number 36 sat in
     * all fifteen tickets and one ticket was byte-identical every time. The
     * model's own claim for its top number was 1.30× the bottom one; the old
     * weight curve stretched that to a fixed 17×, so the sampler dealt the
     * same "hot" numbers into essentially every candidate. The weights now
     * equal the claims, so a number can dominate only if the model can prove
     * that domination.
     */
    const flat = new Float64Array(70)
    for (let i = 1; i <= 69; i++) flat[i] = 0.062 + 0.019 * ((70 - i) / 69) // the live model's real spread
    const seen = new Map<number, number>()
    const dealt = new Set<string>()
    let tickets = 0
    for (let seed = 1; seed <= 10; seed++) {
      const r = buildPortfolio({ ...opts, scores: flat, spread: 0.65, seed, trials: 200 })
      dealt.add(r.tickets.map((t) => t.numbers.join('-')).join('|'))
      for (const t of r.tickets) {
        tickets++
        for (const n of new Set(t.numbers)) seen.set(n, (seen.get(n) ?? 0) + 1)
      }
    }
    expect(dealt.size).toBe(10)
    const most = Math.max(...seen.values())
    // With honest 1.3× weights nothing should be anywhere near every ticket.
    expect(most / tickets).toBeLessThan(0.6)
  })

  it('re-deals every ticket when the seed changes, bonus balls included', () => {
    /*
     * The "Another five" bug. pickTicket seeded its search with the greedy
     * top-scoring pick, and greedy IS the maximum, so no sampled candidate
     * could ever beat it: any ticket whose greedy pick passed the shape test
     * was frozen for every seed. On the live model that pinned tickets 1 and 2
     * of 5 — the two at the top of the screen, so the button looked dead.
     * The bonus balls were worse: indexed by ticket position alone, never by
     * the seed.
     */
    const shape = { lo: [1, 2, 6, 13, 23], hi: [50, 58, 64, 68, 69], sumLo: 60, sumHi: 300 }
    const deals = [1, 2, 3, 4, 5, 6].map((seed) =>
      buildPortfolio({ ...opts, spread: 0.65, shape, seed, trials: 200 }).tickets)
    for (let i = 0; i < 5; i++) {
      const nums = new Set(deals.map((d) => d[i].numbers.join('-')))
      const bonus = new Set(deals.map((d) => d[i].special))
      expect({ ticket: i + 1, distinctNumberSets: nums.size > 1, distinctBonus: bonus.size > 1 })
        .toEqual({ ticket: i + 1, distinctNumberSets: true, distinctBonus: true })
    }
    // and a re-deal must not smuggle in a shape the game does not produce
    for (const d of deals) {
      for (const t of d) {
        expect(t.numbers.every((n, p) => n >= shape.lo[p] && n <= shape.hi[p])).toBe(true)
        const sum = t.numbers.reduce((a, b) => a + b, 0)
        expect(sum).toBeGreaterThanOrEqual(shape.sumLo)
        expect(sum).toBeLessThanOrEqual(shape.sumHi)
      }
    }
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

  it('keeps locked tickets through a re-deal and still spreads around them', () => {
    const first = buildPortfolio(opts).tickets
    const hold = [first[0], first[2]]
    const again = buildPortfolio({ ...opts, seed: 4242, hold }).tickets
    expect(again).toHaveLength(5)
    // The held ones come back untouched, numbers and bonus ball alike
    expect(again[0]).toEqual(hold[0])
    expect(again[1]).toEqual(hold[1])
    // and the fresh three are genuinely fresh
    const heldKeys = new Set(hold.map((t) => t.numbers.join('-')))
    for (const t of again.slice(2)) expect(heldKeys.has(t.numbers.join('-'))).toBe(false)
    // A repeated bonus ball is the most expensive overlap there is, so the
    // dealer must not hand a fresh ticket one a held ticket already carries.
    expect(new Set(again.map((t) => t.special!)).size).toBe(5)
    // At full spread, holding two tickets must not cost any coverage
    expect(new Set(again.flatMap((t) => t.numbers)).size).toBe(25)
  })

  it('holding nothing deals exactly what it dealt before', () => {
    expect(buildPortfolio({ ...opts, hold: [] }).tickets).toEqual(buildPortfolio(opts).tickets)
  })
})

describe('counting a portfolio exactly', () => {
  const five = [
    { numbers: [3, 19, 35, 51, 67], special: 4 },
    { numbers: [7, 12, 28, 44, 60], special: 11 },
    { numbers: [2, 21, 33, 48, 55], special: 19 },
    { numbers: [9, 16, 40, 57, 63], special: 23 },
    { numbers: [5, 26, 31, 46, 69], special: 8 },
  ]

  it('reproduces the closed form for one ticket to the last digit', () => {
    const s = exactPortfolioStats([{ numbers: [1, 2, 3, 4, 5], special: 1 }], 69, 5, 26)!
    const p3 = 1 / matchOdds(69, 5, 3) + 1 / matchOdds(69, 5, 4) + 1 / matchOdds(69, 5, 5)
    expect(s.exact).toBe(true)
    expect(s.pAtLeast3).toBeCloseTo(p3, 12)
    // A prize means 3+ mains OR the bonus ball, and the two pools are independent
    expect(s.pAnyPrize).toBeCloseTo(1 - (25 / 26) * (1 - p3), 12)
  })

  it('agrees with a large simulation of the same five tickets', () => {
    const exact = exactPortfolioStats(five, 69, 5, 26)!
    let a = 987654321
    const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296 }
    const pool = Array.from({ length: 69 }, (_, i) => i + 1)
    let any = 0, ge3 = 0, bestSum = 0
    const N = 2_000_000
    for (let t = 0; t < N; t++) {
      for (let i = 0; i < 5; i++) { const j = i + Math.floor(rnd() * (69 - i)); const x = pool[i]; pool[i] = pool[j]; pool[j] = x }
      const drawn = new Set(pool.slice(0, 5))
      const sp = 1 + Math.floor(rnd() * 26)
      let best = 0, paid = false
      for (const tk of five) {
        let m = 0
        for (const n of tk.numbers) if (drawn.has(n)) m++
        if (m > best) best = m
        if (m >= 3 || tk.special === sp) paid = true
      }
      if (paid) any++
      if (best >= 3) ge3++
      bestSum += best
    }
    expect(exact.pAnyPrize).toBeCloseTo(any / N, 3)
    expect(exact.pAtLeast3).toBeCloseTo(ge3 / N, 4)
    expect(exact.avgBestMatch).toBeCloseTo(bestSum / N, 3)
  })

  it('accounts for every possible draw exactly once', () => {
    /*
     * The whole method rests on collapsing C(K,D) draws onto the subsets of the
     * covered numbers, each weighted by C(K−covered, D−j). If those weights did
     * not add back up to the full space, every probability here would be wrong
     * by the same silent factor — so check the identity directly on a small
     * game where the total is easy to state.
     */
    const K = 20, Dn = 5
    const tickets = [{ numbers: [1, 2, 3, 4, 5] }, { numbers: [4, 5, 6, 7, 8] }]
    const cover = new Set(tickets.flatMap((t) => t.numbers))
    let total = 0
    for (let j = 0; j <= Dn; j++) total += choose(cover.size, j) * choose(K - cover.size, Dn - j)
    expect(total).toBe(choose(K, Dn))
    const s = exactPortfolioStats(tickets, K, Dn, 0)!
    expect(s.distinctNumbers).toBe(8)
    // With no bonus pool, "any prize" is exactly "some ticket hits 3+"
    expect(s.pAnyPrize).toBeCloseTo(s.pAtLeast3, 12)
  })

  it('five different tickets get five shots at 4+, five copies of one get a single shot', () => {
    const same = Array.from({ length: 5 }, () => ({ numbers: [3, 19, 35, 51, 67], special: 5 }))
    const a = exactPortfolioStats(same, 69, 5, 26)!
    const b = exactPortfolioStats(five, 69, 5, 26)!
    expect(b.pAtLeast4).toBeCloseTo(a.pAtLeast4 * 5, 9)
    // and the bonus ball is why spreading wins on "any prize" at all
    expect(b.pAnyPrize).toBeGreaterThan(a.pAnyPrize * 4)
  })

  it('scorePortfolio counts the sets the app actually offers, and says so', () => {
    const s = scorePortfolio(five, 69, 5, 26, 20000, 7)
    expect(s.exact).toBe(true)
    // Ten tickets on a 6-number game cover too much to enumerate; it falls back
    // to simulation rather than hanging, and reports that it did.
    const wide = Array.from({ length: 10 }, (_, i) => ({ numbers: [1, 2, 3, 4, 5, 6].map((n) => n + i * 6) }))
    expect(scorePortfolio(wide, 70, 6, 0, 2000, 7).exact).toBe(false)
  })

  it('the figures no longer move when only the seed does', () => {
    // Two simulations of the same tickets used to disagree in the third digit,
    // which is the same size as the difference between the rows being compared.
    const a = scorePortfolio(five, 69, 5, 26, 20000, 1)
    const b = scorePortfolio(five, 69, 5, 26, 20000, 999)
    expect(a).toEqual(b)
  })
})

describe('the board', () => {
  it('lays the pool out in numeric order however the values arrive', () => {
    /*
     * `predictions` arrives sorted strongest-first, and the board was rendering
     * in that order: ten to a row starting 50, 48, 29… Every row is supposed to
     * be a decade, which is the only reason a grid beats a list here.
     */
    const ranked = [{ n: 50, value: 9 }, { n: 3, value: 1 }, { n: 27, value: 5 }, { n: 11, value: 4 }]
    expect(boardCells(ranked, 5).map((c) => c.n)).toEqual([3, 11, 27, 50])
  })

  it('scales the shading to the widest gap, keeping the sign', () => {
    const cells = boardCells([{ n: 1, value: 0 }, { n: 2, value: 10 }, { n: 3, value: 5 }], 5)
    expect(cells.map((c) => c.t)).toEqual([-1, 1, 0])
  })

  it('does not divide by zero when every number reads the same', () => {
    const flat = boardCells([{ n: 1, value: 7 }, { n: 2, value: 7 }], 7)
    expect(flat.every((c) => c.t === 0)).toBe(true)
  })
})

describe('combinations other people also play', () => {
  it('names why a ticket would be shared, and stays quiet otherwise', () => {
    // 3-19-35-51-67 is NOT the neutral example it looks like: it steps by 16.
    expect(crowdMarkers([3, 19, 35, 51, 67], 69).map((m) => m.key)).toEqual(['evenStep'])
    expect(crowdMarkers([4, 17, 33, 48, 62], 69).map((m) => m.key)).toEqual([])
    expect(crowdMarkers([4, 11, 17, 23, 31], 69).map((m) => m.key)).toEqual(['calendar'])
    expect(crowdMarkers([2, 5, 7, 9, 12], 69).map((m) => m.key)).toEqual(['months'])
    expect(crowdMarkers([11, 12, 13, 14, 15], 69).map((m) => m.key)).toContain('run')
    expect(crowdMarkers([4, 16, 28, 40, 52], 69).map((m) => m.key)).toContain('evenStep')
    expect(crowdMarkers([10, 25, 35, 50, 60], 69).map((m) => m.key)).toContain('fives')
    expect(crowdMarkers([4, 14, 24, 44, 64], 69).map((m) => m.key)).toContain('sameDigit')
  })

  it('flags a combination that already won, because that is the story people replay', () => {
    const past = new Set(['4-17-33-48-62'])
    expect(crowdMarkers([4, 17, 33, 48, 62], 69, past).map((m) => m.key)).toEqual(['pastWinner'])
  })

  it('never says a crowded combination is unlikely, because it is not', () => {
    /*
     * The whole feature has to survive this: the calendar range comes up at its
     * proper rate and always will. The claim is about the size of the cheque,
     * never about the chance of getting one.
     */
    const rate = calendarRate(69, 5, [])
    expect(rate.expected).toBeCloseTo(choose(31, 5) / choose(69, 5), 12)
    expect(rate.expected).toBeGreaterThan(0.015)
    const seen = calendarRate(69, 5, [[4, 11, 17, 23, 31], [3, 19, 35, 51, 67]])
    expect(seen.seen).toBe(1)
    expect(seen.of).toBe(2)
  })

  it('the dealer will not hand you one', () => {
    const scores = new Float64Array(70)
    // Stack the model heavily toward 1..31 so the ONLY thing keeping the deal
    // out of the calendar range is the crowd test itself.
    for (let i = 1; i <= 69; i++) scores[i] = i <= 31 ? 1 : 1e-6
    const free = uncrowded(69)
    const pf = buildPortfolio({
      scores, K: 69, D: 5, specialK: 26, specialPicks: [], count: 5, spread: 0.65,
      accept: free, trials: 1,
    })
    for (const t of pf.tickets) {
      expect(crowdMarkers(t.numbers, 69)).toEqual([])
      expect(Math.max(...t.numbers)).toBeGreaterThan(31)
    }
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

describe('merged draw history', () => {
  const draws = [
    { date: '1995-03-08', dow: 3, numbers: [16, 30, 44, 5, 12], sorted: [5, 12, 16, 30, 44], special: 25, jackpot: 5_000_000, winnerLocation: 'IA' },
    { date: '2026-08-01', dow: 6, numbers: [3, 16, 36, 50, 61], sorted: [3, 16, 36, 50, 61], special: 19 },
  ]

  it('survives a round trip, keeping every optional field', () => {
    const file = encodeHistory('powerball', draws, ['a', 'b'])
    expect(file).toMatchObject({ game: 'powerball', count: 2, first: '1995-03-08', last: '2026-08-01' })
    const back = decodeHistory(file)
    expect(back).toHaveLength(2)
    expect(back[0]).toMatchObject({
      date: '1995-03-08', sorted: [5, 12, 16, 30, 44], special: 25, jackpot: 5_000_000, winnerLocation: 'IA',
    })
    // absent extras must not come back as zeroes
    expect(back[1].jackpot).toBeUndefined()
    expect(back[1].winnerLocation).toBeUndefined()
    expect(back[1].special).toBe(19)
  })

  it('recomputes the weekday rather than trusting the file', () => {
    const file = encodeHistory('powerball', draws, [])
    expect(decodeHistory(file)[1].dow).toBe(dowOf('2026-08-01'))
  })

  it('drops malformed rows instead of poisoning the history', () => {
    const file = encodeHistory('powerball', draws, [])
    file.rows.push(['not-a-date', 1, 2, 3, 4, 5, 6, 0, ''])
    file.rows.push(['2026-08-05', 1, 2] as never)
    file.rows.push(['2026-08-06', 0, -3, 4, 5, 6, 7, 0, ''])
    expect(decodeHistory(file)).toHaveLength(2)
    expect(decodeHistory(null)).toEqual([])
  })

  it('sorts by date however the rows arrive', () => {
    const file = encodeHistory('powerball', draws, [])
    file.rows.reverse()
    expect(decodeHistory(file).map((d) => d.date)).toEqual(['1995-03-08', '2026-08-01'])
  })

  it('asks for the history next to the page, not at the site root', () => {
    expect(historyUrl('https://altecbx.github.io/Lottery/', 'powerball', 7))
      .toBe('https://altecbx.github.io/Lottery/history-powerball.json?t=7')
    expect(historyUrl('https://altecbx.github.io/Lottery/index.html', 'megamillions', 7))
      .toBe('https://altecbx.github.io/Lottery/history-megamillions.json?t=7')
  })
})

describe('audited robustness fixes', () => {
  it('does not swallow the file after a quote inside a free-text column', () => {
    // The Louisiana feed carries a winner-location column. One inch mark in it
    // used to open quote mode and eat every remaining line, with no error:
    // 3,537 draws became 10.
    const text = [
      'date,n1,n2,n3,n4,n5,pb,location',
      '2026-01-03,1,2,3,4,5,6,Smith"s Grocery',
      '2026-01-05,7,8,9,10,11,12,Corner Store',
      '2026-01-07,13,14,15,16,17,18,Gas N Go',
    ].join('\n')
    const { draws } = parseDelimitedText(text)
    expect(draws).toHaveLength(3)
    expect(draws[2].sorted).toEqual([13, 14, 15, 16, 17])
    // real quoting still works
    const quoted = parseDelimitedText('date,n1,n2,n3,n4,n5\n2026-01-03,1,2,3,4,5\n"2026-01-05",6,7,8,9,10')
    expect(quoted.draws).toHaveLength(2)
  })

  it('reports a ragged row instead of throwing away the whole import', () => {
    const rows = [
      ['date', 'n1', 'n2', 'n3', 'n4', 'n5', 'jackpot'],
      ['2026-01-03', '1', '2', '3', '4', '5', '100000000'],
      ['2026-01-05'],
      ['2026-01-07', '11', '12', '13', '14', '15', '120000000'],
    ]
    const out = rowsToDraws(rows)
    expect(out.draws.length).toBeGreaterThanOrEqual(2)
    expect(out.draws.map((d) => d.date)).toContain('2026-01-07')
  })

  it('rejects a corrupt row rather than silently shifting the bonus into the mains', () => {
    // 10,20*,30,40,50,60 used to parse as 10-30-40-50-60 with zero errors:
    // the starred ball vanished and the bonus was promoted.
    const { draws, errors } = parseDelimitedText('2026-01-05,10,20*,30,40,50,60\n2026-01-07,1,2,3,4,5,6')
    expect(errors.length).toBeGreaterThan(0)
    expect(draws.every((d) => !d.sorted.includes(60))).toBe(true)
  })

  it('treats a lone carriage return as a row break', () => {
    const { draws, drawSize } = parseDelimitedText('2026-01-03,1,2,3,4,5\r2026-01-05,6,7,8,9,10\r2026-01-07,11,12,13,14,15\r')
    expect(drawSize).toBe(5)
    expect(draws).toHaveLength(3)
    expect(draws[0].sorted).toEqual([1, 2, 3, 4, 5])
  })

  it('finds the header under a title line instead of eating it', () => {
    const text = [
      'Powerball Winning Numbers',
      'date,n1,n2,n3,n4,n5,pb',
      '2026-01-03,1,2,3,4,5,6',
      '2026-01-05,7,8,9,10,11,12',
    ].join('\n')
    const { draws, drawSize, hasSpecial } = parseDelimitedText(text)
    expect(drawSize).toBe(5)
    expect(hasSpecial).toBe(true)
    expect(draws).toHaveLength(2)
  })

  it('skips a malformed remote row instead of aborting the sync', () => {
    const rows = [
      { draw_date: '2026-08-02T00:00:00.000', winning_numbers: '05 25 36 40 48 03' },
      { draw_date: 20260804 as unknown as string, winning_numbers: '1 2 3 4 5 6' },
      { draw_date: '2026-08-05', winning_numbers: 5 as unknown as string },
      null as unknown as { draw_date: string },
      { draw_date: '2026-08-08T00:00:00.000', winning_numbers: '10 20 30 40 50 07' },
    ]
    const out = parseSocrataRows(rows, 'powerball')
    expect(out.draws.map((d) => d.date)).toEqual(['2026-08-02', '2026-08-08'])
    expect(parseSocrataRows({ error: true } as never, 'powerball').draws).toHaveLength(0)
    expect(parseSalesRows([{ bus_day: 20260802 as unknown as string, total: '5' }]).size).toBe(0)
  })

  it('projects the jackpot across every draw since the last recorded amount', () => {
    const mk = (i: number, jackpot?: number): Draw => {
      const day = String(3 + i * 2).padStart(2, '0')
      const d: Draw = { date: `2026-01-${day}`, dow: i % 7, numbers: [1, 2, 3, 4, 5], sorted: [1, 2, 3, 4, 5] }
      if (jackpot !== undefined) d.jackpot = jackpot
      return d
    }
    const withAll = [0, 1, 2, 3, 4, 5].map((i) => mk(i, 100e6 + i * 20e6))
    const anchored = projectNextJackpot(withAll)!
    expect(anchored.amount).toBeCloseTo(200e6 + 20e6, -5)
    // Now the newest three draws carry no figure: the estimate has to cover them
    const stale = [...withAll, mk(6), mk(7), mk(8)]
    const projected = projectNextJackpot(stale)!
    expect(projected.amount).toBeCloseTo(200e6 + 4 * 20e6, -5)
    expect(projected.amount).toBeGreaterThan(anchored.amount)
  })

  it('does not claim a record rollover when no winner column exists', () => {
    const draws: Draw[] = Array.from({ length: 60 }, (_, i) => ({
      date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
      dow: i % 7, numbers: [1, 2, 3, 4, 5], sorted: [1, 2, 3, 4, 5], jackpot: 100e6 + i * 1e6,
    }))
    const stats = analyzeJackpots(draws)
    expect(stats!.winners).toHaveLength(0)
    expect(stats!.rolloverRun).toBe(0)
  })
})

describe('a source going thin', () => {
  // Every Tuesday and Friday across two months, like Mega Millions
  const twice = (() => {
    const out: Draw[] = []
    const d = new Date('2026-08-04T12:00:00Z')
    for (let i = 0; out.length < 17; i++) {
      if ([2, 5].includes(d.getUTCDay())) out.push(D(d.toISOString().slice(0, 10), [1 + i % 60, 2 + i % 60, 3 + i % 60, 4 + i % 60, 5 + i % 60], 1))
      d.setUTCDate(d.getUTCDate() + 1)
    }
    return out
  })()

  it('can only fail to add, never take away', () => {
    /*
     * New York cut its Mega Millions set to one draw a month. Rebuilt from the
     * sources alone the history came out short, a never-shorter guard kept the
     * stale committed copy, and the site sat at 31 July for two months.
     */
    const prior = twice.slice(0, 12)
    const thin = twice.filter((_, i) => i % 8 === 0) // what one-a-month looks like
    const { merged, kept } = fillFromPrior(thin, prior)
    expect(merged.length).toBe(12 + thin.filter((d) => !prior.some((p) => p.date === d.date)).length)
    for (const p of prior) expect(merged.some((m) => m.date === p.date)).toBe(true)
    expect(kept).toBe(prior.filter((p) => !thin.some((t) => t.date === p.date)).length)
    expect(merged.map((d) => d.date)).toEqual([...merged.map((d) => d.date)].sort())
  })

  it('lets a source correct a date it still carries', () => {
    const prior = [D('2026-08-04', [1, 2, 3, 4, 5], 9)]
    const corrected = [D('2026-08-04', [1, 2, 3, 4, 6], 9)]
    const { merged } = fillFromPrior(corrected, prior)
    expect(merged).toHaveLength(1)
    expect(merged[0].sorted).toEqual([1, 2, 3, 4, 6])
  })

  it('takes a date from the most trusted prior history first', () => {
    const committed = [D('2026-08-07', [1, 2, 3, 4, 5], 2)]
    const published = [D('2026-08-07', [1, 2, 3, 4, 5], 2), D('2026-08-11', [6, 7, 8, 9, 10], 3)]
    const { merged } = fillFromPrior([], committed, published)
    expect(merged.map((d) => d.date)).toEqual(['2026-08-07', '2026-08-11'])
  })
})

describe('results this device is missing', () => {
  const tueFri = [2, 5]

  it('counts nothing when the next draw is still ahead', () => {
    expect(missedDraws('2026-10-02', tueFri, '2026-10-01')).toBe(0)
    // tonight's draw is not missing yet
    expect(missedDraws('2026-10-02', tueFri, '2026-10-02')).toBe(0)
  })

  it('counts every scheduled draw the history skipped', () => {
    // The published Mega Millions file stopped at 31 July: from the 4 August
    // draw to 1 October, seventeen Tuesday and Friday draws had happened.
    expect(missedDraws('2026-08-04', tueFri, '2026-10-01')).toBe(17)
  })

  it('ignores days the game does not draw on', () => {
    expect(missedDraws('2026-10-02', tueFri, '2026-10-05')).toBe(1) // Fri only; Sat, Sun skipped
    expect(missedDraws('nonsense', tueFri, '2026-10-05')).toBe(0)
    expect(missedDraws('2026-10-02', [], '2026-10-05')).toBe(0)
  })

  it('gives the morning after a draw a day of grace before warning', () => {
    const at = (iso: string) => new Date(`${iso}T09:00:00`) // device-local morning
    // Friday's draw, Saturday morning: a sync away, not missing
    expect(missingResults('2026-10-02', tueFri, at('2026-10-03'))).toBe(0)
    // Sunday morning, still no Friday result: now it is missing
    expect(missingResults('2026-10-02', tueFri, at('2026-10-04'))).toBe(1)
    // The October 2026 state: every draw since 4 August
    expect(missingResults('2026-08-04', tueFri, at('2026-10-01'))).toBe(17)
  })
})

describe('pricing each game by its own rules', () => {
  /*
   * Every game used to be priced as a $2 ticket on Powerball's prize table.
   * Mega Millions has cost $5 since April 2025, pays from its own table, and
   * prints a multiplier on every ticket — so its value line, value and jackpot
   * panels, and every saved Mega Millions ticket were priced as another game.
   */
  const official = JSON.parse(JSON.parse(megaMillionsPayload).d).PrizeMatrix as {
    TicketPrice: number; WhiteBallMax: number; MegaBallMax: number
    PrizeTiers: { TierWhiteBall: number; TierMegaBall: boolean; IsJackpot: boolean; Mega2: number; Mega3: number; Mega4: number; Mega5: number; Mega10: number; Odds: number }[]
  }

  it('charges each game its real price', () => {
    expect(pricingFor('megamillions').price).toBe(5)
    expect(pricingFor('megamillions').price).toBe(official.TicketPrice)
    expect(pricingFor('powerball')).toBe(POWERBALL)
    expect(POWERBALL.price).toBe(2)
    expect(POWERBALL.tiers).toBe(US_LOWER_TIERS)
    // A game without an official source keeps the structure it always had
    expect(pricingFor(undefined)).toBe(POWERBALL)
  })

  it('pays Mega Millions exactly what the official prize matrix pays, at every multiplier', () => {
    // The multiplied columns are what is actually paid. The matrix's own base
    // column is stale for three tiers, so it is deliberately not compared.
    const tiers = official.PrizeTiers.filter((t) => !t.IsJackpot)
    expect(tiers).toHaveLength(MEGA_MILLIONS_2025.tiers.length)
    for (const t of tiers) {
      const ours = MEGA_MILLIONS_2025.tiers.find((x) => x.match === t.TierWhiteBall && x.withSpecial === t.TierMegaBall)!
      expect(ours, `${t.TierWhiteBall}${t.TierMegaBall ? '+MB' : ''}`).toBeDefined()
      for (const k of [2, 3, 4, 5, 10] as const) {
        expect(ours.prize * k).toBe(t[`Mega${k}` as const])
      }
    }
  })

  it('agrees with the official odds for every tier', () => {
    const K = official.WhiteBallMax, sk = official.MegaBallMax
    for (const t of official.PrizeTiers) {
      const pMains = 1 / matchOdds(K, 5, t.TierWhiteBall)
      const p = pMains * (t.TierMegaBall ? 1 / sk : 1 - 1 / sk)
      // The published figures are rounded to whole numbers
      expect(Math.abs(1 / p - t.Odds) / t.Odds).toBeLessThan(0.005)
    }
  })

  it('weights the multiplier exactly as published: 2x 1 in 2.13, 3x 1 in 3.2, 4x 1 in 8, 5x 1 in 16, 10x 1 in 32', () => {
    const m = MEGA_MILLIONS_2025.multiplier!
    const total = m.reduce((a, b) => a + b.weight, 0)
    const oneIn = Object.fromEntries(m.map((x) => [x.value, total / x.weight]))
    expect(oneIn[2]).toBeCloseTo(2.13, 2)
    expect(oneIn[3]).toBeCloseTo(3.2, 6)
    expect(oneIn[4]).toBe(8)
    expect(oneIn[5]).toBe(16)
    expect(oneIn[10]).toBe(32)
    expect(meanMultiplier(MEGA_MILLIONS_2025)).toBe(3)
    expect(minMultiplier(MEGA_MILLIONS_2025)).toBe(2)
    expect(maxMultiplier(MEGA_MILLIONS_2025)).toBe(10)
    expect(meanMultiplier(POWERBALL)).toBe(1)
  })

  it('values a $5 Mega Millions ticket with its multiplier counted, and leaves Powerball alone', () => {
    const mm = MEGA_MILLIONS_2025
    const base = lowerTierValue(70, 5, 24, mm.tiers)
    const withMult = lowerTierValue(70, 5, 24, mm.tiers, meanMultiplier(mm))
    expect(withMult).toBeCloseTo(base * 3, 12)
    // About $1.12 back per $5 ticket below the jackpot
    expect(withMult).toBeGreaterThan(1.1)
    expect(withMult).toBeLessThan(1.14)
    // The jackpot is never multiplied: at a $300M cash prize it adds prize / odds on top
    const v = ticketValue(70, 5, 24, 300e6, null, mm.price, mm.tiers, meanMultiplier(mm))
    expect(v.ticketPrice).toBe(5)
    expect(v.grossEv).toBeCloseTo(withMult + 300e6 / 290_472_336, 9)
    // Powerball is exactly what it was
    expect(lowerTierValue(69, 5, 26)).toBeCloseTo(lowerTierValue(69, 5, 26, POWERBALL.tiers, meanMultiplier(POWERBALL)), 12)
  })

  it('grades a Mega Millions win at its own multiplier, or at the floor until it is entered', () => {
    const draw = D('2026-09-29', [10, 15, 16, 27, 64], 23, 300e6)
    const ticket = { numbers: [1, 2, 3, 4, 5], special: 23 } // bonus ball only
    const unknown = gradeTicket(ticket, draw, 5, MEGA_MILLIONS_2025)
    expect(unknown).toMatchObject({ prize: 10, prizeIsFloor: true, prizeMax: 50 })
    expect(gradeTicket({ ...ticket, multiplier: 3 }, draw, 5, MEGA_MILLIONS_2025)).toMatchObject({ prize: 15, multiplier: 3 })
    expect(gradeTicket({ ...ticket, multiplier: 10 }, draw, 5, MEGA_MILLIONS_2025).prize).toBe(50)
    // A multiplier the game does not print is ignored, not trusted
    expect(gradeTicket({ ...ticket, multiplier: 7 }, draw, 5, MEGA_MILLIONS_2025)).toMatchObject({ prize: 10, prizeIsFloor: true })
    // 1 + Mega Ball: $7 base, so $14 to $70
    expect(gradeTicket({ numbers: [10, 2, 3, 4, 5], special: 23 }, draw, 5, MEGA_MILLIONS_2025)).toMatchObject({ prize: 14, prizeMax: 70 })
    // The jackpot is the jackpot — never multiplied, never a floor
    const jp = gradeTicket({ numbers: [10, 15, 16, 27, 64], special: 23, multiplier: 10 }, draw, 5, MEGA_MILLIONS_2025)
    expect(jp).toMatchObject({ jackpot: true, prize: 300e6 })
    expect(jp.prizeIsFloor).toBeUndefined()
    // A loser is a loser whatever its multiplier
    expect(gradeTicket({ numbers: [1, 2, 3, 4, 5], special: 1, multiplier: 10 }, draw, 5, MEGA_MILLIONS_2025).prize).toBe(0)
  })

  it('charges $5 a Mega Millions ticket in the ledger and says when a win is only a floor', () => {
    const draw = D('2026-09-29', [10, 15, 16, 27, 64], 23, 300e6)
    const tickets = [
      { numbers: [1, 2, 3, 4, 5], special: 23, forDate: '2026-09-29' },               // MB only, multiplier unknown
      { numbers: [10, 15, 16, 4, 5], special: 23, forDate: '2026-09-29', multiplier: 4 }, // 3 + MB at ×4 = $800
      { numbers: [1, 2, 3, 4, 5], special: 1, forDate: '2026-09-29' },                 // nothing
      { numbers: [1, 2, 3, 4, 6], special: 1, forDate: '2026-10-02' },                 // not drawn yet
    ]
    const l = buildLedger(tickets, [draw], 5, MEGA_MILLIONS_2025)
    expect(l.spent).toBe(20)
    expect(l.won).toBe(10 + 800)
    expect(l.floors).toBe(1)
    expect(l.pending).toBe(1)
    // and Powerball's ledger is untouched: $2 a ticket, no floors
    const pb = buildLedger([{ numbers: [1, 2, 3, 4, 5], special: 23, forDate: '2026-09-29' }], [draw], 5)
    expect(pb).toMatchObject({ spent: 2, won: 4, floors: 0 })
  })
})
