import { useMemo, useState } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import { Ball, fmtPct } from './shared.tsx'

type Lens = 'model' | 'recent' | 'overdue' | 'alltime'

const LENSES: { key: Lens; label: string }[] = [
  { key: 'model', label: 'Model' },
  { key: 'recent', label: 'Last 20' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'alltime', label: 'All-time' },
]

/** One number's cell: its value under the current lens, and how far from par. */
interface Cell {
  n: number
  value: number
  /** −1..1, the value's distance from par scaled by the biggest distance on the board */
  t: number
}

/** Six shades each way. Quantised rather than continuous so the colour survives
 *  every browser that can do color-mix at all, and so two cells that look the
 *  same really are within a step of each other. */
const level = (t: number): number => Math.min(5, Math.round(Math.abs(t) * 5))

export function boardCells(values: { n: number; value: number }[], par: number): Cell[] {
  let span = 0
  for (const v of values) span = Math.max(span, Math.abs(v.value - par))
  // Numeric order, always. `predictions` arrives sorted by rank, and a board
  // laid out strongest-first is not a board — the rows stop being the decades
  // and you can no longer find a number by looking for where it lives.
  return values
    .map(({ n, value }) => ({ n, value, t: span > 0 ? (value - par) / span : 0 }))
    .sort((a, b) => a.n - b.n)
}

const Grid = ({ cells, picked, format }: {
  cells: Cell[]
  picked: Set<number>
  format: (c: Cell) => string
}) => (
  <div className="bd-grid">
    {cells.map((c) => (
      <span
        key={c.n}
        className={`bd-cell ${c.t >= 0 ? 'pos' : 'neg'} l${level(c.t)}${picked.has(c.n) ? ' picked' : ''}`}
        title={format(c)}
      >
        {c.n}
      </span>
    ))}
  </div>
)

/**
 * The whole pool on one screen.
 *
 * Everywhere else the app hands you five numbers and asks you to trust the
 * ranking behind them. This is that ranking, laid out the way a slip is: ten to
 * a row, every number in the game, shaded by what the current lens says about
 * it, with the model's pick ringed.
 *
 * The shading is scaled to the widest gap on the board, so the strongest number
 * is always fully coloured — otherwise the model's real spread would render as
 * 69 identical grey squares. That normalisation is exactly the sort of thing
 * that turns a 3% edge into a picture of a 300% one, so the legend under each
 * board prints the actual range in the lens's own units. Read the numbers, not
 * the colour: the colour only ranks, the legend says by how much.
 */
