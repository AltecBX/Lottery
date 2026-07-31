import { useEffect, useState } from 'react'
import type { Countdown } from '../engine/drawtime.ts'

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Split the remaining time into the tiles to show. Days only appear once the
 * hours would run past two digits, so the usual few-days-out case reads the way
 * the operators' own boards do: "40 HOURS", not "1 DAY 16 HOURS".
 */
export function flipUnits(c: Countdown): { value: number; label: string }[] {
  const totalHours = c.days * 24 + c.hours
  const units: { value: number; label: string }[] = []
  if (totalHours >= 100) {
    units.push({ value: c.days, label: 'Days' })
    units.push({ value: c.hours, label: 'Hours' })
  } else {
    units.push({ value: totalHours, label: 'Hours' })
  }
  units.push({ value: c.minutes, label: 'Minutes' })
  units.push({ value: c.seconds, label: 'Seconds' })
  return units
}

/**
 * One split-flap tile. The static top already shows the new value; the folding
 * leaf on top of it still shows the old one and swings away to reveal it, while
 * the lower leaf swings up carrying the new value over the old bottom half.
 */
function FlipUnit({ value, label }: { value: number; label: string }) {
  const [state, setState] = useState(() => ({ cur: value, prev: value, gen: 0 }))

  useEffect(() => {
    setState((s) => (s.cur === value ? s : { cur: value, prev: s.cur, gen: s.gen + 1 }))
  }, [value])

  const next = pad(state.cur)
  const old = pad(state.prev)

  return (
    <div className="flip-unit">
      {/* remounting on `gen` is what restarts the CSS animation each tick */}
      <div className="flip-card" key={state.gen} aria-hidden="true">
        <span className="fc-half fc-top"><i>{next}</i></span>
        <span className="fc-half fc-bottom"><i>{old}</i></span>
        <span className="fc-half fc-fold-top"><i>{old}</i></span>
        <span className="fc-half fc-fold-bottom"><i>{next}</i></span>
      </div>
      <span className="flip-label">{label}</span>
    </div>
  )
}

/** The whole countdown, read out to assistive tech as plain text. */
export function FlipClock({ countdown, size = 'md' }: { countdown: Countdown; size?: 'sm' | 'md' }) {
  const units = flipUnits(countdown)
  const spoken = units.map((u) => `${u.value} ${u.label.toLowerCase()}`).join(', ')
  return (
    <div className={`flip-clock ${size}`} role="timer" aria-label={`${spoken} until the draw`}>
      {units.map((u) => (
        <FlipUnit key={u.label} value={u.value} label={u.label} />
      ))}
    </div>
  )
}
