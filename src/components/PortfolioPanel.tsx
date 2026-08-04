import { useMemo, useState } from 'react'
import type { EngineResult } from '../engine/types.ts'
import type { SavedTicket } from '../engine/games.ts'
import { buildPortfolio, lowerTierValue, type PortfolioStats } from '../engine/portfolio.ts'
import { formatOdds, jackpotOdds } from '../engine/odds.ts'
import { SectionCard, Ball, fmtPct } from './shared.tsx'

/**
 * Rare events read better as odds than as a percentage — "1 in 1,800" says
 * something "0.1%" does not. Two significant figures keeps the simulation's own
 * noise from showing up as false precision.
 */
const money = (n: number) => `$${n.toFixed(2)}`

const oneIn = (p: number): string => {
  if (p <= 0) return '—'
  const n = 1 / p
  const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(n)) - 1))
  return `1 in ${(Math.round(n / mag) * mag).toLocaleString()}`
}

function CompareRow({ label, stats, best, note }: {
  label: string
  stats: PortfolioStats
  best: boolean
  note: string
}) {
  return (
    <tr className={best ? 'row-best' : undefined}>
      <td>
        {label}
        <span className="sub">{note}</span>
      </td>
      <td className="num">{stats.distinctNumbers}</td>
      <td className="num">{fmtPct(stats.pAnyPrize, stats.pAnyPrize < 0.1 ? 1 : 0)}</td>
      <td className="num">{oneIn(stats.pAtLeast3)}</td>
      <td className="num">{stats.avgBestMatch.toFixed(2)}</td>
    </tr>
  )
}

/**
 * Buying several tickets at once is the one decision in a lottery where the
 * choice of numbers provably changes the outcome distribution. Five near-copies
 * of the same pick win and lose together; five that share no numbers cover five
 * times the pool. Neither improves the jackpot odds — nothing does — but the
 * chance that *something* on the counter pays is materially different, and the
 * simulation below measures it against fair random draws.
 */
