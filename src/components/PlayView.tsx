import { useEffect, useMemo, useState } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import type { GameData, SavedTicket } from '../engine/games.ts'
import type { JackpotFeed } from '../engine/feed.ts'
import { buildPortfolio, exactPortfolioStats, type PortfolioTicket } from '../engine/portfolio.ts'
import { reducedPoolAcceptor } from '../engine/constraintlab.ts'
import { uncrowded } from '../engine/crowd.ts'
import { DOW_NAMES, formatDate } from '../engine/dates.ts'
import { drawTimeLabel } from '../engine/drawtime.ts'
import { NextDrawStrip } from './NextDraw.tsx'
import { Ball } from './shared.tsx'

const ticketKey = (t: { numbers: number[]; special?: number }) =>
  `${[...t.numbers].sort((a, b) => a - b).join('-')}|${t.special ?? ''}`

const oneIn = (p: number): string => (p > 0 ? `1 in ${(1 / p).toFixed(1)}` : '—')

/**
 * The whole point of the app on one screen: the next draw, and five games to
 * play for it.
 *
 * Everything else the engine computes still runs — the walk-forward weights,
 * the constraint pool, the shape bands — but it runs underneath. These five
 * tickets are its output: built from the reduced pool, spread so they cover
 * different numbers instead of repeating one pick, each row lowest to highest
 * the way a sorted history reads. The Lab holds all the working.
 */
