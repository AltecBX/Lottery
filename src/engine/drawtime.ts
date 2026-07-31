import type { SyncKey } from './sync.ts'

/**
 * Official draw times, in the operator's own timezone. Powerball draws at
 * 10:59 PM Eastern (Mon/Wed/Sat); Mega Millions at 11:00 PM Eastern (Tue/Fri).
 */
export const DRAW_TIMES: Record<SyncKey, { hour: number; minute: number; zone: string; label: string }> = {
  powerball: { hour: 22, minute: 59, zone: 'America/New_York', label: '10:59 PM ET' },
  megamillions: { hour: 23, minute: 0, zone: 'America/New_York', label: '11:00 PM ET' },
}

/**
 * Convert a wall-clock time in a named zone to the exact UTC instant, honoring
 * daylight saving. Formats the guess back in the target zone and corrects by
 * whatever offset that reveals.
 */
export function zonedTimeToInstant(
  y: number, month: number, day: number, hour: number, minute: number, zone: string,
): Date {
  const guess = Date.UTC(y, month - 1, day, hour, minute)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]))
  const shown = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  )
  return new Date(guess - (shown - guess))
}

/**
 * The exact moment the next draw happens. Official games use their published
 * time in the operator's zone; any other game uses `localTime` ("HH:MM") read
 * as the viewer's own clock, so every game still gets a live countdown.
 */
export function nextDrawInstant(dateIso: string, syncKey?: SyncKey, localTime = '22:59'): Date | null {
  const [y, m, d] = dateIso.split('-').map(Number)
  if (!y || !m || !d) return null
  const official = syncKey ? DRAW_TIMES[syncKey] : undefined
  if (official) return zonedTimeToInstant(y, m, d, official.hour, official.minute, official.zone)
  const [hh, mm] = localTime.split(':').map(Number)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
  return new Date(y, m - 1, d, hh, mm, 0, 0)
}

/** Human label for whichever clock the countdown is using. */
export function drawTimeLabel(syncKey?: SyncKey, localTime = '22:59'): string {
  const official = syncKey ? DRAW_TIMES[syncKey] : undefined
  if (official) return official.label
  const [hh, mm] = localTime.split(':').map(Number)
  const h12 = ((hh + 11) % 12) + 1
  return `${h12}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`
}

export interface Countdown {
  days: number
  hours: number
  minutes: number
  seconds: number
  /** True once the draw time has passed */
  past: boolean
  totalMs: number
}

export function countdownTo(target: Date, now: number = Date.now()): Countdown {
  const ms = target.getTime() - now
  const abs = Math.max(0, ms)
  return {
    days: Math.floor(abs / 86400000),
    hours: Math.floor((abs % 86400000) / 3600000),
    minutes: Math.floor((abs % 3600000) / 60000),
    seconds: Math.floor((abs % 60000) / 1000),
    past: ms <= 0,
    totalMs: ms,
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "3d 04:12:56" or "04:12:56" once inside a day. */
export function formatCountdown(c: Countdown): string {
  const clock = `${pad(c.hours)}:${pad(c.minutes)}:${pad(c.seconds)}`
  return c.days > 0 ? `${c.days}d ${clock}` : clock
}
