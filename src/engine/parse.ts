import type { Draw } from './types.ts'
import { dowOf, isoKey, parseDateToken } from './dates.ts'

export interface ParseOutcome {
  draws: Draw[]
  errors: string[]
  warnings: string[]
}

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

/**
 * Interpret rows of cells as draw history.
 * Expected shape: Date | [Day of week] | N1 | N2 | N3 | N4 | N5 [| extra ignored]
 * Column order is detected per file; day-of-week column is optional.
 */
export function rowsToDraws(rowsIn: Cell[][]): ParseOutcome {
  const errors: string[] = []
  const warnings: string[] = []
  let rows = rowsIn.filter((r) => r.some((c) => String(c).trim() !== ''))
  if (rows.length === 0) return { draws: [], errors: ['No rows found in the file.'], warnings }

  if (isHeaderRow(rows[0])) rows = rows.slice(1)
  if (rows.length === 0) return { draws: [], errors: ['Only a header row was found.'], warnings }

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

  const draws: Draw[] = []
  const seen = new Map<string, string>() // dateKey+numbers -> first line
  let ignoredExtraCols = false
  let dowMismatches = 0

  rows.forEach((cells, idx) => {
    const line = idx + 1
    const date = parseDateToken(cells[0] ?? '', dayFirst)
    if (!date) {
      errors.push(`Row ${line}: could not read "${String(cells[0] ?? '')}" as a date.`)
      return
    }
    let rest = cells.slice(1)
    if (rest.length > 0 && isDowWord(rest[0])) rest = rest.slice(1)

    const nums: number[] = []
    for (const c of rest) {
      if (String(c).trim() === '') continue
      const n = asInt(c)
      if (n === null) {
        if (nums.length >= 5) { ignoredExtraCols = true; continue }
        errors.push(`Row ${line}: "${String(c)}" is not a whole number.`)
        return
      }
      if (nums.length < 5) nums.push(n)
      else ignoredExtraCols = true
    }
    if (nums.length !== 5) {
      errors.push(`Row ${line}: found ${nums.length} numbers, need exactly 5.`)
      return
    }
    if (nums.some((n) => n < 1 || n > 999)) {
      errors.push(`Row ${line}: numbers must be between 1 and 999.`)
      return
    }
    if (new Set(nums).size !== 5) {
      errors.push(`Row ${line}: duplicate number within the draw (${nums.join(', ')}).`)
      return
    }

    const iso = isoKey(date.y, date.m, date.d)
    const dow = dowOf(iso)
    if (cells.length > 1 && isDowWord(cells[1])) {
      const word = String(cells[1]).trim().toLowerCase().slice(0, 3)
      const expect = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dow]
      if (word !== expect) dowMismatches++
    }

    const key = `${iso}|${[...nums].sort((a, b) => a - b).join(',')}`
    if (seen.has(key)) {
      warnings.push(`Row ${line}: duplicate of an earlier row for ${iso} — skipped.`)
      return
    }
    seen.set(key, iso)
    draws.push({ date: iso, dow, numbers: nums, sorted: [...nums].sort((a, b) => a - b) })
  })

  if (ignoredExtraCols) warnings.push('Extra columns beyond the first five numbers were ignored (e.g. a bonus ball).')
  if (dowMismatches > 0) {
    warnings.push(`${dowMismatches} row(s) had a day-of-week label that does not match the date; the date wins.`)
  }

  draws.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { draws, errors, warnings }
}

export function parseDelimitedText(text: string): ParseOutcome {
  return rowsToDraws(splitDelimited(text))
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
  const head = 'Date,Day of Week,Number 1,Number 2,Number 3,Number 4,Number 5'
  const dows = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const lines = draws.map((d) => `${d.date},${dows[d.dow]},${d.numbers.join(',')}`)
  return [head, ...lines].join('\n')
}
