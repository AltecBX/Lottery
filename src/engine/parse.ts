import type { Draw } from './types.ts'
import { dowOf, isoKey, parseDateToken } from './dates.ts'

export interface ParseOutcome {
  draws: Draw[]
  errors: string[]
  warnings: string[]
  /** Numbers per draw detected (or enforced) for this batch */
  drawSize: number
}

export const MIN_DRAW_SIZE = 4
export const MAX_DRAW_SIZE = 10

type Cell = string | number

/** Split raw CSV/TSV/pipe text into rows of cells, honoring quoted fields. */
export function splitDelimited(text: string): Cell[][] {
  const firstLines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 12)
  const candidates = [',', '\t', ';', '|'] as const
  let delim: string = ','
  let best = 0
  for (const c of candidates) {
    const counts = firstLines.map((l) => l.split(c).length - 1)
    const min = Math.min(...counts)
    if (min > best) { best = min; delim = c }
  }

  const rows: Cell[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const pushField = () => { row.push(field.trim()); field = '' }
  const pushRow = () => {
    if (row.some((c) => c !== '')) rows.push(row)
    row = []
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delim) {
      pushField()
    } else if (ch === '\n') {
      pushField(); pushRow()
    } else if (ch === '\r') {
      // swallow; \n handles the row break
    } else {
      field += ch
    }
  }
  pushField(); pushRow()
  return rows
}

const DOW_WORDS = new Set([
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'sun', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat',
])

function isDowWord(c: Cell): boolean {
  return typeof c === 'string' && DOW_WORDS.has(c.trim().toLowerCase())
}

function isHeaderRow(cells: Cell[]): boolean {
  let words = 0
  for (const c of cells) {
    if (typeof c === 'string' && /[A-Za-z]{2,}/.test(c) && !isDowWord(c) && !parseDateToken(c, false)) words++
  }
  return words >= 2
}

function asInt(c: Cell): number | null {
  if (typeof c === 'number') return Number.isInteger(c) ? c : null
  const s = c.trim()
  if (!/^\d{1,3}$/.test(s)) return null
  return Number(s)
}

interface PendingRow {
  line: number
  iso: string
  dow: number
  dowMismatch: boolean
  numerics: number[]
}

/**
 * Interpret rows of cells as draw history.
 * Expected shape: Date | [Day of week] | N1 … Nk [| extra ignored]
 * The numbers-per-draw count is auto-detected (most common count across rows,
 * 4–10) unless `expectedSize` pins it — useful when a file carries bonus balls.
 */