export function PortfolioPanel({ res, onSaveTicket }: {
  res: EngineResult
  onSaveTicket: (t: SavedTicket) => void
}) {
  const [count, setCount] = useState(5)
  const [spread, setSpread] = useState(0.65)
  const [saved, setSaved] = useState<Set<number>>(() => new Set())

  const scores = useMemo(() => {
    const s = new Float64Array(res.K + 1)
    for (const p of res.predictions) s[p.number] = Math.max(1e-9, p.probability)
    return s
  }, [res.predictions, res.K])

  const specialPicks = useMemo(() => res.special?.picks.map((p) => p.number) ?? [], [res.special])

  /*
   * Keep suggested tickets to shapes this game actually produces. Ranking
   * numbers one at a time says nothing about the combination they form, and the
   * top five by score are perfectly capable of totalling 26 when no draw in the
   * current era has ever totalled under 52. The bands come from Constraint Lab,
   * which derives them walk-forward from the current rule era — so this is the
   * model's own view of shape, not a rule invented here.
   */
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

  const portfolio = useMemo(
    () => buildPortfolio({
      scores,
      K: res.K,
      D: res.drawSize,
      specialK: res.special?.K ?? 0,
      specialPicks,
      count,
      spread,
      shape,
      trials: 60000,
    }),
    [scores, res.K, res.drawSize, res.special?.K, specialPicks, count, spread, shape],
  )

  const { stats, quickPick, concentrated } = portfolio
  const spent = count * 2
  const bestAny = Math.max(stats.pAnyPrize, quickPick.pAnyPrize, concentrated.pAnyPrize)
  const rows = [
    { label: 'This set', stats, note: "model's numbers, spread across tickets" },
    { label: 'The same pick, repeated', stats: concentrated, note: 'every ticket identical to the top pick' },
    { label: 'Quick picks', stats: quickPick, note: 'drawn at random, like the counter gives you' },
  ]

  const jOdds = useMemo(
    () => jackpotOdds(res.K, res.drawSize, res.special?.K ?? 0),
    [res.K, res.drawSize, res.special?.K],
  )
  const lowerEv = useMemo(
    () => lowerTierValue(res.K, res.drawSize, res.special?.K ?? 0),
    [res.K, res.drawSize, res.special?.K],
  )

  const save = (i: number) => {
    const t = portfolio.tickets[i]
    const ticket: SavedTicket = { numbers: t.numbers }
    if (t.special !== undefined) ticket.special = t.special
    onSaveTicket(ticket)
    setSaved((s) => new Set(s).add(i))
  }

  const saveAll = () => {
    portfolio.tickets.forEach((_, i) => save(i))
  }

  return (
    <SectionCard
      id="portfolio"
      title="Play together"
      sub="If you buy more than one ticket, the set matters. These are built to cover different numbers instead of repeating the same pick, and the table measures what that actually changes."
    >
      <div className="pf-controls">
        <label className="rng">
          <span>{count} ticket{count === 1 ? '' : 's'} · ${spent}</span>
          <input type="range" min={1} max={10} step={1} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </label>
        <label className="rng">
          {/* Name the outcome, not the setting — the number moves at every notch. */}
          <span>
            {stats.distinctNumbers} different number{stats.distinctNumbers === 1 ? '' : 's'} covered
            <span className="sub">
              {spread < 0.2 ? ' · concentrated on the best pick'
                : spread > 0.8 ? ' · the widest spread these tickets allow'
                  : ' · strong numbers, spread out'}
            </span>
          </span>
          <input type="range" min={0} max={1} step={0.05} value={spread} onChange={(e) => setSpread(Number(e.target.value))} />
        </label>
        <button className="btn primary sm" onClick={saveAll}>☆ Save all {count}</button>
      </div>

      <div className="pf-tickets">
        {portfolio.tickets.map((t, i) => (
          <div className="pf-ticket" key={`${t.numbers.join('-')}-${t.special ?? ''}-${i}`}>
            <span className="pf-idx">#{i + 1}</span>
            <span className="balls">
              {t.numbers.map((n) => (
                <Ball key={n} n={n} size="sm" variant="pick" />
              ))}
              {t.special !== undefined && <Ball n={t.special} size="sm" variant="special" />}
            </span>
            <button className="btn ghost sm" onClick={() => save(i)}>
              {saved.has(i) ? '✓ Saved' : '☆ Save'}
            </button>
          </div>
        ))}
      </div>

      {/* five columns will not fit a phone, so the same figures stack as cards */}
      <div className="tbl-wrap hide-sm">
        <table className="tbl">
          <thead>
            <tr>
              <th>{count} tickets built this way</th>
              <th className="num">Numbers covered</th>
              <th className="num">Any prize</th>
              <th className="num">Some ticket hits 3+</th>
              <th className="num">Best ticket, average</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <CompareRow key={r.label} label={r.label} stats={r.stats} best={r.stats.pAnyPrize >= bestAny} note={r.note} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="cmp-cards show-sm">
        {rows.map((r) => (
          <div className={`cmp-card${r.stats.pAnyPrize >= bestAny ? ' best' : ''}`} key={r.label}>
            <div className="cmp-title">{r.label}<span className="sub">{r.note}</span></div>
            <dl className="cmp-figs">
              <div><dt>Numbers covered</dt><dd>{r.stats.distinctNumbers}</dd></div>
              <div><dt>Any prize</dt><dd>{fmtPct(r.stats.pAnyPrize, r.stats.pAnyPrize < 0.1 ? 1 : 0)}</dd></div>
              <div><dt>Some ticket hits 3+</dt><dd>{oneIn(r.stats.pAtLeast3)}</dd></div>
              <div><dt>Best ticket, average</dt><dd>{r.stats.avgBestMatch.toFixed(2)}</dd></div>
            </dl>
          </div>
        ))}
      </div>

      <p className="hint" style={{ display: 'block' }}>
        <strong>The one thing arrangement cannot change is the average.</strong> However these {count} tickets are
        laid out, ${spent} buys the same expected {money(lowerEv * count)} back in ordinary prizes and the same{' '}
        {formatOdds(jOdds / count)} at the jackpot — expected value adds up ticket by ticket and never notices whether
        they overlap. What arrangement changes is the <em>shape</em> of the outcome. Spreading turns the same money into
        more frequent, smaller wins; repeating one pick concentrates it into rarer but multiplied ones, since all{' '}
        {count} pay together when that pick lands. Same mean, different variance — and repeating is the version where
        {' '}{count - 1} of your tickets tell you nothing you did not already know.
      </p>
      <p className="hint" style={{ display: 'block', marginTop: 8 }}>
        Measured over {portfolio.trials.toLocaleString()} simulated draws from a fair, uniform machine, so every figure
        here holds whether or not the model's ranking is any good — coverage is a property of the tickets themselves.
        A quick pick is already well spread; the only difference between it and this set is <em>which</em> numbers get
        covered, which is exactly where the model earns or fails to earn its keep.
      </p>
    </SectionCard>
  )
}
