import type { Draw } from './types.ts'
import { dowOf, isoKey, parseDateToken } from './dates.ts'

export interface ParseOutcome {
  draws: Draw[]
  errors: string[]
  warnings: string[]
  /** Main numbers per draw detected (or enforced) for this batch */
  drawSize: number
  /** Whether a bonus/special ball column was detected and split off */
  hasSpecial: boolean
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
  jackpot?: number
  winnerLocation?: string
}

// `ball$` catches feed-style headers such as `pb_ball` / `mm_ball`, where the
// underscore blocks a word boundary before "ball".
const BONUS_HEADER = /p(ower)?[\s_-]?ball|pball|bonus|mega[\s_-]?ball|extra|star|lucky|\bpb\b|\bsb\b|ball\s*$/i
/**
 * Columns that are numeric but are NOT drawn balls — a Power Play/Megaplier
 * multiplier is a small integer that would otherwise be counted as a number and
 * throw off draw-size detection. Cash value is a second money column.
 */
const IGNORE_HEADER = /multiplier|multi(plier)?[\s_-]*$|[\s_-]multi\b|^multi\b|power[\s_-]*play|megaplier|cash[\s_-]*value/i
const JACKPOT_HEADER = /jackpot|annuity|grand[\s_-]*prize|top[\s_-]*prize|\bprize\b|advertised/i
/** Checked before jackpot, so a column like "jackpot_win_loc" reads as a place. */
const LOCATION_HEADER = /winner|location|win[\s_-]*loc|won[\s_-]*(in|at|by)?\b|\bloc\b|city|\bstate\b|retailer|store/i

/**
 * Read a money cell: "$1,020,000,000", "1.02B", "245M", "1020000000".
 * Returns null when the cell is not a usable amount.
 */
export function parseMoney(cell: unknown): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) && cell > 0 ? cell : null
  const raw = String(cell ?? '').trim()
  if (raw === '') return null
  const m = raw.match(/^\$?\s*([\d,]+(?:\.\d+)?)\s*(billion|million|thousand|[bmk])?\b/i)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = (m[2] ?? '').toLowerCase()
  const mult = unit.startsWith('b') ? 1e9 : unit.startsWith('m') ? 1e6 : unit.startsWith('k') || unit.startsWith('t') ? 1e3 : 1
  return n * mult
}

/**
 * Interpret rows of cells as draw history.
 * Expected shape: Date | [Day of week] | N1 … Nk [| Bonus]
 * The main-numbers count is auto-detected (most common count across rows,
 * 4–10) unless `expectedSize` pins it. A trailing bonus/special ball column
 * (Powerball-style) is split off when the header names it, the caller forces
 * it, or the values clearly come from a separate smaller pool.
 */
