import { useEffect, useMemo, useRef, useState } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import type { GameData } from '../engine/games.ts'
import type { JackpotFeed } from '../engine/feed.ts'
import { feedJackpotFor } from '../engine/feed.ts'
import { US_LOWER_TIERS, projectNextJackpot, ticketValue } from '../engine/jackpot.ts'
import { countdownTo, drawTimeLabel, nextDrawInstant } from '../engine/drawtime.ts'
import { DOW_NAMES, formatDate } from '../engine/dates.ts'
import { FlipClock } from './FlipClock.tsx'

export const bigMoney = (n: number): string => {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)} Billion`
  if (n >= 1e6) return `$${Math.round(n / 1e6)} Million`
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${Math.round(n)}`
}

const shortMoney = (n: number): string =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${Math.round(n / 1e6)}M` : `$${Math.round(n).toLocaleString()}`

export interface NextDrawInfo {
  amount: number | null
  /** Where the figure came from */
  origin: 'official' | 'manual' | 'estimate' | 'none'
  cashValue?: number
  target: Date | null
  drawLabel: string
}

/** Resolve the prize and the exact draw instant from the best source available. */
export function resolveNextDraw(
  res: EngineResult, game: GameData | undefined, draws: Draw[], feed: JackpotFeed | null, drawTime: string,
): NextDrawInfo {
  const official = feedJackpotFor(feed, game?.syncKey, res.nextDate)
  const manual = game?.nextJackpotFor === res.nextDate ? game.nextJackpot : undefined
  const projected = manual === undefined && !official ? projectNextJackpot(draws) : null

  const amount = manual ?? official?.jackpot ?? projected?.amount ?? null
  const origin: NextDrawInfo['origin'] =
    manual !== undefined ? 'manual' : official ? 'official' : projected ? 'estimate' : 'none'

  // The operator publishes the exact instant; fall back to the scheduled time
  const fromFeed = official?.drawInstant ? new Date(official.drawInstant) : null
  const target = fromFeed && !Number.isNaN(fromFeed.getTime())
    ? fromFeed
    : nextDrawInstant(res.nextDate, game?.syncKey, drawTime)

  const info: NextDrawInfo = { amount, origin, target, drawLabel: drawTimeLabel(game?.syncKey, drawTime) }
  // The cash value belongs to the operator's own figure — an amount typed in by
  // hand has no published lump sum, so pricing it against one would be wrong.
  if (origin === 'official' && official?.cashValue) info.cashValue = official.cashValue
  return info
}

/**
 * The prize and the countdown, sitting inside the prediction card's header so
 * they cost no extra height. The amount is the operator's advertised figure
 * when the published feed has one for this exact draw, the amount typed in when
 * there is one, and otherwise a projection from this history's own roll-up.
 */
export function NextDrawStrip({ res, game, draws, drawTime, feed, onSetJackpot }: {
  res: EngineResult
  game: GameData | undefined
  draws: Draw[]
  drawTime: string
  feed: JackpotFeed | null
  onSetJackpot: (amount: number | null, forDate: string) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const [editing, setEditing] = useState(false)
  const [entry, setEntry] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const info = useMemo(
    () => resolveNextDraw(res, game, draws, feed, drawTime),
    [res, game, draws, feed, drawTime],
  )

  useEffect(() => {
    if (!info.target) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [info.target])

  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  const c = info.target ? countdownTo(info.target, now) : null

  // Priced on the cash value when the operator publishes one: that is what a
  // winner actually receives today, and it is what the value panel defaults to,
  // so the two never disagree on the same screen.
  const priced = info.cashValue ?? info.amount
  const perTicket = useMemo(() => {
    if (!priced) return null
    return ticketValue(res.K, res.drawSize, res.special?.K ?? 0, priced, null, 2, US_LOWER_TIERS).grossEv
  }, [priced, res.K, res.drawSize, res.special?.K])

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

  const originNote =
    info.origin === 'official' ? <span className="nd-src official" title="Published by the game operator and refreshed automatically">official</span>
      : info.origin === 'manual' ? <span className="nd-src">you set this · <button className="linky" onClick={() => onSetJackpot(null, res.nextDate)}>clear</button></span>
        : info.origin === 'estimate' ? <span className="nd-src" title="Projected from the roll-up in your own history. Tap the amount to enter the advertised figure.">estimated</span>
          : null

  return (
    <div className="next-draw">
      <div className="nd-prize">
        <span className="nd-label">Jackpot {originNote}</span>
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
            onClick={() => { setEntry(info.amount ? `${Math.round(info.amount / 1e6)}M` : ''); setEditing(true) }}
            title="Tap to enter the advertised jackpot for this draw"
          >
            {info.amount ? bigMoney(info.amount) : 'Set jackpot'}
            <span className="nd-pencil" aria-hidden="true">✎</span>
          </button>
        )}
        <span className="nd-sub">
          {info.cashValue ? <>cash {shortMoney(info.cashValue)} · </> : null}
          {perTicket !== null && (
            <>a $2 ticket is worth ${perTicket.toFixed(2)}{info.cashValue ? ' at the cash value' : ''}, before any split</>
          )}
        </span>
      </div>

      {c && (
        <div className="nd-when">
          <span className="nd-when-label">
            {DOW_NAMES[res.nextDow].slice(0, 3)}, {formatDate(res.nextDate)} · {info.drawLabel}
          </span>
          {c.past
            ? <span className="nd-drawing">drawing now — tap Sync for the result</span>
            : <FlipClock countdown={c} />}
        </div>
      )}
    </div>
  )
}
