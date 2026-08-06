import { useMemo, useState } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import type { GameData, SavedTicket } from '../engine/games.ts'
import type { JackpotFeed } from '../engine/feed.ts'
import { buildPortfolio } from '../engine/portfolio.ts'
import { reducedPoolAcceptor } from '../engine/constraintlab.ts'
import { DOW_NAMES, formatDate } from '../engine/dates.ts'
import { drawTimeLabel } from '../engine/drawtime.ts'
import { NextDrawStrip } from './NextDraw.tsx'
import { Ball } from './shared.tsx'

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
export function PlayView({ res, game, draws, drawTime, feed, onSetJackpot, onSaveTicket, onOpenLab }: {
  res: EngineResult
  game: GameData | undefined
  draws: Draw[]
  drawTime: string
  feed: JackpotFeed | null
  onSetJackpot: (amount: number | null, forDate: string) => void
  onSaveTicket: (t: SavedTicket) => void
  onOpenLab: () => void
}) {
  const [savedAt, setSavedAt] = useState<Set<number>>(() => new Set())
  const [shared, setShared] = useState(false)
  // Each shuffle draws a fresh set from the same pool, so "more games" never
  // means "looser games".
  const [seed, setSeed] = useState(0x5eed)

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

  const accept = useMemo(() => {
    const lab = res.constraintLab
    if (!lab || !mode) return null
    return reducedPoolAcceptor(lab, mode, pastWinners)
  }, [res.constraintLab, mode, pastWinners])

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
  const tickets = useMemo(
    () => buildPortfolio({
      scores,
      K: res.K,
      D: res.drawSize,
      specialK: res.special?.K ?? 0,
      specialPicks: res.special?.picks.map((p) => p.number) ?? [],
      specialProbs: res.special?.picks.map((p) => p.probability) ?? [],
      count: 5,
      spread: 0.65,
      shape,
      exclude: pastWinners,
      accept,
      seed,
      trials: 1000,
    }).tickets,
    [scores, res.K, res.drawSize, res.special, shape, pastWinners, accept, seed],
  )

  const saveOne = (i: number) => {
    const t = tickets[i]
    const ticket: SavedTicket = { numbers: t.numbers }
    if (t.special !== undefined) ticket.special = t.special
    onSaveTicket(ticket)
    setSavedAt((s) => new Set(s).add(i))
  }
  const saveAll = () => tickets.forEach((_, i) => saveOne(i))

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

      <div className="play-tickets">
        {tickets.map((t, i) => (
          <div className="play-ticket" key={`${t.numbers.join('-')}-${t.special ?? ''}`}>
            <span className="play-idx">{i + 1}</span>
            <span className="balls">
              {t.numbers.map((n) => <Ball key={n} n={n} size="md" variant="pick" />)}
              {t.special !== undefined && <Ball n={t.special} size="md" variant="special" />}
            </span>
            <button className="btn ghost sm" onClick={() => saveOne(i)}>
              {savedAt.has(i) ? '✓' : '☆'}
            </button>
          </div>
        ))}
      </div>

      <div className="play-actions">
        <button className="btn primary" onClick={saveAll}>☆ Save all 5</button>
        <button
          className="btn"
          onClick={() => { setSeed((v) => (v * 1103515245 + 12345) % 2147483647); setSavedAt(new Set()) }}
        >
          ⟳ Another five
        </button>
        <button className="btn ghost" onClick={onOpenLab}>Lab →</button>
      </div>

      <p className="hint play-hint">
        Five games, lowest to highest, learned from {res.drawCount.toLocaleString()} draws
        {/* Rounded: the acceptor also drops past winners and the never-seen
            families, so the exact figure is a shade under this one. */}
        {lab && mode && (
          <> and drawn from about {((mode.combinationsAfter * (res.special?.K ?? 1)) / 1e6).toFixed(1)} million
          combinations — the deepest cut the record supports, keeping {Math.round(mode.spaceShare * 100)}% of the pool
          and {Math.round(mode.survival * 100)}% of the winners it was tested against</>
        )}
        . Spread to cover different numbers, never a past jackpot, never a shape this game has not produced.
        <em> Another five</em> deals a fresh set from that same pool.
      </p>
    </section>
  )
}
