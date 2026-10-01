import type { Draw } from './types.ts'
import type { SyncKey } from './sync.ts'
import { dowOf } from './dates.ts'

/**
 * The full draw history for one game, published next to the app.
 *
 * No single public source has all of it. New York's open data begins in 2010
 * for Powerball but reaches back to 2002 for Mega Millions; Louisiana's CSV
 * reaches back to 1995 for Powerball but only to 2011 for Mega Millions, and
 * sends no CORS header so a browser cannot read it at all. A scheduled job
 * merges both server-side and writes the union here, which is same-origin and
 * therefore always readable.
 *
 * Rows are positional rather than keyed objects — at 3,500+ draws the field
 * names would be most of the file.
 */
export interface HistoryFile {
  game: SyncKey
  /** When the file was built, ISO-8601 UTC */
  updated: string
  first: string
  last: string
  count: number
  /** Where each draw came from, for the import summary */
  sources: string[]
  /** [dateISO, ...mains, special|0, jackpot|0, winnerLocation|''] */
  rows: (string | number)[][]
}

export function encodeHistory(game: SyncKey, draws: Draw[], sources: string[]): HistoryFile {
  const rows = draws.map((d) => [
    d.date,
    ...d.sorted,
    d.special ?? 0,
    d.jackpot ?? 0,
    d.winnerLocation ?? '',
  ])
  return {
    game,
    updated: new Date().toISOString(),
    first: draws[0]?.date ?? '',
    last: draws[draws.length - 1]?.date ?? '',
    count: draws.length,
    sources,
    rows,
  }
}

/** Rebuild draws from the published rows, dropping anything malformed. */
export function decodeHistory(file: HistoryFile | null): Draw[] {
  if (!file || !Array.isArray(file.rows)) return []
  const out: Draw[] = []
  for (const row of file.rows) {
    if (!Array.isArray(row) || row.length < 4) continue
    const date = String(row[0])
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    // everything between the date and the trailing special/jackpot/location
    const mains = row.slice(1, row.length - 3).map(Number)
    if (mains.length < 4 || mains.some((n) => !Number.isInteger(n) || n < 1)) continue
    const special = Number(row[row.length - 3])
    const jackpot = Number(row[row.length - 2])
    const location = String(row[row.length - 1] ?? '')
    const sorted = [...mains].sort((a, b) => a - b)
    const draw: Draw = { date, dow: dowOf(date), numbers: mains, sorted }
    if (Number.isInteger(special) && special > 0) draw.special = special
    if (Number.isFinite(jackpot) && jackpot > 0) draw.jackpot = jackpot
    if (location) draw.winnerLocation = location
    out.push(draw)
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return out
}

const fileName = (game: SyncKey) => `history-${game}.json`

/**
 * Merge freshly fetched draws with the history already held, so a source that
 * goes thin can only fail to add and never takes anything away.
 *
 * The sources are authoritative for every date they cover — a correction there
 * replaces what was held — and the prior histories fill only the dates no
 * source carries any more. Prior histories are taken in order, the first one
 * to hold a date winning, so pass the most trusted first.
 *
 * Written after New York cut its Mega Millions dataset to one draw a month in
 * September 2026: the build came out short, a "never publish anything shorter"
 * guard kept the committed copy instead, and the published history sat at 31
 * July for two months while Louisiana had every draw the whole time.
 */
export function fillFromPrior(fromSources: Draw[], ...prior: Draw[][]): { merged: Draw[]; kept: number } {
  const covered = new Set(fromSources.map((d) => d.date))
  const held = new Map<string, Draw>()
  for (const list of prior) for (const d of list) if (!covered.has(d.date) && !held.has(d.date)) held.set(d.date, d)
  const merged = [...fromSources, ...held.values()]
  merged.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { merged, kept: held.size }
}

/** Resolved against the page, so it works under the app's sub-path. */
export function historyUrl(baseUri: string, game: SyncKey, stamp: number): string {
  return new URL(`${fileName(game)}?t=${stamp}`, baseUri).href
}

/**
 * Read the published history. Returns null rather than throwing whenever it is
 * unavailable, so the caller can fall back to the live results API.
 */
export async function fetchPublishedHistory(game: SyncKey): Promise<HistoryFile | null> {
  if (typeof document === 'undefined') return null
  try {
    const resp = await fetch(historyUrl(document.baseURI, game, Math.floor(Date.now() / 6e5)), {
      headers: { Accept: 'application/json' },
    })
    if (!resp.ok) return null
    const file = (await resp.json()) as HistoryFile
    return file && Array.isArray(file.rows) && file.rows.length > 0 ? file : null
  } catch {
    return null
  }
}
