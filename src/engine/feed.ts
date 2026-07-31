import type { SyncKey } from './sync.ts'
import { parseMoney } from './parse.ts'
import { zonedTimeToInstant } from './drawtime.ts'

/**
 * The advertised jackpot for one game's next draw, straight from the operator.
 *
 * Neither powerball.com nor megamillions.com sends an
 * `Access-Control-Allow-Origin` header, so a phone cannot read them directly.
 * A scheduled GitHub Action runs the parsers below server-side and publishes
 * the result next to the app as `jackpots.json`, which is same-origin and
 * therefore always readable — no proxy, no CORS, no third party.
 */
export interface JackpotFeedEntry {
  game: SyncKey
  /** ISO date of the draw this prize belongs to */
  drawDate: string
  /** Exact instant of that draw, ISO-8601 UTC, as published by the operator */
  drawInstant?: string
  /** Advertised annuity jackpot, in dollars */
  jackpot: number
  /** Lump-sum cash value, in dollars, when the operator publishes it */
  cashValue?: number
  source: string
}

export interface JackpotFeed {
  /** When the feed was built, ISO-8601 UTC */
  updated: string
  games: Partial<Record<SyncKey, JackpotFeedEntry>>
}

export const FEED_URLS: Record<SyncKey, string> = {
  powerball: 'https://www.powerball.com/',
  megamillions: 'https://www.megamillions.com/cmspages/utilservice.asmx/GetLatestDrawData',
}

/** Calendar date in a named zone for a given instant, as "YYYY-MM-DD". */
export function isoDateInZone(instant: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * Pull the next-draw prize out of the Powerball home page.
 *
 * The page carries the authoritative draw instant as
 * `data-drawdateutc="2026-08-02T02:59:00.0000000Z"` on its countdown, and the
 * prize as `<span class="game-jackpot-number text-xxxl …">$707 Million</span>`
 * followed by the cash value in the same class at `text-lg`.
 */
export function parsePowerballPage(html: string): JackpotFeedEntry | null {
  const block = sliceNextDrawing(html)
  if (!block) return null

  const amounts = [...block.matchAll(/game-jackpot-number[^>]*>\s*([^<]+?)\s*</g)]
    .map((m) => parseMoney(m[1]))
    .filter((n): n is number => n !== null && n > 0)
  if (amounts.length === 0) return null

  const utc = block.match(/data-drawdateutc="([^"]+)"/)
  let drawInstant: string | undefined
  let drawDate: string | undefined
  if (utc) {
    const when = new Date(utc[1])
    if (!Number.isNaN(when.getTime())) {
      drawInstant = when.toISOString()
      drawDate = isoDateInZone(when, 'America/New_York')
    }
  }
  // Fall back to the human date the card prints, e.g. `title-date">Sat, Aug 1, 2026<`
  if (!drawDate) {
    const printed = block.match(/title-date[^>]*>\s*(?:\w{3},\s*)?([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})/)
    if (printed) drawDate = isoFromMonthName(printed[1], Number(printed[2]), Number(printed[3]))
  }
  if (!drawDate) return null

  const entry: JackpotFeedEntry = {
    game: 'powerball',
    drawDate,
    jackpot: amounts[0],
    source: FEED_URLS.powerball,
  }
  if (drawInstant) entry.drawInstant = drawInstant
  if (amounts.length > 1 && amounts[1] < amounts[0]) entry.cashValue = amounts[1]
  return entry
}

/** The `id="next-drawing"` card, so the winners card's amounts can't be mistaken for it. */
function sliceNextDrawing(html: string): string | null {
  const start = html.indexOf('id="next-drawing"')
  if (start < 0) return null
  const after = html.indexOf('id="winners"', start)
  return html.slice(start, after < 0 ? start + 6000 : after)
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function isoFromMonthName(name: string, day: number, year: number): string | undefined {
  const idx = MONTHS.indexOf(name.slice(0, 3).toLowerCase())
  if (idx < 0 || !day || !year) return undefined
  return `${year}-${String(idx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Read Mega Millions' `GetLatestDrawData` response. The service answers with
 * `{"d": "<json string>"}`; inside, `Jackpot.NextPrizePool` is the advertised
 * prize for the draw at `NextDrawingDate` (Eastern wall-clock).
 */
export function parseMegaMillionsPayload(body: string): JackpotFeedEntry | null {
  let data: unknown
  try {
    const outer = JSON.parse(body) as { d?: unknown }
    data = typeof outer?.d === 'string' ? JSON.parse(outer.d) : outer
  } catch {
    return null
  }
  const root = data as {
    Jackpot?: { NextPrizePool?: number; NextCashValue?: number }
    NextDrawingDate?: string
  } | null
  const jackpot = Number(root?.Jackpot?.NextPrizePool)
  const when = String(root?.NextDrawingDate ?? '')
  const m = when.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!Number.isFinite(jackpot) || jackpot <= 0 || !m) return null

  const entry: JackpotFeedEntry = {
    game: 'megamillions',
    drawDate: `${m[1]}-${m[2]}-${m[3]}`,
    drawInstant: zonedTimeToInstant(
      Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), 'America/New_York',
    ).toISOString(),
    jackpot,
    source: FEED_URLS.megamillions,
  }
  const cash = Number(root?.Jackpot?.NextCashValue)
  if (Number.isFinite(cash) && cash > 0) entry.cashValue = cash
  return entry
}

/** Reject anything that fails a sanity check before it reaches the app. */
export function isPlausibleEntry(e: JackpotFeedEntry | null): e is JackpotFeedEntry {
  if (!e) return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.drawDate)) return false
  // Powerball and Mega Millions both restart at $20M+ and have never passed $3B
  return e.jackpot >= 1e6 && e.jackpot <= 5e9
}

const FEED_FILE = 'jackpots.json'

/**
 * Read the published feed. Same-origin, so it works on a phone with no CORS
 * involvement; returns null (rather than throwing) whenever it is unavailable,
 * because the app always has its own projection to fall back on.
 */
export async function fetchJackpotFeed(signal?: AbortSignal): Promise<JackpotFeed | null> {
  const meta = import.meta as unknown as { env?: { BASE_URL?: string } }
  const base = meta.env?.BASE_URL ?? '/'
  try {
    const resp = await fetch(`${base}${FEED_FILE}?t=${Math.floor(Date.now() / 6e5)}`, {
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    })
    if (!resp.ok) return null
    const feed = (await resp.json()) as JackpotFeed
    return feed && typeof feed === 'object' && feed.games ? feed : null
  } catch {
    return null
  }
}

/**
 * The advertised jackpot for a specific game and draw date, or null when the
 * feed has nothing for that draw. Matching on the date is what keeps a stale
 * feed from ever showing yesterday's prize against tomorrow's draw.
 */
export function feedJackpotFor(
  feed: JackpotFeed | null, game: SyncKey | undefined, drawDate: string,
): JackpotFeedEntry | null {
  if (!feed || !game) return null
  const entry = feed.games?.[game]
  if (!entry || entry.drawDate !== drawDate) return null
  return isPlausibleEntry(entry) ? entry : null
}
