import { useMemo, useState, type PointerEvent, type ReactNode } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import { isRuleKey } from '../engine/rules.ts'
import { formatDate } from '../engine/dates.ts'
import { SPLIT_LABEL, type ModelResult, type SplitKey } from '../engine/research.ts'
import { STRATEGY_LABEL, type EraStrategy } from '../engine/replay.ts'
import { useResearch } from '../hooks/useResearch.ts'
import type { ModelsReport, ReplayReport } from '../engine/researchjob.ts'
import { SectionCard } from './shared.tsx'

const sig = (z: number) => `${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(1)}σ`
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`
const big = (n: number) => n.toLocaleString()

const VERDICT: Record<ModelResult['verdict'], string> = {
  baseline: 'in use',
  retained: 'replaces it',
  'failed-validation': 'no better',
  'failed-test': 'faded on test',
}

interface Series { key: string; label: string; color: string; values: number[] }

/** One result, stacked for a phone: name and verdict, what it tests, then its figures. */
function Row({ title, tag, tone, sub, figs }: { title: string; tag?: string; tone?: 'good' | 'bad'; sub?: string; figs: ReactNode[] }) {
  return (
    <div className="rs-row">
      <div className="rs-row-head">
        <b>{title}</b>
        {tag && <span className={`rs-tag${tone ? ` ${tone}` : ''}`}>{tag}</span>}
      </div>
      {sub && <div className="rs-q">{sub}</div>}
      <div className="rs-figs">{figs.map((f, i) => <span key={i}>{f}</span>)}</div>
    </div>
  )
}

/**
 * Cumulative hits above chance over time, with the band a model with no edge
 * stays inside 95% of the time. A line that leaves the band and stays out is
 * an improvement; one that wanders inside it is ordinary fluctuation, however
 * good its best stretch looks.
 */
function CurveChart({ dates, series, band, label }: { dates: string[]; series: Series[]; band: number[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 320, H = 150, padL = 4, padT = 8, padB = 8
  const n = dates.length
  const lo = Math.min(-1, ...band.map((b) => -b), ...series.flatMap((s) => s.values))
  const hi = Math.max(1, ...band, ...series.flatMap((s) => s.values))
  const y = (v: number) => padT + ((hi - v) / (hi - lo)) * (H - padT - padB)
  // End values label the lines only while they sit apart; converging lines
  // fall back to the legend and the tooltip rather than stacked labels. The
  // margin for them is only reserved when they are drawn.
  const ends = n ? series.map((s) => y(s.values[n - 1])).sort((a, b) => a - b) : []
  const endLabels = series.length > 1 && ends.every((v, i) => i === 0 || v - ends[i - 1] >= 11)
  const padR = endLabels ? 40 : 8
  const x = (i: number) => padL + (n > 1 ? (i / (n - 1)) * (W - padL - padR) : 0)
  const line = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  const bandPath = `${band.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(b).toFixed(1)}`).join(' ')} ${band.map((_, j) => {
    const i = n - 1 - j
    return `L${x(i).toFixed(1)} ${y(-band[i]).toFixed(1)}`
  }).join(' ')} Z`
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - padL) / (W - padL - padR)) * (n - 1)))))
  }
  if (n < 2) return null
  const h = hover
  return (
    <div className="rs-chart">
      {series.length > 1 && (
        <div className="rs-legend">
          {series.map((s) => <span key={s.key}><i style={{ borderTopColor: s.color }} />{s.label}</span>)}
          <span><i className="band" />no-edge range</span>
        </div>
      )}
      <div className="rs-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}
          onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
          <path d={bandPath} className="rs-band" />
          <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} className="rs-zero" />
          {series.map((s) => <path key={s.key} d={line(s.values)} className="rs-line" style={{ stroke: s.color }} />)}
          {endLabels && series.map((s) => (
            <text key={s.key} x={W - padR + 6} y={y(s.values[n - 1]) + 3} className="rs-end">
              {s.values[n - 1] >= 0 ? '+' : '−'}{Math.abs(s.values[n - 1]).toFixed(1)}
            </text>
          ))}
          {h !== null && (
            <>
              <line x1={x(h)} x2={x(h)} y1={padT} y2={H - padB} className="rs-cross" />
              {series.map((s) => <circle key={s.key} cx={x(h)} cy={y(s.values[h])} r="4" className="rs-dot" style={{ fill: s.color }} />)}
            </>
          )}
        </svg>
        {h !== null && (
          <div className="rs-tip" style={{ left: `${Math.min(80, Math.max(20, (x(h) / W) * 100))}%` }}>
            <div className="rs-tip-date">{formatDate(dates[h])}</div>
            {series.map((s) => (
              <div key={s.key} className="rs-tip-row"><i style={{ borderTopColor: s.color }} /><b>{s.values[h] >= 0 ? '+' : ''}{s.values[h].toFixed(1)}</b> {series.length > 1 ? s.label : 'hits above chance'}</div>
            ))}
            <div className="rs-tip-row muted">no edge stays within ±{band[h].toFixed(1)}</div>
          </div>
        )}
      </div>
      <div className="rs-axis"><span>{formatDate(dates[0])}</span><span>flat line = chance</span><span>{formatDate(dates[n - 1])}</span></div>
    </div>
  )
}