export function rowsToDraws(rowsIn: Cell[][], expectedSize = 0): ParseOutcome {
  const errors: string[] = []
  const warnings: string[] = []
  let rows = rowsIn.filter((r) => r.some((c) => String(c).trim() !== ''))
  if (rows.length === 0) return { draws: [], errors: ['No rows found in the file.'], warnings, drawSize: 0 }

  if (isHeaderRow(rows[0])) rows = rows.slice(1)
  if (rows.length === 0) return { draws: [], errors: ['Only a header row was found.'], warnings, drawSize: 0 }

  // Decide day-first vs month-first by scanning ambiguous triples across the file
  let dayFirst = false
  {
    let mdEvidence = 0, dmEvidence = 0
    for (const r of rows) {
      for (const c of r) {
        if (typeof c !== 'string') continue
        const m = c.trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/)
        if (m) {
          const a = Number(m[1]), b = Number(m[2])
          if (a > 12 && b <= 12) dmEvidence++
          if (b > 12 && a <= 12) mdEvidence++
        }
        break // only the first cell can be the date
      }
    }
    if (dmEvidence > mdEvidence) dayFirst = true
    if (dmEvidence > 0 && mdEvidence > 0) {
      warnings.push('Dates mix day-first and month-first patterns; interpreted as ' + (dayFirst ? 'day-first.' : 'month-first.'))
    }
  }

  // Pass 1: extract date, optional day word, and every numeric cell per row
  const pending: PendingRow[] = []
  let dowMismatches = 0
  rows.forEach((cells, idx) => {
    const line = idx + 1
    const date = parseDateToken(cells[0] ?? '', dayFirst)
    if (!date) {
      errors.push(`Row ${line}: could not read "${String(cells[0] ?? '')}" as a date.`)
      return
    }
    let rest = cells.slice(1)
    let dowMismatch = false
    const iso = isoKey(date.y, date.m, date.d)
    const dow = dowOf(iso)
    if (rest.length > 0 && isDowWord(rest[0])) {
      const word = String(rest[0]).trim().toLowerCase().slice(0, 3)
      const expect = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dow]
      if (word !== expect) dowMismatch = true
      rest = rest.slice(1)
    }
    const numerics: number[] = []
    for (const c of rest) {
      if (String(c).trim() === '') continue
      const n = asInt(c)
      if (n === null) {
        if (numerics.length === 0) {
          errors.push(`Row ${line}: "${String(c)}" is not a whole number.`)
          return
        }
        continue // trailing text columns are ignored
      }
      if (numerics.length < MAX_DRAW_SIZE + 2) numerics.push(n)
    }
    pending.push({ line, iso, dow, dowMismatch, numerics })
    if (dowMismatch) dowMismatches++
  })

  if (pending.length === 0) {
    return { draws: [], errors, warnings, drawSize: 0 }
  }

  // Determine numbers-per-draw: explicit override, else the most common count
  let drawSize = expectedSize
  if (drawSize <= 0) {
    const countFreq = new Map<number, number>()
    for (const p of pending) {
      const c = Math.min(p.numerics.length, MAX_DRAW_SIZE)
      countFreq.set(c, (countFreq.get(c) ?? 0) + 1)
    }
    let bestCount = 0, bestFreq = -1
    for (const [c, f] of countFreq) {
      if (f > bestFreq || (f === bestFreq && c > bestCount)) { bestCount = c; bestFreq = f }
    }
    drawSize = bestCount
  }
  if (drawSize < MIN_DRAW_SIZE || drawSize > MAX_DRAW_SIZE) {
    errors.push(`Rows carry ${drawSize} numbers — supported games have ${MIN_DRAW_SIZE}–${MAX_DRAW_SIZE} numbers per draw.`)
    return { draws: [], errors, warnings, drawSize: 0 }
  }

  // Pass 2: validate each row against the draw size
  const draws: Draw[] = []
  const seen = new Set<string>()
  let ignoredExtraCols = 0
  let duplicates = 0
  for (const p of pending) {
    if (p.numerics.length < drawSize) {
      errors.push(`Row ${p.line}: found ${p.numerics.length} numbers, need ${drawSize}.`)
      continue
    }
    if (p.numerics.length > drawSize) ignoredExtraCols++
    const nums = p.numerics.slice(0, drawSize)
    if (nums.some((n) => n < 1 || n > 999)) {
      errors.push(`Row ${p.line}: numbers must be between 1 and 999.`)
      continue
    }
    if (new Set(nums).size !== drawSize) {
      errors.push(`Row ${p.line}: duplicate number within the draw (${nums.join(', ')}).`)
      continue
    }
    const sorted = [...nums].sort((a, b) => a - b)
    const key = `${p.iso}|${sorted.join(',')}`
    if (seen.has(key)) {
      duplicates++
      continue
    }
    seen.add(key)
    draws.push({ date: p.iso, dow: p.dow, numbers: nums, sorted })
  }

  if (ignoredExtraCols > 0) {
    warnings.push(`${ignoredExtraCols} row(s) had extra number columns beyond the first ${drawSize} — ignored (e.g. a bonus ball). If that's wrong, set "Numbers per draw" in Settings and re-import.`)
  }
  if (duplicates > 0) warnings.push(`${duplicates} duplicate row(s) skipped.`)
  if (dowMismatches > 0) {
    warnings.push(`${dowMismatches} row(s) had a day-of-week label that does not match the date; the date wins.`)
  }

  draws.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { draws, errors, warnings, drawSize }
}

export function parseDelimitedText(text: string, expectedSize = 0): ParseOutcome {
  return rowsToDraws(splitDelimited(text), expectedSize)
}

/** Merge new draws into existing history, skipping exact duplicates. */
export function mergeDraws(existing: Draw[], incoming: Draw[]): { merged: Draw[]; added: number; skipped: number } {
  const key = (d: Draw) => `${d.date}|${d.sorted.join(',')}`
  const have = new Set(existing.map(key))
  const merged = [...existing]
  let added = 0, skipped = 0
  for (const d of incoming) {
    if (have.has(key(d))) { skipped++; continue }
    have.add(key(d))
    merged.push(d)
    added++
  }
  merged.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { merged, added, skipped }
}

/** Serialize history back to CSV for export. */
export function drawsToCsv(draws: Draw[]): string {
  const n = draws.length > 0 ? draws[0].numbers.length : 5
  const head = ['Date', 'Day of Week', ...Array.from({ length: n }, (_, i) => `Number ${i + 1}`)].join(',')
  const dows = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const lines = draws.map((d) => `${d.date},${dows[d.dow]},${d.numbers.join(',')}`)
  return [head, ...lines].join('\n')
}