export function rowsToDraws(rowsIn: Cell[][], expectedSize = 0, bonusMode: 'auto' | 'yes' | 'no' = 'auto'): ParseOutcome {
  const errors: string[] = []
  const warnings: string[] = []
  let rows = rowsIn.filter((r) => r.some((c) => String(c).trim() !== ''))
  if (rows.length === 0) return { draws: [], errors: ['No rows found in the file.'], warnings, drawSize: 0, hasSpecial: false }

  let bonusHeaderHit = false
  // Jackpot / winner-location columns are found by header only: guessing from
  // values could swallow a real number column and corrupt the draw size.
  let jackpotIdx = -1
  let locationIdx = -1
  const ignoreIdx = new Set<number>()
  if (isHeaderRow(rows[0])) {
    const header = rows[0]
    for (let i = 0; i < header.length; i++) {
      const cell = String(header[i]).trim()
      if (cell === '') continue
      if (IGNORE_HEADER.test(cell)) ignoreIdx.add(i)
      else if (locationIdx < 0 && LOCATION_HEADER.test(cell) && !BONUS_HEADER.test(cell)) locationIdx = i
      else if (jackpotIdx < 0 && JACKPOT_HEADER.test(cell)) jackpotIdx = i
    }
    for (let i = header.length - 1; i >= 0; i--) {
      const cell = String(header[i]).trim()
      if (cell === '' || i === jackpotIdx || i === locationIdx || ignoreIdx.has(i)) continue
      bonusHeaderHit = BONUS_HEADER.test(cell)
      break
    }
    rows = rows.slice(1)
  }
  // Lift those columns out so the numeric scan below never sees them
  const extras: { jackpot?: number; winnerLocation?: string }[] = []
  if (jackpotIdx >= 0 || locationIdx >= 0 || ignoreIdx.size > 0) {
    rows = rows.map((r) => {
      const copy = [...r]
      const extra: { jackpot?: number; winnerLocation?: string } = {}
      if (jackpotIdx >= 0) {
        const amount = parseMoney(copy[jackpotIdx])
        if (amount !== null) extra.jackpot = amount
        copy[jackpotIdx] = ''
      }
      if (locationIdx >= 0) {
        const loc = String(copy[locationIdx] ?? '').trim()
        if (loc !== '' && !/^(n\/?a|none|-{1,2})$/i.test(loc)) extra.winnerLocation = loc
        copy[locationIdx] = ''
      }
      for (const i of ignoreIdx) copy[i] = ''
      extras.push(extra)
      return copy
    })
  }
  if (rows.length === 0) return { draws: [], errors: ['Only a header row was found.'], warnings, drawSize: 0, hasSpecial: false }

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
    // Some official exports append a second table after the draw rows; those
    // trailing records have no date in the first cell, so skip them quietly.
    if (String(cells[0] ?? '').trim() === '') return
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
    const extra = extras[idx]
    pending.push({ line, iso, dow, dowMismatch, numerics, jackpot: extra?.jackpot, winnerLocation: extra?.winnerLocation })
    if (dowMismatch) dowMismatches++
  })

  if (pending.length === 0) {
    return { draws: [], errors, warnings, drawSize: 0, hasSpecial: false }
  }

  // Decide whether the last numeric column is a bonus/special ball
  let hasSpecial = false
  {
    const counts = pending.map((p) => p.numerics.length)
    const modal = (() => {
      const f = new Map<number, number>()
      for (const c of counts) f.set(c, (f.get(c) ?? 0) + 1)
      let bc = 0, bf = -1
      for (const [c, ff] of f) if (ff > bf || (ff === bf && c > bc)) { bc = c; bf = ff }
      return bc
    })()
    if (bonusMode === 'yes') {
      hasSpecial = modal >= MIN_DRAW_SIZE + 1
      if (!hasSpecial) warnings.push('Bonus-ball mode is on, but rows do not carry enough number columns for it.')
    } else if (bonusMode === 'auto' && modal >= MIN_DRAW_SIZE + 1) {
      if (bonusHeaderHit) {
        hasSpecial = true
      } else {
        // Value heuristics over rows with the modal count: the last column comes
        // from a clearly smaller pool AND breaks the ascending order of the mains
        const full = pending.filter((p) => p.numerics.length >= modal)
        if (full.length >= 10) {
          let maxMains = 0, maxLast = 0, sortedMains = 0, breaksSort = 0
          for (const p of full) {
            const mains = p.numerics.slice(0, modal - 1)
            const last = p.numerics[modal - 1]
            maxLast = Math.max(maxLast, last)
            for (const v of mains) maxMains = Math.max(maxMains, v)
            const asc = mains.every((v, i) => i === 0 || v >= mains[i - 1])
            if (asc) sortedMains++
            if (asc && last < mains[mains.length - 1]) breaksSort++
          }
          const rangeHit = maxLast * 1.8 <= maxMains && maxLast <= 45
          const sortHit = sortedMains / full.length >= 0.9 && breaksSort / full.length >= 0.3
          hasSpecial = rangeHit && sortHit
        }
      }
    }
  }

  // Determine main numbers-per-draw: explicit override, else the most common count
  let drawSize = expectedSize
  if (drawSize <= 0) {
    const countFreq = new Map<number, number>()
    for (const p of pending) {
      const c = Math.min(p.numerics.length, MAX_DRAW_SIZE + (hasSpecial ? 1 : 0))
      countFreq.set(c, (countFreq.get(c) ?? 0) + 1)
    }
    let bestCount = 0, bestFreq = -1
    for (const [c, f] of countFreq) {
      if (f > bestFreq || (f === bestFreq && c > bestCount)) { bestCount = c; bestFreq = f }
    }
    drawSize = bestCount - (hasSpecial ? 1 : 0)
  }
  if (drawSize < MIN_DRAW_SIZE || drawSize > MAX_DRAW_SIZE) {
    errors.push(`Rows carry ${drawSize} main numbers — supported games have ${MIN_DRAW_SIZE}–${MAX_DRAW_SIZE} numbers per draw.`)
    return { draws: [], errors, warnings, drawSize: 0, hasSpecial: false }
  }
  const needed = drawSize + (hasSpecial ? 1 : 0)

  // Pass 2: validate each row against the draw size
  const draws: Draw[] = []
  const seen = new Set<string>()
  let ignoredExtraCols = 0
  let duplicates = 0
  for (const p of pending) {
    if (p.numerics.length < needed) {
      errors.push(`Row ${p.line}: found ${p.numerics.length} numbers, need ${needed}${hasSpecial ? ` (${drawSize} + bonus ball)` : ''}.`)
      continue
    }
    if (p.numerics.length > needed) ignoredExtraCols++
    const nums = p.numerics.slice(0, drawSize)
    // The bonus ball is the LAST numeric on the row (extra middle columns are trimmed)
    const special = hasSpecial ? p.numerics[Math.min(p.numerics.length, needed) - 1] : undefined
    if (nums.some((n) => n < 1 || n > 999) || (special !== undefined && (special < 1 || special > 999))) {
      errors.push(`Row ${p.line}: numbers must be between 1 and 999.`)
      continue
    }
    if (new Set(nums).size !== drawSize) {
      errors.push(`Row ${p.line}: duplicate number within the draw (${nums.join(', ')}).`)
      continue
    }
    const sorted = [...nums].sort((a, b) => a - b)
    const key = `${p.iso}|${sorted.join(',')}|${special ?? ''}`
    if (seen.has(key)) {
      duplicates++
      continue
    }
    seen.add(key)
    const draw: Draw = { date: p.iso, dow: p.dow, numbers: nums, sorted }
    if (special !== undefined) draw.special = special
    if (p.jackpot !== undefined) draw.jackpot = p.jackpot
    if (p.winnerLocation !== undefined) draw.winnerLocation = p.winnerLocation
    draws.push(draw)
  }
  const withJackpot = draws.filter((d) => d.jackpot !== undefined).length
  if (withJackpot > 0) warnings.push(`Read a jackpot amount for ${withJackpot.toLocaleString()} draw(s) — see the Jackpot & players panel.`)

  if (hasSpecial) {
    warnings.push(`Detected ${drawSize} main numbers + a bonus ball column — the bonus is analyzed in its own pool. (Wrong? Set "Bonus ball" in Settings and re-import.)`)
  }

  if (ignoredExtraCols > 0) {
    warnings.push(`${ignoredExtraCols} row(s) had extra number columns beyond the first ${drawSize} — ignored (e.g. a bonus ball). If that's wrong, set "Numbers per draw" in Settings and re-import.`)
  }
  if (duplicates > 0) warnings.push(`${duplicates} duplicate row(s) skipped.`)
  if (dowMismatches > 0) {
    warnings.push(`${dowMismatches} row(s) had a day-of-week label that does not match the date; the date wins.`)
  }

  draws.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { draws, errors, warnings, drawSize, hasSpecial }
}

