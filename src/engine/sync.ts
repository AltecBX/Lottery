import type { Draw } from './types.ts'
import type { ParseOutcome } from './parse.ts'
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
  for (const row of rows) {
    const dateRaw = (row.draw_date ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) continue
    const parts = (row.winning_numbers ?? '').trim().split(/\s+/).map(Number)
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
    warnings.push('Official history includes old rule eras — if a "Rule change detected" banner appears after import, use "Trim to current era" for honest stats.')
  }
  return {
    draws,
    errors: draws.length === 0 ? ['The source returned no usable rows.'] : errors,
    warnings,
    drawSize: 5,
    hasSpecial: draws.some((d) => d.special !== undefined),
  }
}

export async function fetchOfficialResults(key: SyncKey): Promise<ParseOutcome> {
  const source = SYNC_SOURCES.find((s) => s.key === key)!
  const resp = await fetch(source.url, { headers: { Accept: 'application/json' } })
  if (!resp.ok) throw new Error(`${source.label} source responded ${resp.status}`)
  const rows = (await resp.json()) as SocrataRow[]
  return parseSocrataRows(rows, key)
}
