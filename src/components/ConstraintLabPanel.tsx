import { useMemo, useState } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import type { ConstraintMode, ConstraintRule } from '../engine/constraintlab.ts'
import { inspectCombination } from '../engine/constraintlab.ts'
import { contextAt } from '../engine/constraints.ts'
import { formatDate } from '../engine/dates.ts'
import { SectionCard, Ball, Tile, fmtPct } from './shared.tsx'

const TIER_LABEL: Record<ConstraintRule['tier'], string> = {
  impossible: 'impossible',
  'ultra-rare': 'ultra rare',
  'historically-rare': 'real edge',
  typical: 'typical',
  unsupported: 'costs what it saves',
}

const big = (n: number) => n.toLocaleString()

/**
 * Reduction against survival, with the fair-lottery diagonal behind it.
 *
 * The diagonal is the identity: keep 80% of the space and a fair machine leaves
 * you 80% of the winners. Every point the frontier makes lands on that line, and
 * seeing them land there says more than any paragraph can.
 */
function ParetoChart({ points }: { points: { spaceShare: number; survival: number; rules: number }[] }) {
  if (points.length < 3) return null
  // Left to right: more of the space removed. Top to bottom: more winners lost.
  // So the fair line falls from the top-left corner, and a frontier that beats
  // it would bow above the dashes rather than lying on them.
  const worst = Math.min(0.75, ...points.map((p) => Math.min(p.spaceShare, p.survival))) - 0.02
  const span = 1 - worst
  const x = (v: number) => ((1 - v) / span) * 100
  const y = (v: number) => ((1 - v) / span) * 100
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.spaceShare).toFixed(2)} ${y(p.survival).toFixed(2)}`).join(' ')
  const last = points[points.length - 1]
  return (
    <div className="cl-pareto">
      <div className="cl-pareto-frame">
        <span className="cl-axis-y">winners kept</span>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
          aria-label={`Winners kept against space removed. Removing ${fmtPct(1 - last.spaceShare, 1)} of the space left ${fmtPct(last.survival, 1)} of winners.`}>
          <line className="cl-fair" x1="0" y1="0" x2="100" y2="100" vectorEffect="non-scaling-stroke" />
          <path className="cl-front" d={path} vectorEffect="non-scaling-stroke" />
          {points.map((p) => (
            <circle key={p.rules} cx={x(p.spaceShare)} cy={y(p.survival)} r="1.6"
              vectorEffect="non-scaling-stroke" className="cl-dot" />
          ))}
        </svg>
        <span className="cl-axis-x">space removed →</span>
      </div>
      <div className="cl-pareto-legend">
        <span><i className="fair" /> the fair line: winners kept = space kept</span>
        <span><i className="front" /> what these draws gave, rule by rule</span>
      </div>
    </div>
  )
}

/**
 * The allowed band for each sorted position: what arithmetic permits, what the
 * rule keeps, and where the model's own pick falls inside it.
 */
function PositionMap({ lab, pick }: { lab: NonNullable<EngineResult['constraintLab']>; pick: number[] | null }) {
  const bands = lab.positionBands
  if (!bands.length) return null
  const sorted = pick ? [...pick].sort((a, b) => a - b) : null

  // One scale across every row, so the bands visibly march up the pool the way
  // sorted positions must.
  const span = lab.K - 1
  const pc = (v: number) => ((v - 1) / span) * 100
  const width = (a: number, b: number) => Math.max(1.5, pc(b) - pc(a))

  return (
    <div className="cl-posmap">
      {bands.map((b) => {
        const value = sorted?.[b.position - 1] ?? null
        const outside = value !== null && (value < b.lo || value > b.hi)
        return (
          <div className="cl-pos-row" key={b.position}>
            <span className="cl-pos-name">#{b.position}</span>
            <span className="cl-pos-track">
              <i className="hard" style={{ left: `${pc(b.hardMin)}%`, width: `${width(b.hardMin, b.hardMax)}%` }} />
              <i className="band" style={{ left: `${pc(b.lo)}%`, width: `${width(b.lo, b.hi)}%` }} />
              <i className="core" style={{ left: `${pc(b.p25)}%`, width: `${width(b.p25, b.p75)}%` }} />
              <b className="median" style={{ left: `${pc(b.median)}%` }} />
              {value !== null && (
                <b className={outside ? 'mark out' : 'mark'} style={{ left: `${Math.min(99, Math.max(0, pc(value)))}%` }} />
              )}
            </span>
            <span className="cl-pos-range">{b.p25}–{b.p75}</span>
          </div>
        )
      })}
      <div className="cl-pos-scale"><span>1</span><span>{lab.K}</span></div>
      <p className="hint" style={{ display: 'block', marginTop: 2 }}>
        Faint bar is everything the arithmetic allows. The wide band held {fmtPct(bands[0].coverage, 1)} of draws, the
        bright core the middle half, and the tick is the median — the column on the right is that middle half.
        {sorted && ' The gold marks are where the model\'s own pick falls.'} None of it is a wall: a number outside a
        band is unusual, never impossible.
      </p>
    </div>
  )
}

function RuleRow({ rule }: { rule: ConstraintRule }) {
  return (
    <div className={`cl-rule tier-${rule.tier}`}>
      <div className="cl-rule-head">
        <span className="cl-rule-name">{rule.label}</span>
        <span className={`cl-tier tier-${rule.tier}`}>{TIER_LABEL[rule.tier]}</span>
      </div>
      <div className="cl-rule-range">
        keep {rule.lo}–{rule.hi}
        <span className="sub">
          {' '}· arithmetic allows {rule.hardMin}–{rule.hardMax}
          {Number.isFinite(rule.observedMin) && <> · seen {rule.observedMin}–{rule.observedMax}</>}
        </span>
      </div>
      <div className="cl-rule-figs">
        <span><b>{fmtPct(1 - rule.spaceShare, 1)}</b> of space cut</span>
        <span><b>{fmtPct(1 - rule.survival, 1)}</b> of winners cut</span>
        <span className={rule.provenEdge ? 'good' : undefined}>
          <b>{rule.edgeZ >= 0 ? '+' : ''}{rule.edgeZ.toFixed(1)}σ</b> edge
        </span>
      </div>
    </div>
  )
}

/**
 * Constraint Lab — how far the candidate space can be cut while keeping the
 * winners it has never seen.
 *
 * The panel leads with the identity that governs the whole exercise, because
 * without it every number here is easy to misread: against a fair machine the
 * chance a winner survives a filter equals the share of combinations that
 * filter keeps. Cutting is never free. What the walk-forward test measures is
 * whether these particular draws deviate from that — and the answer is
 * reported whichever way it falls.
 */
export function ConstraintLabPanel({ res, draws }: { res: EngineResult; draws: Draw[] }) {
  const lab = res.constraintLab
  const [modeKey, setModeKey] = useState<ConstraintMode['key']>('balanced')
  const [showAll, setShowAll] = useState(false)

  const mode = lab?.modes.find((m) => m.key === modeKey) ?? lab?.modes[1] ?? null

  const verdict = useMemo(() => {
    if (!lab || !mode) return null
    const proven = lab.rules.filter((r) => r.provenEdge).length
    return { proven }
  }, [lab, mode])

  const inspection = useMemo(() => {
    if (!lab || !mode || !res.bestCombo) return null
    return inspectCombination(lab, mode, res.bestCombo.numbers, contextAt(draws, draws.length))
  }, [lab, mode, res.bestCombo, draws])

  if (!lab || !mode) {
    return (
      <SectionCard
        id="constraints"
        title="Constraint Lab"
        sub="How far the candidate space can be cut while keeping winners it has never seen."
      >
        <p className="hint" style={{ display: 'block' }}>
          Needs about 160 draws from the game's <em>current</em> rule era before any rule can be built from the past and
          tested against the future. Draws from a retired number pool do not count towards that, however many of them
          there are: a range fitted across a pool change describes a machine that no longer exists.
        </p>
      </SectionCard>
    )
  }

  const cutPct = 1 - mode.spaceShare
  const holdoutGap = mode.holdoutSurvival - mode.spaceShare

  return (
    <SectionCard
      id="constraints"
      title="Constraint Lab"
      sub={`Search-space reduction, tested walk-forward over ${big(lab.evaluated)} draws no rule had seen.`}
    >
      <div className="cl-law">
        <strong>The rule that governs all of this:</strong> against a fair machine, the chance the winner survives a
        filter <em>equals</em> the share of combinations that filter keeps. Cut 10% of the space and you cut 10% of the
        winners. So the only question worth asking is whether these draws beat that identity — and every figure below is
        paired with the space share it has to beat.
      </div>

      {lab.eraTrim && (
        <p className="hint cl-era" style={{ display: 'block' }}>
          Built from the {big(lab.eraTrim.kept)} draws since {formatDate(lab.eraTrim.cutoffDate)} only. The{' '}
          {big(lab.eraTrim.excluded)} older draws came off a {lab.eraTrim.earlyMax}-ball pool rather than today's{' '}
          {lab.eraTrim.currentMax}, and a range fitted across that change describes a machine that no longer exists —
          measured against today's pool it reads as an enormous edge that can never repeat.
        </p>
      )}

      <div className="cl-modes" role="tablist" aria-label="Reduction strength">
        {lab.modes.map((m) => (
          <button
            key={m.key}
            role="tab"
            aria-selected={m.key === mode.key}
            className={m.key === mode.key ? 'on' : ''}
            onClick={() => setModeKey(m.key)}
          >
            {m.label}
            <span className="sub">aims to keep {fmtPct(m.target, 1)}</span>
          </button>
        ))}
      </div>

      <div className="tiles">
        <Tile
          label="Candidates remaining"
          value={big(mode.combinationsAfter)}
          delta={`from ${big(mode.combinationsBefore)} — ${fmtPct(cutPct, 1)} removed`}
          deltaDir={cutPct > 0.001 ? 'up' : 'flat'}
        />
        <Tile
          label="Unseen winners kept"
          value={fmtPct(mode.survival, 2)}
          delta={`against ${fmtPct(mode.spaceShare, 2)} of the space kept`}
          deltaDir={mode.survival >= mode.spaceShare ? 'up' : 'down'}
        />
        <Tile
          label="Held-out winners kept"
          value={fmtPct(mode.holdoutSurvival, 2)}
          delta={`${big(mode.holdoutDraws)} draws the optimiser never saw`}
          deltaDir={holdoutGap > 0 ? 'up' : 'down'}
        />
        <Tile
          label="Beat the fair line by"
          value={`${mode.holdoutEdgeZ >= 0 ? '+' : ''}${mode.holdoutEdgeZ.toFixed(1)}σ`}
          delta={mode.holdoutEdgeZ >= 2 ? 'real on held-out draws' : 'inside noise — cutting costs what it saves'}
          deltaDir={mode.holdoutEdgeZ >= 2 ? 'up' : 'flat'}
        />
      </div>

      <p className="hint" style={{ display: 'block' }}>
        {verdict?.proven
          ? `${verdict.proven} of ${lab.rules.length} candidate rules kept winners at least 2σ above their own space share.`
          : `Not one of ${lab.rules.length} candidate rules kept winners meaningfully better than it kept candidates.`}
        {' '}In-sample this selection reads {mode.edgeZ >= 0 ? '+' : ''}{mode.edgeZ.toFixed(1)}σ, but the optimiser chose
        those rules on that same record; on the held-out half it reads {mode.holdoutEdgeZ >= 0 ? '+' : ''}
        {mode.holdoutEdgeZ.toFixed(1)}σ. Trust the second number.
        {mode.survival < mode.target && (
          <> The {fmtPct(mode.target, 1)} target was met on the draws the optimiser could see; across the whole record
          it lands at {fmtPct(mode.survival, 2)}, and that shortfall is the honest cost of choosing rules from history.</>
        )}
      </p>

      {lab.pareto.length > 2 && (
        <>
          <div className="mini-title" style={{ marginTop: 18 }}>Cut deeper and this is what it costs</div>
          <ParetoChart points={lab.pareto} />
        </>
      )}

      <div className="mini-title" style={{ marginTop: 18 }}>Where each drawn number lands</div>
      <PositionMap lab={lab} pick={res.bestCombo?.numbers ?? null} />

      {mode.funnel.length > 0 && (
        <>
          <div className="mini-title" style={{ marginTop: 16 }}>What each rule removes</div>
          <div className="cl-funnel">
            {mode.funnel.map((f) => (
              <div className="cl-funnel-step" key={f.ruleId}>
                <div className="cl-funnel-bar">
                  <i style={{ width: `${Math.max(1, f.spaceShare * 100)}%` }} />
                  <span className="cl-funnel-label">{f.label}</span>
                </div>
                <span className="cl-funnel-num">
                  −{fmtPct(f.removed, 1)} space<span className="sub"> · {fmtPct(f.survival, 1)} winners left</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {inspection && (
        <>
          <div className="mini-title" style={{ marginTop: 18 }}>The model's pick, rule by rule</div>
          <div className="cl-inspect">
            <span className="balls">
              {inspection.numbers.map((n) => <Ball key={n} n={n} size="sm" variant="pick" />)}
            </span>
            <span className={`cl-verdict ${inspection.survives ? 'ok' : 'no'}`}>
              {inspection.survives ? `survives all ${inspection.passed.length} rules` : `rejected by ${inspection.failed.length}`}
            </span>
          </div>
          {inspection.failed.length > 0 && (
            <div className="cl-fails">
              {inspection.failed.map((f) => (
                <div key={f.id}>{f.label}: <b>{f.value}</b> outside {f.lo}–{f.hi}</div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="mini-title" style={{ marginTop: 18 }}>
        Rules ranked by how much they remove
      </div>
      <div className="cl-rules">
        {(showAll ? lab.rules : lab.rules.filter((r) => r.usable).sort((a, b) => a.spaceShare - b.spaceShare).slice(0, 8))
          .map((r) => <RuleRow key={r.id} rule={r} />)}
      </div>
      <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setShowAll((v) => !v)}>
        {showAll ? 'Show the strongest only' : `Show all ${lab.rules.length} candidate rules`}
      </button>

      {mode.eliminated.length > 0 && (
        <>
          <div className="mini-title" style={{ marginTop: 18 }}>
            Winners this setting would have thrown away
            {' '}({big(Math.round((1 - mode.survival) * lab.evaluated))} of {big(lab.evaluated)})
          </div>
          <div className="cl-elim">
            {mode.eliminated.slice(0, 8).map((e) => (
              <div className="cl-elim-row" key={e.date}>
                <span className="cl-elim-date">{formatDate(e.date)}</span>
                <span className="balls">{e.numbers.map((n) => <Ball key={n} n={n} size="sm" variant="faded" />)}</span>
                <span className="sub">{e.failed.slice(0, 2).join(', ')}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="hint" style={{ display: 'block', marginTop: 14 }}>
        Space share is estimated from {big(lab.sampleSize)} uniformly random combinations re-measured against every
        draw's own context, so survival and space share are averaged over the same conditions — comparing them at a
        single context is what makes shape filters look predictive when they are not. Rules that depend on the previous
        draw are measured but never combined, because their membership changes with that draw. Nothing here is treated
        as impossible unless the game's arithmetic forbids it; a shape that has never appeared still keeps a non-zero
        probability. And filtering never improves the odds of a ticket you hold — every combination is 1 in{' '}
        {big(lab.universe)} whatever shape it has. It decides where your tickets sit, not what they are worth.
      </p>
    </SectionCard>
  )
}