export function parseDelimitedText(text: string, expectedSize = 0, bonusMode: 'auto' | 'yes' | 'no' = 'auto'): ParseOutcome {
  return rowsToDraws(splitDelimited(text), expectedSize, bonusMode)
}

/** Merge new draws into existing history, skipping exact duplicates. */
export function mergeDraws(existing: Draw[], incoming: Draw[]): { merged: Draw[]; added: number; skipped: number } {
  const key = (d: Draw) => `${d.date}|${d.sorted.join(',')}|${d.special ?? ''}`
  const byKey = new Map(existing.map((d) => [key(d), d]))
  const merged = [...existing]
  let added = 0, skipped = 0
  for (const d of incoming) {
    const k = key(d)
    const prev = byKey.get(k)
    if (prev) {
      // Same draw seen again: fill in any extra detail it now carries
      if (d.jackpot !== undefined && prev.jackpot === undefined) prev.jackpot = d.jackpot
      if (d.winnerLocation !== undefined && prev.winnerLocation === undefined) prev.winnerLocation = d.winnerLocation
      if (d.sales !== undefined && prev.sales === undefined) prev.sales = d.sales
      skipped++
      continue
    }
    byKey.set(k, d)
    merged.push(d)
    added++
  }
  merged.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { merged, added, skipped }
}

/** Serialize history back to CSV for export. */
export function drawsToCsv(draws: Draw[]): string {
  const n = draws.length > 0 ? draws[0].numbers.length : 5
  const hasSpecial = draws.some((d) => d.special !== undefined)
  const hasJackpot = draws.some((d) => d.jackpot !== undefined)
  const hasLocation = draws.some((d) => d.winnerLocation)
  const head = [
    'Date', 'Day of Week',
    ...Array.from({ length: n }, (_, i) => `Number ${i + 1}`),
    ...(hasSpecial ? ['Bonus'] : []),
    ...(hasJackpot ? ['Jackpot'] : []),
    ...(hasLocation ? ['Winner Location'] : []),
  ].join(',')
  const dows = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const lines = draws.map((d) =>
    `${d.date},${dows[d.dow]},${d.numbers.join(',')}` +
    (hasSpecial ? ',' + (d.special ?? '') : '') +
    (hasJackpot ? ',' + (d.jackpot ?? '') : '') +
    (hasLocation ? ',' + quote(d.winnerLocation ?? '') : ''),
  )
  return [head, ...lines].join('\n')
}
