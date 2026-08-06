import type { Draw } from './types.ts'
import { parseDelimitedText, type ParseOutcome } from './parse.ts'
import { decodeHistory, fetchPublishedHistory } from './history.ts'
import { dowOf } from './dates.ts'

/**
 * Official draw-result sources (NY Open Data / Socrata — CORS-enabled public
 * APIs of record). Fetched only when the user clicks Sync; nothing automatic.
 */
export const SYNC_SOURCES = [
  {
    key: 'powerball' as const,
    label: 'US Powerball',
    url: 'https://data.ny.gov/resource/d6yy-54nr.json?$limit=5000&$order=draw_date%20ASC',
  },
  {
    key: 'megamillions' as const,
    label: 'Mega Millions',
    url: 'https://data.ny.gov/resource/5xaw-6ayf.json?$limit=5000&$order=draw_date%20ASC',
  },
]

export type SyncKey = (typeof SYNC_SOURCES)[number]['key']

interface SocrataRow {
  draw_date?: string
  winning_numbers?: string
  mega_ball?: string
}

/** Map raw Socrata rows to draws. Exported for tests (no network involved). */
export function parseSocrataRows(rows: SocrataRow[], key: SyncKey): ParseOutcome {
  const draws: Draw[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  /*
   * Everything below is defensive on purpose. `??` does not coerce, so a
   * numeric `draw_date` or an array `winning_numbers` used to throw straight
   * out of the loop and take the entire sync with it — five thousand good rows
   * discarded because one was odd. A bad row is skipped; the rest still land.
   */
  if (!Array.isArray(rows)) return { draws: [], errors: ['The official source returned an unexpected payload.'], warnings: [], drawSize: 0, hasSpecial: false }
  for (const row of rows) {
    const dateRaw = String(row?.draw_date ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) continue
    const parts = String(row?.winning_numbers ?? '').trim().split(/\s+/).map(Number)
    let mains: number[]
    let special: number | undefined
    if (key === 'powerball') {
      // winning_numbers carries 5 mains + the Powerball last
      if (parts.length < 6 || parts.some((n) => !Number.isInteger(n) || n < 1)) continue
      mains = parts.slice(0, 5)
      special = parts[5]
    } else {
      // Mega Millions: winning_numbers = 5 mains; mega_ball is its own field
      if (parts.length < 5 || parts.slice(0, 5).some((n) => !Number.isInteger(n) || n < 1)) continue
      mains = parts.slice(0, 5)
      const mb = Number(row.mega_ball)
      special = Number.isInteger(mb) && mb >= 1 ? mb : undefined
    }
    if (new Set(mains).size !== 5) continue
    const sorted = [...mains].sort((a, b) => a - b)
    const dupKey = `${dateRaw}|${sorted.join(',')}|${special ?? ''}`
    if (seen.has(dupKey)) continue
    seen.add(dupKey)
    const draw: Draw = { date: dateRaw, dow: dowOf(dateRaw), numbers: mains, sorted }
    if (special !== undefined) draw.special = special
    draws.push(draw)
  }
  draws.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const warnings: string[] = []
  if (draws.length > 0) {
    warnings.push('Official history reaches back through older rule eras. Those draws are kept but not analyzed, since a retired number pool distorts the odds — Settings › "Which draws to analyze" switches between the current rules and everything.')
  }
  return {
    draws,
    errors: draws.length === 0 ? ['The source returned no usable rows.'] : errors,
    warnings,
    drawSize: 5,
    hasSpecial: draws.some((d) => d.special !== undefined),
  }
}

/**
 * The deepest history available for a game.
 *
 * Prefers the merged file published alongside the app, which is the union of
 * every public source and reaches back to 1995 for Powerball and 2002 for Mega
 * Millions. The live New York API is the fallback: always current, but it only
 * begins in 2010 for Powerball.
 */
export async function fetchOfficialResults(key: SyncKey): Promise<ParseOutcome> {
  const published = await fetchPublishedHistory(key)
  if (published) {
    const draws = decodeHistory(published)
    if (draws.length > 0) {
      return {
        draws,
        errors: [],
        warnings: [
          `${draws.length.toLocaleString()} draws from ${draws[0].date} — every public source merged, with jackpots and winner locations where they exist.`,
          'This reaches back through older rule eras. Settings › "Which draws to analyze" chooses whether the model reads all of it or only the current rules.',
        ],
        drawSize: draws[0].sorted.length,
        hasSpecial: draws.some((d) => d.special !== undefined),
      }
    }
  }

  const source = SYNC_SOURCES.find((s) => s.key === key)!
  const resp = await fetch(source.url, { headers: { Accept: 'application/json' } })
  if (!resp.ok) throw new Error(`${source.label} source responded ${resp.status}`)
  const rows = (await resp.json()) as SocrataRow[]
  return parseSocrataRows(rows, key)
}

/**
 * Louisiana Lottery's public CSV exports. These carry more per draw than the
 * results API: the advertised jackpot, the cash value, and where a winning
 * ticket was sold — plus Powerball history back to 1995.
 *
 * The site sends no `Access-Control-Allow-Origin` header, so a browser cannot
 * read it cross-origin; `fetchCsvSource` still tries (it works when the app is
 * run locally or if the header is ever added) and otherwise the file downloads
 * and drops straight into the importer, which understands this exact layout.
 */
export const CSV_SOURCES = [
  { key: 'powerball' as const, label: 'Powerball', url: 'https://louisianalottery.com/csv/powerball.csv' },
  { key: 'megamillions' as const, label: 'Mega Millions', url: 'https://louisianalottery.com/csv/mega-millions.csv' },
]

export function csvSourceUrl(key: SyncKey): string {
  return CSV_SOURCES.find((s) => s.key === key)!.url
}

export async function fetchCsvSource(key: SyncKey): Promise<ParseOutcome> {
  const source = CSV_SOURCES.find((s) => s.key === key)!
  const resp = await fetch(source.url, { headers: { Accept: 'text/csv' } })
  if (!resp.ok) throw new Error(`${source.label} CSV responded ${resp.status}`)
  return parseDelimitedText(await resp.text())
}

/**
 * Statewide New York ticket sales per day, aggregated server-side from the
 * retailer sales dataset (xyvi-fbb9, daily from 2024). Sales are the closest
 * public measure of how many people actually played a given draw — which is
 * what decides whether a jackpot gets split, not which numbers come up.
 */
const SALES_URL = 'https://data.ny.gov/resource/xyvi-fbb9.json'
const SALES_COLUMN: Record<SyncKey, string> = { powerball: 'powerball', megamillions: 'mega' }

interface SalesRow { bus_day?: string; total?: string }

/** Map raw aggregated sales rows to a date → dollars lookup. Pure, for tests. */
export function parseSalesRows(rows: SalesRow[]): Map<string, number> {
  const out = new Map<string, number>()
  if (!Array.isArray(rows)) return out
  for (const r of rows) {
    const date = String(r?.bus_day ?? '').slice(0, 10)
    const amount = Number(r.total)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount) || amount <= 0) continue
    out.set(date, amount)
  }
  return out
}

export async function fetchSalesByDay(key: SyncKey): Promise<Map<string, number>> {
  const col = SALES_COLUMN[key]
  const url =
    `${SALES_URL}?$select=bus_day,sum(${col})%20as%20total&$group=bus_day&$order=bus_day%20DESC&$limit=5000`
  const resp = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!resp.ok) throw new Error(`sales source responded ${resp.status}`)
  return parseSalesRows((await resp.json()) as SalesRow[])
}

/** Attach sales figures to the draws that have them; leaves the rest untouched. */
export function attachSales(draws: Draw[], sales: Map<string, number>): { draws: Draw[]; matched: number } {
  let matched = 0
  const out = draws.map((d) => {
    const amount = sales.get(d.date)
    if (amount === undefined) return d
    matched++
    return { ...d, sales: amount }
  })
  return { draws: out, matched }
}
