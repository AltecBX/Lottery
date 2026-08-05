import { useState } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import type { GameData } from '../engine/games.ts'
import type { JackpotFeed } from '../engine/feed.ts'
import { DOW_NAMES, formatDate } from '../engine/dates.ts'
import { drawTimeLabel } from '../engine/drawtime.ts'
import { NextDrawStrip } from './NextDraw.tsx'
import { Ball, Tile, fmtPct } from './shared.tsx'

export function PredictionPanel({ res, gameName, game, draws, drawTime, feed, onSetJackpot }: {
  res: EngineResult
  gameName: string
  game: GameData | undefined
  draws: Draw[]
  drawTime: string
  feed: JackpotFeed | null
  onSetJackpot: (amount: number | null, forDate: string) => void
}) {
  const [shared, setShared] = useState(false)
  const bt = res.backtest
  const D = res.drawSize
  const edge10 = bt.chance10 > 0 ? bt.ensemble10 / bt.chance10 : 1
  const recent = bt.points.slice(-100)
  const recent10 = recent.length ? recent.reduce((s, p) => s + p.hits10, 0) / recent.length : 0

  const share = async () => {
    const picks = res.topPick.map((p) => p.number).join('-')
    const sp = res.special?.picks[0]?.number
    const text = `${gameName || 'Jerry Pattern Lab'} · ${DOW_NAMES[res.nextDow]} ${formatDate(res.nextDate)}\nJerry Pattern Lab picks: ${picks}${sp ? ` · Bonus ${sp}` : ''}\n(Statistical analysis for fun — every ticket has the same jackpot odds.)`
    try {
      if (navigator.share) await navigator.share({ text })
      else {
        await navigator.clipboard.writeText(text)
        setShared(true)
        window.setTimeout(() => setShared(false), 2400)
      }
    } catch { /* user canceled the share sheet */ }
  }

  return (
    <section id="prediction" className="card hero-card section-anchor">
      <div className="hero-top">
        <h2 style={{ fontSize: 19 }}>Next draw prediction</h2>
        <span className="hero-date">
          {DOW_NAMES[res.nextDow]}, {formatDate(res.nextDate)} · {drawTimeLabel(game?.syncKey, drawTime)} ·
          {' '}learned from {res.drawCount.toLocaleString()} draws
          {res.constraintLab?.eraTrim ? ` on today's rules (since ${formatDate(res.constraintLab.eraTrim.cutoffDate)})` : ''}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <button className="btn sm" onClick={() => void share()}>{shared ? '✓ Copied' : '↗ Share picks'}</button>
        </span>
      </div>

      <NextDrawStrip
        res={res}
        game={game}
        draws={draws}
        drawTime={drawTime}
        feed={feed}
        onSetJackpot={onSetJackpot}
      />

      <div className="hero-cols">
        <div className="hero-balls">
          {res.topPick.map((p) => {
            const chance = res.drawSize / res.K
            const e = chance > 0 ? p.probability / chance - 1 : 0
            return (
              <div className="hero-ball-wrap" key={p.number}>
                <Ball n={p.number} size="hero" />
                <span className="prob">{fmtPct(p.probability)}</span>
                <span className="conf">{Math.abs(e) < 0.03 ? '\u2248 chance' : `${e > 0 ? '+' : '\u2212'}${Math.round(Math.abs(e) * 100)}% vs chance`}</span>
              </div>
            )
          })}
          {res.special && res.special.picks.length > 0 && (
            <div className="hero-ball-wrap" key="special">
              <Ball n={res.special.picks[0].number} size="hero" variant="special" />
              <span className="prob">{fmtPct(res.special.picks[0].probability)}</span>
              <span className="special-label">Bonus ball</span>
            </div>
          )}
        </div>
        <div className="hero-drivers">
          <div className="mini-title">What's driving the model</div>
          {res.drivers.map((s) => (
            <div className="driver-row" key={s.key} title={s.description}>
              <span className="scorebar"><i style={{ width: `${Math.min(100, (100 * s.weight) / Math.max(0.0001, res.drivers[0].weight))}%` }} /></span>
              <span className="driver-name">{s.label}</span>
              <span className="driver-w">{fmtPct(s.weight, 0)}</span>
            </div>
          ))}
          {res.drivers.length > 0 ? (
            <span className="hint">
              weights re-learned by backtesting your data — updated with every result you add
            </span>
          ) : (
            <span className="hint">
              No signal shows a statistically significant edge in your data yet, so the ensemble uses a balanced blend of
              all signals. See the Backtest panel for each signal's record.
            </span>
          )}
        </div>
      </div>

      {res.bestCombo && (
        <div className="combo-strip">
          <span className="mini-title" style={{ margin: 0 }}>Best combination</span>
          <span className="balls">
            {res.bestCombo.numbers.map((n) => (
              <Ball key={n} n={n} size="sm" variant="pick" />
            ))}
            {res.special && res.special.picks.length > 0 && (
              <Ball n={res.special.picks[0].number} size="sm" variant="special" />
            )}
          </span>
          <span className="combo-note">
            {res.bestCombo.notes.join(' · ')}
            {res.bestComboIsNew === true && (
              <>
                {' '}· <span style={{ color: 'var(--good-text)', fontWeight: 640 }}>never drawn before ✓</span>
              </>
            )}
            {res.bestComboIsNew === false && (
              <>
                {' '}· <span style={{ color: 'var(--gold)', fontWeight: 640 }}>matches a past winning draw</span>
              </>
            )}
          </span>
        </div>
      )}

      {res.special && (
        <div className="combo-strip">
          <span className="mini-title" style={{ margin: 0 }}>Bonus ball</span>
          <span className="balls">
            {res.special.picks.map((s, i) => (
              <Ball key={s.number} n={s.number} size="sm" variant={i === 0 ? 'special' : ''} title={`drawn ${s.count}× · last seen ${s.drawsSinceSeen} draws ago`} />
            ))}
          </span>
          <span className="combo-note">
            pool 1–{res.special.K} · candidates ranked by its own learned model
            {bt.special && bt.special.evaluated > 0 && (
              <> · backtest: in top-3 {fmtPct(bt.special.top3, 0)} of the time (chance {fmtPct(bt.special.chance3, 0)})</>
            )}
          </span>
        </div>
      )}

      <div className="tiles" style={{ marginTop: 16 }}>
        <Tile
          label="Model edge (top-10)"
          value={`${edge10.toFixed(2)}×`}
          delta={edge10 > 1.02 ? 'above chance in backtest' : 'no edge over chance yet'}
          deltaDir={edge10 > 1.02 ? 'up' : 'flat'}
        />
        <Tile label={`Winners caught in top-10 (of ${D})`} value={bt.ensemble10.toFixed(2)} delta={`chance ${bt.chance10.toFixed(2)} · frequency ${bt.baseline10.toFixed(2)}`} />
        <Tile label="Recent form (last 100)" value={recent10.toFixed(2)} delta={`hits of ${D} caught in top-10`} />
        <Tile label="≥2 winners in top-10" value={fmtPct(bt.ens10AtLeast2, 0)} delta={`${bt.evaluated} draws backtested`} />
      </div>
    </section>
  )
}
