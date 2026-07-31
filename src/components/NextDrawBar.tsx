import { useEffect, useMemo, useRef, useState } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import type { GameData } from '../engine/games.ts'
import { projectNextJackpot } from '../engine/jackpot.ts'
import { countdownTo, drawTimeLabel, formatCountdown, nextDrawInstant } from '../engine/drawtime.ts'
import { DOW_NAMES, formatDate } from '../engine/dates.ts'

const bigMoney = (n: number): string => {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)} Billion`
  if (n >= 1e6) return `$${Math.round(n / 1e6)} Million`
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${Math.round(n)}`
}

/**
 * The first thing on screen: what the next draw is worth and exactly how long
 * is left. The prize is the amount typed for this draw when there is one,
 * otherwise an estimate projected from this history's own roll-up.
 */
export function NextDrawBar({ res, game, draws, drawTime, onSetJackpot }: {
  res: EngineResult
  game: GameData | undefined
  draws: Draw[]
  /** Local "HH:MM" fallback for games with no published draw time */
  drawTime: string
  onSetJackpot: (amount: number | null, forDate: string) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const [editing, setEditing] = useState(false)
  const [entry, setEntry] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const target = useMemo(
    () => nextDrawInstant(res.nextDate, game?.syncKey, drawTime),
    [res.nextDate, game?.syncKey, drawTime],
  )

  useEffect(() => {
    if (!target) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [target])

  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  const manual = game?.nextJackpotFor === res.nextDate ? game.nextJackpot : undefined
  const projected = useMemo(() => projectNextJackpot(draws), [draws])
  const amount = manual ?? projected?.amount
  const isEstimate = manual === undefined && projected != null

  const c = target ? countdownTo(target, now) : null
  const drawLabel = drawTimeLabel(game?.syncKey, drawTime)

  const save = () => {
    const cleaned = entry.replace(/[$,\s]/g, '')
    const m = cleaned.match(/^([\d.]+)([bmk])?$/i)
    if (!m) { setEditing(false); return }
    const n = Number(m[1])
    if (!Number.isFinite(n) || n <= 0) { setEditing(false); return }
    const unit = (m[2] ?? '').toLowerCase()
    // A bare number under 10,000 is read as millions — "950" means $950M
    const mult = unit === 'b' ? 1e9 : unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : n < 10000 ? 1e6 : 1
    onSetJackpot(n * mult, res.nextDate)
    setEditing(false)
  }

  return (
    <div className="next-draw">
      <div className="nd-prize">
        <span className="nd-label">
          {game?.name ? `${game.name} — next jackpot` : 'Next jackpot'}
          {isEstimate && (
            <span
              className="nd-est"
              title={
                `Projected from the ${projected!.basis === 'reset'
                  ? 'typical amount a jackpot restarts at after it is won'
                  : 'typical roll-up between draws'} in your own history (${projected!.samples} samples). Tap to enter the exact advertised amount.`
              }
            >
              {' '}· estimated
            </span>
          )}
        </span>
        {editing ? (
          <span className="nd-edit">
            <input
              ref={inputRef}
              value={entry}
              placeholder="e.g. 950M or 1.2B"
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
                if (e.key === 'Escape') setEditing(false)
              }}
            />
            <button className="btn primary sm" onClick={save}>Set</button>
            <button className="btn ghost sm" onClick={() => setEditing(false)}>Cancel</button>
          </span>
        ) : (
          <button
            className="nd-amount"
            onClick={() => { setEntry(amount ? `${Math.round(amount / 1e6)}M` : ''); setEditing(true) }}
            title="Tap to enter the advertised jackpot for this draw"
          >
            {amount ? bigMoney(amount) : 'Set jackpot'}
            <span className="nd-pencil" aria-hidden="true">✎</span>
          </button>
        )}
      </div>

      <div className="nd-timer">
        <span className="nd-label">
          {DOW_NAMES[res.nextDow]}, {formatDate(res.nextDate)}
          <span className="nd-time"> · {drawLabel}</span>
        </span>
        {c && (
          <span className={`nd-clock${c.past ? ' past' : ''}`}>
            {c.past ? 'drawing now — tap Sync for the result' : formatCountdown(c)}
          </span>
        )}
      </div>
    </div>
  )
}
