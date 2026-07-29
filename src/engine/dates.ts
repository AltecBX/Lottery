export const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n: number) => String(n).padStart(2, '0')

/** Build an ISO key from calendar parts (no timezone involvement). */
export function isoKey(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`
}

export function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

/** Day of week for an ISO key, 0=Sunday. Uses local calendar math only. */
export function dowOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d + days)
  return isoKey(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[m - 1]} ${d}, ${y}`
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

export interface ParsedDate {
  y: number
  m: number
  d: number
  /** true when the source was like 3/4/2026 and could be M/D or D/M */
  ambiguous: boolean
}

/**
 * Parse a single date token. Supports ISO (2026-03-30), slash/dash/dot triples
 * (3/30/2026, 30.3.2026, 03-30-2026), textual months (Mar 30 2026 / 30 Mar 2026)
 * and Excel serial numbers. `dayFirst` resolves ambiguous triples.
 */
export function parseDateToken(raw: string | number, dayFirst: boolean): ParsedDate | null {
  if (typeof raw === 'number') return fromExcelSerial(raw)
  const s = raw.trim()
  if (!s) return null

  // Excel serial that arrived as a string
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = fromExcelSerial(Number(s))
    if (serial) return serial
  }

  // ISO: 2026-03-30 (optionally with time suffix)
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/)
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    return isValidYmd(y, mo, d) ? { y, m: mo, d, ambiguous: false } : null
  }

  // Triple with /, - or . separators
  m = s.match(/^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/)
  if (m) {
    let a = Number(m[1]), b = Number(m[2]), c = Number(m[3])
    if (a > 999) {
      // YYYY/MM/DD
      return isValidYmd(a, b, c) ? { y: a, m: b, d: c, ambiguous: false } : null
    }
    if (c < 100) c += c < 50 ? 2000 : 1900
    // a and b are month/day in some order
    if (a > 12 && b <= 12) return isValidYmd(c, b, a) ? { y: c, m: b, d: a, ambiguous: false } : null
    if (b > 12 && a <= 12) return isValidYmd(c, a, b) ? { y: c, m: a, d: b, ambiguous: false } : null
    if (a <= 12 && b <= 12) {
      const [mo, d] = dayFirst ? [b, a] : [a, b]
      return isValidYmd(c, mo, d) ? { y: c, m: mo, d, ambiguous: a !== b } : null
    }
    return null
  }

  // Textual month: "Mar 30, 2026" | "March 30 2026" | "30 Mar 2026"
  m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/)
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]
    const d = Number(m[2]), y = Number(m[3])
    if (mo && isValidYmd(y, mo, d)) return { y, m: mo, d, ambiguous: false }
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/)
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]
    const d = Number(m[1]), y = Number(m[3])
    if (mo && isValidYmd(y, mo, d)) return { y, m: mo, d, ambiguous: false }
  }
  return null
}

/** Excel serial date (1900 date system). Day 1 = 1900-01-01; epoch anchor 1899-12-30. */
export function fromExcelSerial(serial: number): ParsedDate | null {
  if (!Number.isFinite(serial) || serial < 6000 || serial > 110000) return null
  const days = Math.floor(serial)
  const ms = (days - 25569) * 86400000 // 25569 = days from 1899-12-30 to 1970-01-01
  const dt = new Date(ms)
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate()
  return isValidYmd(y, m, d) ? { y, m, d, ambiguous: false } : null
}