export function PlayView({ res, game, draws, drawTime, feed, savedTickets, onSetJackpot, onSaveTicket, onOpenLab }: {
  res: EngineResult
  game: GameData | undefined
  draws: Draw[]
  drawTime: string
  feed: JackpotFeed | null
  savedTickets: SavedTicket[]
  onSetJackpot: (amount: number | null, forDate: string) => void
  onSaveTicket: (t: SavedTicket) => void
  onOpenLab: () => void
}) {
  const [shared, setShared] = useState(false)
  const [showHeld, setShowHeld] = useState(false)
  /*
   * Locking is a promise about the NEXT deal, not an event in itself: tapping
   * the lock on one game must not reshuffle the other four under your thumb. So
   * the locks live in their own state, and only the deal — seed plus the slots
   * frozen at that moment — is what the ticket memo depends on.
   */
  const [locks, setLocks] = useState<Record<number, PortfolioTicket>>({})
  const [deal, setDeal] = useState<{ seed: number; slots: Record<number, PortfolioTicket> }>(
    () => ({ seed: 0x5eed, slots: {} }),
  )

  const COUNT = 5

  // A draw landing retires both the locks and anything held for the old date.
  useEffect(() => {
    setLocks({})
    setDeal({ seed: 0x5eed, slots: {} })
    setShowHeld(false)
  }, [res.nextDate])

  const pastWinners = useMemo(() => new Set(draws.map((d) => d.sorted.join('-'))), [draws])
  /*
   * The deepest pool, not a middling one. The Lab's ladder exists so the
   * trade-off can be inspected; the Play screen has already made the choice —
   * play from the smallest candidate list the record can still stand behind.
   */
  const mode = useMemo(() => {
    const lab = res.constraintLab
    if (!lab) return null
    return lab.modes.find((m) => m.key === 'deep') ?? lab.modes[lab.modes.length - 1] ?? null
  }, [res.constraintLab])

  /*
   * Two tests, both free. The pool decides which combinations look like draws
   * this game produces; `uncrowded` drops the ones a lot of other people also
   * play. Neither changes any ticket's odds — every combination is equally
   * likely, which is exactly why preferring the uncrowded one costs nothing and
   * leaves a jackpot split fewer ways.
   */
  const accept = useMemo(() => {
    const lab = res.constraintLab
    const crowdFree = uncrowded(res.K, pastWinners)
    if (!lab || !mode) return crowdFree
    const inPool = reducedPoolAcceptor(lab, mode, pastWinners)
    return (sorted: number[]) => inPool(sorted) && crowdFree(sorted)
  }, [res.constraintLab, res.K, mode, pastWinners])

  const scores = useMemo(() => {
    const s = new Float64Array(res.K + 1)
    for (const p of res.predictions) s[p.number] = Math.max(1e-9, p.probability)
    return s
  }, [res.predictions, res.K])

  const shape = useMemo(() => {
    const lab = res.constraintLab
    if (!lab || lab.positionBands.length !== res.drawSize) return null
    const sumRule = lab.rules.find((r) => r.featureKey === 'sum' && r.alpha === 0.002)
    return {
      lo: lab.positionBands.map((b) => b.lo),
      hi: lab.positionBands.map((b) => b.hi),
      sumLo: sumRule?.lo ?? 0,
      sumHi: sumRule?.hi ?? Number.MAX_SAFE_INTEGER,
    }
  }, [res.constraintLab, res.drawSize])

  // The same five tickets Play together builds at its defaults — one source of
  // truth, shown here without the machinery around it.
  const tickets = useMemo(() => {
    const slots = deal.slots
    const hold: PortfolioTicket[] = []
    for (let i = 0; i < COUNT; i++) if (slots[i]) hold.push(slots[i])
    const dealt = buildPortfolio({
      scores,
      K: res.K,
      D: res.drawSize,
      specialK: res.special?.K ?? 0,
      specialPicks: res.special?.picks.map((p) => p.number) ?? [],
      specialProbs: res.special?.picks.map((p) => p.probability) ?? [],
      count: COUNT,
      spread: 0.65,
      shape,
      exclude: pastWinners,
      accept,
      hold,
      seed: deal.seed,
      trials: 1000,
    }).tickets
    // Held tickets come back first; put each one back in the slot it was kept in.
    const fresh = dealt.slice(hold.length)
    const out: PortfolioTicket[] = []
    let next = 0
    for (let i = 0; i < COUNT; i++) out.push(slots[i] ?? fresh[next++])
    return out
  }, [scores, res.K, res.drawSize, res.special, shape, pastWinners, accept, deal])

  /*
   * Counted, not simulated. These events are rare enough that a simulation
   * large enough to run on a phone would print mostly its own noise, and the
   * whole line is only worth showing if the number in it is right.
   */
  const stats = useMemo(
    () => exactPortfolioStats(tickets, res.K, res.drawSize, res.special?.K ?? 0),
    [tickets, res.K, res.drawSize, res.special?.K],
  )

  // What is already saved for the draw this screen is about.
  const held = useMemo(
    () => savedTickets.filter((t) => t.forDate === res.nextDate),
    [savedTickets, res.nextDate],
  )
  const heldKeys = useMemo(() => new Set(held.map(ticketKey)), [held])

  const saveOne = (i: number) => {
    const t = tickets[i]
    const ticket: SavedTicket = { numbers: t.numbers }
    if (t.special !== undefined) ticket.special = t.special
    onSaveTicket(ticket)
  }
  const unsavedCount = tickets.filter((t) => !heldKeys.has(ticketKey(t))).length
  const saveAll = () => tickets.forEach((t, i) => { if (!heldKeys.has(ticketKey(t))) saveOne(i) })

  const toggleLock = (i: number) => {
    setLocks((prev) => {
      const next = { ...prev }
      if (next[i]) delete next[i]
      else next[i] = tickets[i]
      return next
    })
  }

  const another = () => {
    setDeal((d) => ({ seed: (d.seed * 1103515245 + 12345) % 2147483647, slots: locks }))
  }

  const share = async () => {
    const lines = tickets.map((t, i) => `#${i + 1}  ${t.numbers.join('-')}${t.special !== undefined ? ` · PB ${t.special}` : ''}`)
    const text = `${game?.name ?? 'Jerry Pattern Lab'} · ${DOW_NAMES[res.nextDow]} ${formatDate(res.nextDate)}\n${lines.join('\n')}\n(Statistical analysis for fun — every ticket has the same jackpot odds.)`
    try {
      if (navigator.share) await navigator.share({ text })
      else {
        await navigator.clipboard.writeText(text)
        setShared(true)
        window.setTimeout(() => setShared(false), 2400)
      }
    } catch { /* user canceled the share sheet */ }
  }

  const lab = res.constraintLab
  const lockedCount = Object.keys(locks).length

  return (
    <section className="card hero-card play-card">
      <div className="hero-top">
        <h2 style={{ fontSize: 19 }}>{game?.name ?? 'Next draw'}</h2>
        <span className="hero-date">
          {DOW_NAMES[res.nextDow]}, {formatDate(res.nextDate)} · {drawTimeLabel(game?.syncKey, drawTime)}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <button className="btn sm" onClick={() => void share()}>{shared ? '✓ Copied' : '↗ Share'}</button>
        </span>
      </div>

      <NextDrawStrip res={res} game={game} draws={draws} drawTime={drawTime} feed={feed} onSetJackpot={onSetJackpot} />

      {/* Answers "have I already played this one?" without leaving the screen. */}
      {held.length > 0 && (
        <div className="play-held">
          <button className="play-held-head" onClick={() => setShowHeld((v) => !v)} aria-expanded={showHeld}>
            <span className="play-held-tick">✓</span>
            You're in for this draw — {held.length} game{held.length === 1 ? '' : 's'} saved
            <span className="play-held-chev" aria-hidden="true">{showHeld ? '▾' : '▸'}</span>
          </button>
          {showHeld && (
            <div className="play-held-list">
              {held.map((t) => (
                <div className="play-held-row" key={ticketKey(t)}>
                  {t.numbers.map((n) => <Ball key={n} n={n} size="sm" />)}
                  {t.special !== undefined && <Ball n={t.special} size="sm" variant="special" />}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="play-tickets">
        {tickets.map((t, i) => {
          const saved = heldKeys.has(ticketKey(t))
          const locked = !!locks[i]
          return (
            <div className={`play-ticket${locked ? ' locked' : ''}`} key={`${i}-${ticketKey(t)}`}>
              {/* The number badge doubles as the keep control. Six balls plus two
                  44px buttons do not fit a 375px phone, and the row that has to
                  survive is the one with the numbers on it. */}
              <button
                className={`play-idx${locked ? ' on' : ''}`}
                onClick={() => toggleLock(i)}
                aria-pressed={locked}
                title={locked ? 'Keeping this game on the next deal' : 'Keep this game on the next deal'}
                aria-label={locked ? `Stop keeping game ${i + 1}` : `Keep game ${i + 1} on the next deal`}
              >
                {locked ? '🔒' : i + 1}
              </button>
              <span className="balls">
                {t.numbers.map((n) => <Ball key={n} n={n} size="md" variant="pick" />)}
                {t.special !== undefined && <Ball n={t.special} size="md" variant="special" />}
              </span>
              <button
                className="btn ghost sm"
                onClick={() => saveOne(i)}
                disabled={saved}
                aria-label={saved ? `Game ${i + 1} saved` : `Save game ${i + 1}`}
              >
                {saved ? '✓' : '☆'}
              </button>
            </div>
          )
        })}
      </div>

      <div className="play-actions">
        <button className="btn primary" onClick={saveAll} disabled={unsavedCount === 0}>
          {unsavedCount === 0 ? '✓ All 5 saved' : `☆ Save ${unsavedCount === COUNT ? 'all 5' : `the other ${unsavedCount}`}`}
        </button>
        <button className="btn" onClick={another}>
          ⟳ Another five{lockedCount > 0 ? ` (keep ${lockedCount})` : ''}
        </button>
        <button className="btn ghost" onClick={onOpenLab}>Lab →</button>
      </div>

      {stats && (
        <p className="play-stat">
          These five cover <b>{stats.distinctNumbers}</b> different numbers, and at least one of them wins
          something <b>{oneIn(stats.pAnyPrize)}</b> draws
          {res.special ? <> — mostly on the {res.special.K}-ball bonus, which is why all five carry a different one</> : null}.
          Counted exactly, not estimated.
        </p>
      )}

      <p className="hint play-hint">
        Five games, lowest to highest, learned from {res.drawCount.toLocaleString()} draws
        {/* Rounded, and rounded high: on top of the pool's own cuts the acceptor
            drops past winners, the never-seen families and the crowded shapes,
            so the true figure is a shade under this one. */}
        {lab && mode && (
          <> and drawn from about {((mode.combinationsAfter * (res.special?.K ?? 1)) / 1e6).toFixed(1)} million
          combinations — the deepest cut the record supports, keeping {Math.round(mode.spaceShare * 100)}% of the pool
          and {Math.round(mode.survival * 100)}% of the winners it was tested against</>
        )}
        . Spread to cover different numbers, never a past jackpot, never a shape this game has not produced, and never a
        combination the whole country plays — that last one changes no odds at all, it just means a jackpot you win is
        split fewer ways. <em>Another five</em> deals a fresh set from the same pool; tap a game's number to keep it
        through the deal.
      </p>
    </section>
  )
}
