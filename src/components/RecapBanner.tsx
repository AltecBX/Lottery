import { useEffect, useMemo, useState } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import type { SavedTicket } from '../engine/games.ts'
import { DOW_NAMES, formatDate } from '../engine/dates.ts'
import { gradeTicket } from '../engine/ticket.ts'
import { Ball } from './shared.tsx'

const seenKey = (gameId: string) => `patternlab.seen.${gameId}`

const readSeen = (gameId: string): string | null => {
  try {
    return window.localStorage.getItem(seenKey(gameId))
  } catch {
    return null
  }
}

const writeSeen = (gameId: string, date: string) => {
  try {
    window.localStorage.setItem(seenKey(gameId), date)
  } catch { /* storage unavailable — the recap just shows again next time */ }
}

/**
 * What happened while you were away.
 *
 * The moment a lottery app is actually useful is the one right after a draw,
 * and that is the moment most of them make you go hunting. This surfaces every
 * result that has landed since the last visit, scored two ways that matter:
 * how the model's ranking did, and whether anything you saved actually won.
 */
export function RecapBanner({ res, draws, gameId, savedTickets }: {
  res: EngineResult
  draws: Draw[]
  gameId: string
  savedTickets: SavedTicket[]
}) {
  const latest = draws.length > 0 ? draws[draws.length - 1].date : ''
  const [since, setSince] = useState<string | null>(() => (gameId ? readSeen(gameId) : null))
  const [dismissed, setDismissed] = useState(false)

  // First visit for this game records where we are without claiming anything is new
  useEffect(() => {
    if (!gameId || !latest) return
    if (readSeen(gameId) === null) {
      writeSeen(gameId, latest)
      setSince(latest)
    }
  }, [gameId, latest])

  useEffect(() => { setDismissed(false) }, [gameId])

  const fresh = useMemo(() => {
    if (!since || !latest || since >= latest) return []
    return draws.filter((d) => d.date > since).slice(-4)
  }, [draws, since, latest])

  const rows = useMemo(() => {
    const byDate = new Map(res.backtest.points.map((p) => [p.date, p]))
    return fresh.map((draw) => {
      const point = byDate.get(draw.date) ?? null
      const wins = savedTickets
        .filter((t) => !t.forDate || t.forDate === draw.date)
        .map((t) => gradeTicket(t, draw, res.drawSize))
        .filter((g) => g.prize > 0 || g.mains >= 2)
        .sort((a, b) => b.prize - a.prize || b.mains - a.mains)
      return { draw, point, wins }
    })
  }, [fresh, res.backtest.points, res.drawSize, savedTickets])

  if (dismissed || rows.length === 0) return null

  const acknowledge = () => {
    writeSeen(gameId, latest)
    setSince(latest)
    setDismissed(true)
  }

  const won = rows.reduce((s, r) => s + r.wins.reduce((a, g) => a + g.prize, 0), 0)

  return (
    <div className="recap">
      <div className="recap-head">
        <span className="recap-title">
          {rows.length === 1 ? 'A draw landed' : `${rows.length} draws landed`} since you were last here
        </span>
        {won > 0 && <span className="recap-won">you won ${won.toLocaleString()}</span>}
        <button className="btn ghost sm" onClick={acknowledge} aria-label="Dismiss recap">✕</button>
      </div>

      {rows.map(({ draw, point, wins }) => (
        <div className="recap-row" key={draw.date}>
          <span className="recap-date">{DOW_NAMES[draw.dow].slice(0, 3)} {formatDate(draw.date)}</span>
          <span className="balls">
            {draw.sorted.map((n) => (
              <Ball
                key={n}
                n={n}
                size="sm"
                variant={point && point.predictedTop.slice(0, res.drawSize).includes(n) ? 'match' : ''}
              />
            ))}
            {draw.special !== undefined && <Ball n={draw.special} size="sm" variant="special" />}
          </span>
          <span className="recap-note">
            {point
              ? <>model caught {point.hitsPick} of {res.drawSize} in its pick{point.hits10 > point.hitsPick ? `, ${point.hits10} in its top-10` : ''}</>
              : 'not covered by the backtest'}
            {wins.length > 0 && (
              <>
                {' · '}
                <strong className={wins[0].prize > 0 ? 'recap-hit' : undefined}>
                  your ticket: {wins[0].label}
                  {wins[0].prize > 0 ? ` — $${wins[0].prize.toLocaleString()}` : ''}
                </strong>
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