function ModelsSection({ report }: { report: ModelsReport }) {
  const cmp = report.models
  if (!cmp) return <p className="hint" style={{ display: 'block' }}>Too few draws under today's rules to compare models yet.</p>
  const base = cmp.models[0]
  const tail = report.tail
  return (
    <>
      <p className="rs-verdict">{cmp.decision.text} {cmp.chance.text}</p>
      <p className="hint" style={{ display: 'block' }}>
        Every model predicted each draw from earlier draws only. The record since {formatDate(cmp.from)} is split in time:{' '}
        {cmp.splits.map((s, i) => (
          <span key={s.key}>{i ? ' · ' : ''}{SPLIT_LABEL[s.key]} {big(s.n)} draws ({formatDate(s.from)} – {formatDate(s.to)})</span>
        ))}. Alternatives are judged on validation against the existing model; only one that passes is looked at on the
        final test. Draws after the method was frozen are the test nothing was tuned on.
      </p>
      <div className="rs-rows">
        {cmp.models.map((m) => (
          <Row
            key={m.key}
            title={m.label}
            tag={VERDICT[m.verdict]}
            tone={m.verdict === 'retained' ? 'good' : undefined}
            sub={m.question}
            figs={[
              m.key === 'ensemble'
                ? <>validation <b>{(m.splits.validate?.top10 ?? 0).toFixed(3)}</b> a draw</>
                : <>validation vs existing <b>{sig(m.splits.validate?.pairedZ ?? 0)}</b></>,
              <>final test <b>{(m.splits.test?.top10 ?? 0).toFixed(3)}</b> ({sig(m.splits.test?.z10 ?? 0)} vs chance)</>,
            ]}
          />
        ))}
      </div>
      <p className="hint" style={{ display: 'block' }}>
        Top-10 hits per draw; chance is {base.all.chance10.toFixed(3)}. An alternative needs {cmp.zNeeded.toFixed(1)}σ over the
        existing model on validation — the bar for {cmp.models.length - 1} rivals at once — not the 2σ a single test would.
      </p>
      <div className="mini-title" style={{ marginTop: 14 }}>The existing model, draw by draw</div>
      <CurveChart
        dates={cmp.curve.map((c) => c.date)}
        series={[{ key: 'ensemble', label: base.label, color: 'var(--series-1)', values: cmp.curve.map((c) => c.values[0]) }]}
        band={cmp.curve.map((c) => c.band)}
        label={`Cumulative top-10 hits above chance for the existing model: ${cmp.curve[cmp.curve.length - 1].values[0].toFixed(1)} after ${big(base.all.n)} draws, against a no-edge range of ±${cmp.curve[cmp.curve.length - 1].band.toFixed(1)}.`}
      />
      <p className="hint" style={{ display: 'block' }}>
        Top-10 hits above chance, added up. The shaded range is where a model with no edge at all ends up 95% of the time;
        a real improvement leaves it and stays out.
      </p>
      <ul className="rs-facts">
        <li>
          <b>Calibration on unseen draws:</b> it said its top 10 would catch {cmp.calibration.predicted10.toFixed(3)} a draw and
          they caught {cmp.calibration.observed10.toFixed(3)} over {big(cmp.calibration.n)} draws (chance {cmp.calibration.chance10.toFixed(3)}; gap {sig(cmp.calibration.z)}).
        </li>
        <li>
          <b>Learned combiner:</b> {cmp.mlLogScore.test >= 0 ? '+' : ''}{cmp.mlLogScore.test.toFixed(4)} nats a draw against a
          flat guess on the final test ({cmp.mlLogScore.validate >= 0 ? '+' : ''}{cmp.mlLogScore.validate.toFixed(4)} on validation) — below zero
          means its probabilities were worse than treating every number alike.
        </li>
        <li>
          <b>Signal overlap:</b> the {cmp.redundancy.signals} signals carry about {cmp.redundancy.effective.toFixed(1)} independent
          readings between them; the closest pairs move together at r = {cmp.redundancy.pairs.slice(0, 3).map((p) => p.r.toFixed(2)).join(', ')}.
        </li>
        {cmp.bonus && (
          <li>
            <b>Bonus ball:</b>{' '}
            {(Object.entries(cmp.bonus.splits) as [SplitKey, NonNullable<NonNullable<typeof cmp.bonus>['splits'][SplitKey]>][])
              .filter(([, v]) => v.n > 0)
              .map(([k, v]) => `${SPLIT_LABEL[k]}: top 3 held it ${pct(v.top3)} of ${big(v.n)} draws against ${pct(v.chance3)} by chance (${sig(v.z3)})`)
              .join('; ')}.
          </li>
        )}
      </ul>

      {tail && (
        <>
          <div className="mini-title" style={{ marginTop: 18 }}>The {tail.D - 1}th and {tail.D}th numbers</div>
          <p className="hint" style={{ display: 'block' }}>
            Four ways of narrowing the top of the sorted draw, each re-fitted before every draw from earlier draws only and
            priced exactly. A restriction counts as predictive only if it keeps winners at a credibly higher rate than it
            keeps combinations — an equally sized random pool keeps exactly its share.
          </p>
          <div className="rs-rows">
            {tail.restrictions.map((r) => (
              <Row
                key={r.key}
                title={r.label}
                tag={r.verdict === 'predictive' ? 'predictive' : r.verdict === 'worse' ? 'fewer than random' : 'chance'}
                tone={r.verdict === 'predictive' ? 'good' : r.verdict === 'worse' ? 'bad' : undefined}
                sub={`Applied today: ${r.today.rule} — ${big(r.today.after)} of ${big(r.today.before)} combinations, ${pct(r.today.eliminated)} removed.`}
                figs={[
                  <>space kept <b>{pct(r.share)}</b></>,
                  <>winners kept <b>{pct(r.survival)}</b> ({pct(r.ciLo)}–{pct(r.ciHi)})</>,
                  <>winners lost <b>{big(r.missed)}</b> of {big(r.n)}</>,
                  <>a random pool this size: <b>{big(Math.round(r.expected))}</b> kept ({sig(r.z)})</>,
                ]}
              />
            ))}
          </div>
          <p className="hint" style={{ display: 'block' }}>
            {big(tail.n)} draws since {formatDate(tail.from)}; a verdict either way needs {tail.zNeeded.toFixed(1)}σ.
            {tail.restrictions.some((r) => r.verdict === 'worse') && ' A restriction fixed before each draw can only keep fewer winners than its share by chance on a fair draw — with this many tests, one that far out turns up about one time in twenty.'}
            {' '}Each one's three consecutive stretches: {tail.restrictions.map((r) => `${r.label.toLowerCase()} ${r.periods.map((p) => sig(p.z)).join(' / ')}`).join('; ')}.
            {' '}{tail.joint.text} Their correlation is {tail.correlation.observed.toFixed(3)} against an exact {tail.correlation.theory.toFixed(3)} ({sig(tail.correlation.z)}).
          </p>
        </>
      )}
    </>
  )
}