export function PredictionBoard({ res, draws }: { res: EngineResult; draws: Draw[] }) {
  const [lens, setLens] = useState<Lens>('model')

  const K = res.K
  const D = res.drawSize
  const chance = D / K

  // Bonus-ball counts, scoped to the current rule era the same way the engine
  // scopes the mains — Powerball's bonus pool was 35 balls before 2015, and
  // counting those draws would hand today's 26 balls a history they never had.
  const bonus = useMemo(() => {
    const sk = res.special?.K ?? 0
    if (sk === 0) return null
    const cutoff = res.constraintLab?.eraTrim?.cutoffDate ?? ''
    const scoped = draws.filter((d) => d.special !== undefined && d.special <= sk && d.date >= cutoff)
    const count = new Int32Array(sk + 1)
    const last20 = new Int32Array(sk + 1)
    const lastAt = new Int32Array(sk + 1).fill(-1)
    scoped.forEach((d, i) => { count[d.special!]++; lastAt[d.special!] = i })
    for (let i = Math.max(0, scoped.length - 20); i < scoped.length; i++) last20[scoped[i].special!]++
    const since = (v: number) => (lastAt[v] < 0 ? scoped.length : scoped.length - 1 - lastAt[v])
    return { sk, n: scoped.length, count, last20, since }
  }, [draws, res.special?.K, res.constraintLab?.eraTrim?.cutoffDate])

  // The model's pick, and the numbers to ring on the board. The best
  // combination rather than the top five by rank: five numbers that each score
  // well can still form a shape this game has never produced, which is the
  // whole reason bestCombo exists.
  const pick = res.bestCombo?.numbers ?? res.topPick.map((p) => p.number)
  const pickSet = useMemo(() => new Set(pick), [pick])
  const topBonus = res.special?.picks[0]?.number
  const bonusSet = useMemo(() => new Set(topBonus !== undefined ? [topBonus] : []), [topBonus])

  const mains = useMemo(() => {
    const src = res.predictions
    if (lens === 'model') return boardCells(src.map((p) => ({ n: p.number, value: p.probability })), chance)
    if (lens === 'recent') return boardCells(src.map((p) => ({ n: p.number, value: p.stats.last20 })), 20 * chance)
    if (lens === 'alltime') return boardCells(src.map((p) => ({ n: p.number, value: p.stats.count })), res.drawCount * chance)
    return boardCells(src.map((p) => ({ n: p.number, value: p.stats.drawsSinceSeen })), K / D)
  }, [res.predictions, res.drawCount, lens, chance, K, D])

  const bonusCells = useMemo(() => {
    if (!bonus) return null
    const list = Array.from({ length: bonus.sk }, (_, i) => i + 1)
    if (lens === 'recent') return boardCells(list.map((n) => ({ n, value: bonus.last20[n] })), 20 / bonus.sk)
    if (lens === 'overdue') return boardCells(list.map((n) => ({ n, value: bonus.since(n) })), bonus.sk)
    if (lens === 'alltime') return boardCells(list.map((n) => ({ n, value: bonus.count[n] })), bonus.n / bonus.sk)
    /*
     * The bonus model publishes a ranked shortlist rather than a score for all
     * 26, so under "Model" the shortlist is what gets shaded and every other
     * ball sits exactly at chance. Filling the gap with all-time frequency
     * instead — which is what this did first — put a glow on balls the model
     * had said nothing about and left its own top pick looking cold.
     */
    const par = 1 / bonus.sk
    const claim = new Map((res.special?.picks ?? []).map((s) => [s.number, s.probability]))
    return boardCells(list.map((n) => ({ n, value: claim.get(n) ?? par })), par)
  }, [bonus, lens, res.special?.picks])

  // The legend: the real range, in the units the lens is actually measuring.
  const legend = useMemo(() => {
    const vals = mains.map((c) => c.value)
    const lo = Math.min(...vals)
    const hi = Math.max(...vals)
    if (lens === 'model') {
      const e = (v: number) => `${v >= chance ? '+' : '−'}${Math.round((Math.abs(v / chance - 1)) * 100)}%`
      return {
        scale: `${e(lo)} … ${e(hi)} against chance`,
        note: `Every number's chance of being drawn is ${fmtPct(chance, 1)}, and it stays ${fmtPct(chance, 1)} whatever this board shows. The model's strongest reading is ${e(hi)} of that and its weakest ${e(lo)}, so the whole pool sits between ${fmtPct(lo)} and ${fmtPct(hi)} — a real ordering, but a narrow one. Whether it has ever been worth anything is a question for the backtest, not for the colour.`,
      }
    }
    if (lens === 'recent') {
      return {
        scale: `${lo} … ${hi} times in the last 20 draws`,
        note: `Twenty draws put ${(20 * chance).toFixed(1)} of each number on the board on average. A spread of ${lo} to ${hi} is what ${20 * D} random picks from ${K} numbers produce on their own — this is a picture of recent luck, not of what is coming.`,
      }
    }
    if (lens === 'alltime') {
      const exp = res.drawCount * chance
      return {
        scale: `${lo} … ${hi} times in ${res.drawCount.toLocaleString()} draws`,
        note: `Expected ${exp.toFixed(0)} apiece. Across this many draws chance alone spreads the counts by roughly ±${Math.round(2 * Math.sqrt(exp * (1 - chance)))}, so a gap of ${hi - lo} between the most and least drawn is ordinary, not a bias.`,
      }
    }
    return {
      scale: `${lo} … ${hi} draws since last seen`,
      note: `A number reappears every ${(K / D).toFixed(1)} draws on average, and the wait restarts from scratch every time — a ball that has been missing ${hi} draws is exactly as likely tonight as one drawn yesterday. This is a map of what has been quiet, and quiet is not the same as due.`,
    }
  }, [mains, lens, chance, res.drawCount, K, D])

  return (
    <section className="card bd-card">
      <div className="bd-head">
        <h2>The board</h2>
        <div className="bd-lenses" role="tablist" aria-label="What the colours show">
          {LENSES.map((l) => (
            <button
              key={l.key}
              role="tab"
              aria-selected={lens === l.key}
              className={lens === l.key ? 'on' : ''}
              onClick={() => setLens(l.key)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bd-pick">
        <span className="bd-pick-label">The model's pick</span>
        <span className="balls">
          {pick.map((n) => <Ball key={n} n={n} size="md" variant="pick" />)}
          {topBonus !== undefined && <Ball n={topBonus} size="md" variant="special" />}
        </span>
      </div>

      <Grid
        cells={mains}
        picked={pickSet}
        format={(c) => (lens === 'model'
          ? `${c.n} — ${fmtPct(c.value)} (chance ${fmtPct(chance, 1)})`
          : lens === 'overdue' ? `${c.n} — ${c.value} draws since last seen`
            : `${c.n} — drawn ${c.value}×`)}
      />

      <div className="bd-legend">
        <span className="bd-scale" aria-hidden="true">
          <i className="neg" /><i className="zero" /><i className="pos" />
        </span>
        <span className="bd-range">{legend.scale}</span>
      </div>

      {bonusCells && bonus && (
        <>
          <div className="mini-title bd-sub">
            Bonus ball · pool 1–{bonus.sk}
            {lens === 'model' && (
              <span className="bd-sub-note">
                {' '}— the model ranks a shortlist of {res.special?.picks.length ?? 0} here; every other ball sits at chance
              </span>
            )}
          </div>
          <Grid
            cells={bonusCells}
            picked={bonusSet}
            format={(c) => (lens === 'overdue'
              ? `${c.n} — ${c.value} draws since last seen`
              : `${c.n} — drawn ${c.value}×`)}
          />
        </>
      )}

      <p className="hint bd-note">
        {legend.note}
      </p>
      <p className="hint bd-note">
        The ring marks the model's pick — the best <em>combination</em>, not the five darkest cells, which is why it
        does not simply take the top five: five numbers that each score well can still form a total or a spacing this
        game has never once produced. Colour ranks the pool from the strongest reading down to the weakest and always
        fills the full range, because the real gaps are far too narrow to see otherwise — which is what the line above
        the board is there to tell you. None of these views changes any ticket's odds.
      </p>
    </section>
  )
}