const STRAT_COLOR: Record<EraStrategy, string> = { reset: 'var(--series-1)', transfer: 'var(--series-2)', pooled: 'var(--series-3)' }

function ReplaySection({ report }: { report: ReplayReport }) {
  const cmp = report.comparison
  const base = cmp.results[0]
  if (!base.n) return <p className="hint" style={{ display: 'block' }}>No drawings on or after {formatDate(cmp.start)}.</p>
  return (
    <>
      <p className="rs-verdict">{cmp.verdict}</p>
      <div className="rs-rows">
        {cmp.results.map((r) => (
          <Row
            key={r.strategy}
            title={STRATEGY_LABEL[r.strategy]}
            tag={`${sig(r.z10)} vs chance`}
            figs={[
              <><b>{r.top10.toFixed(3)}</b> top-10 hits a draw (chance {r.chance10.toFixed(3)})</>,
              <><b>{r.excess >= 0 ? '+' : ''}{r.excess.toFixed(1)}</b> hits over chance in {big(r.n)} draws</>,
            ]}
          />
        ))}
      </div>
      <CurveChart
        dates={base.curve.map((c) => c.date)}
        series={cmp.results.map((r) => ({ key: r.strategy, label: STRATEGY_LABEL[r.strategy], color: STRAT_COLOR[r.strategy], values: r.curve.map((c) => c.excess) }))}
        band={base.curve.map((c) => c.band)}
        label={`Cumulative top-10 hits above chance from ${formatDate(cmp.start)} for three ways of handling rule changes.`}
      />
      <div className="mini-title" style={{ marginTop: 14 }}>Era by era — starting again at each change</div>
      <div className="rs-rows">
        {base.eras.map((e) => (
          <Row
            key={e.from}
            title={`Numbers 1–${e.K}, from ${formatDate(e.from)}`}
            tag={`${sig(e.z10)} vs chance`}
            sub={e.warmup ? `The first ${e.warmup} drawings were scored at chance while it learned the new pool.` : undefined}
            figs={[
              <><b>{big(e.scored)}</b> drawings</>,
              <><b>{e.top10.toFixed(3)}</b> top-10 hits a draw (chance {e.chance10.toFixed(3)})</>,
            ]}
          />
        ))}
      </div>
      <p className="hint" style={{ display: 'block' }}>
        Trained on everything through {formatDate(base.trainedThrough)}, then predicting each drawing before it was revealed,
        scoring it against the pool in force that day, and learning from it. A 2014 Powerball draw is scored as a 1–59 draw,
        never against the 1–69 pool that came after.
      </p>
    </>
  )
}

/**
 * The research bench: controlled comparisons, a replay from any date, and the
 * top-position study — each run on demand, because each is seconds of work
 * the rest of the app should not wait for.
 */
export function ResearchPanel({ res, draws, ruleKey }: { res: EngineResult; draws: Draw[]; ruleKey: string | undefined }) {
  const models = useResearch()
  const replay = useResearch()
  const first = draws[0]?.date ?? ''
  const last = res.lastDate
  const defaultStart = useMemo(() => {
    const suggested = '2014-12-31'
    if (suggested > first && suggested < last) return suggested
    return first ? `${Number(first.slice(0, 4)) + 3}-12-31` : ''
  }, [first, last])
  const [start, setStart] = useState(defaultStart)
  const official = isRuleKey(ruleKey)

  return (
    <SectionCard
      id="research"
      title="Research"
      sub="Controlled tests of the model on draws it never saw — what beats it, what it beats, and how sure that is."
    >
      {!official && (
        <p className="hint" style={{ display: 'block' }}>
          The research bench needs the published rule schedule, so it runs for the official games only.
        </p>
      )}
      {official && (
        <>
          <div className="mini-title">Does anything beat the existing model?</div>
          <button className="btn primary sm" disabled={models.running}
            onClick={() => models.run({ kind: 'models', draws, ruleKey: ruleKey as 'powerball' | 'megamillions' })}>
            {models.running ? 'Comparing…' : models.report ? 'Run it again' : 'Run the comparison'}
          </button>
          {models.error && <p className="notice warn">{models.error}</p>}
          {models.report?.kind === 'models' && <ModelsSection report={models.report} />}

          <div className="mini-title" style={{ marginTop: 22 }}>Replay from a date</div>
          <p className="hint" style={{ display: 'block' }}>
            Train on everything before the date, then predict every drawing since, one at a time — three ways of handling
            each rule change, judged on the same drawings.
          </p>
          <div className="rs-controls">
            <label>
              Predict from
              <input type="date" value={start} min={first} max={last} onChange={(e) => setStart(e.target.value)} />
            </label>
            <button className="btn primary sm" disabled={replay.running || !start}
              onClick={() => replay.run({ kind: 'replay', draws, ruleKey: ruleKey as 'powerball' | 'megamillions', start })}>
              {replay.running ? 'Replaying…' : 'Replay'}
            </button>
          </div>
          {replay.error && <p className="notice warn">{replay.error}</p>}
          {replay.report?.kind === 'replay' && <ReplaySection report={replay.report} />}
        </>
      )}
    </SectionCard>
  )
}
