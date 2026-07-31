import { useState } from 'react'
import type { EngineResult } from '../engine/types.ts'
import type { ColumnStat } from '../engine/positions.ts'
import { SectionCard, Ball, fmtPct } from './shared.tsx'

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th']

/** Small distribution strip: observed histogram bars + the theoretical curve. */
function ColumnCurve({ col, K, highlight }: { col: ColumnStat; K: number; highlight?: number }) {
  const W = 260
  const H = 54
  let maxObs = 0
  for (let v = 1; v <= K; v++) maxObs = Math.max(maxObs, col.counts[v])
  let maxTh = 0
  for (let v = 1; v <= K; v++) maxTh = Math.max(maxTh, col.theory[v] * col.draws)
  const scale = Math.max(maxObs, maxTh, 1)
  const x = (v: number) => ((v - 1) / Math.max(1, K - 1)) * W
  const bw = Math.max(1.2, W / K - 0.8)
  const theoryPath = Array.from({ length: K }, (_, i) => {
    const v = i + 1
    return `${i === 0 ? 'M' : 'L'} ${x(v).toFixed(1)} ${(H - (col.theory[v] * col.draws * H) / scale).toFixed(1)}`
  }).join(' ')

  return (
    <div className="col-chart">
      {/* preserveAspectRatio=none + non-scaling strokes: the histogram stretches
          to the card width without inflating line weights or label text */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="col-curve"
        role="img"
        aria-label={`Column ${col.position} distribution across values 1 to ${K}`}
      >
        <rect x={x(col.p10)} y={0} width={Math.max(1.5, x(col.p90) - x(col.p10))} height={H}
          fill="var(--accent)" opacity={0.1} />
        {Array.from({ length: K }, (_, i) => {
          const v = i + 1
          const h = (col.counts[v] * H) / scale
          if (h <= 0) return null
          return <rect key={v} x={x(v) - bw / 2} y={H - h} width={bw} height={h}
            fill={highlight === v ? 'var(--gold-bright)' : 'var(--accent)'} opacity={highlight === v ? 1 : 0.6} />
        })}
        <path d={theoryPath} fill="none" stroke="var(--series-2)" strokeWidth={2}
          strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--axis)" strokeWidth={1}
          vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="col-axis">
        <span>1</span>
        <span className="band-note">typical band {col.p10}–{col.p90}</span>
        <span>{K}</span>
      </div>
    </div>
  )
}

/**
 * Compares each draw column against the entire history of that same column —
 * the 1st ball against every 1st ball, the 2nd against every 2nd, and so on.
 */
export function PositionsPanel({ res }: { res: EngineResult }) {
  const pa = res.positionAnalysis
  const [sel, setSel] = useState(0)
  if (!pa || pa.columns.length === 0) return null
  const K = pa.K
  const col = pa.columns[Math.min(sel, pa.columns.length - 1)]
  const fit = res.bestComboFit
  const pickForCol = fit?.perColumn.find((c) => c.position === col.position)
  const label = pa.sorted ? `${ORDINAL[col.position - 1]} ball (lowest→highest)` : `Column ${col.position} (draw order)`

  return (
    <SectionCard
      id="columns"
      title="Column analysis"
      hint="every column vs its own history"
      sub={
        pa.sorted
          ? `Each column compared against every draw's same column — the 1st ball against all ${pa.totalDraws.toLocaleString()} first balls, the 2nd against all second balls, and so on. Because the feed is ascending, each column is an order statistic with its own strongly-defined range.`
          : `Each column compared against every draw's same column across ${pa.totalDraws.toLocaleString()} draws, in the source draw order.`
      }
    >
      <div className="col-tabs" role="tablist" aria-label="Draw column">
        {pa.columns.map((c, i) => (
          <button
            key={c.position}
            role="tab"
            aria-selected={i === Math.min(sel, pa.columns.length - 1)}
            className={i === Math.min(sel, pa.columns.length - 1) ? 'on' : ''}
            onClick={() => setSel(i)}
          >
            <span className="ord">{ORDINAL[c.position - 1] ?? `#${c.position}`}</span>
            <span className="rng">{c.min}–{c.max}</span>
          </button>
        ))}
      </div>

      <div className="col-detail">
        <div className="col-headline">
          <div>
            <div className="mini-title" style={{ marginBottom: 2 }}>{label}</div>
            <div className="col-stat-row">
              <span><b>{col.mean.toFixed(1)}</b> average</span>
              <span className="sep">·</span>
              <span>typically <b>{col.p10}–{col.p90}</b></span>
              <span className="sep">·</span>
              <span>ever seen <b>{col.min}–{col.max}</b></span>
            </div>
          </div>
          {pickForCol && (
            <div className="col-pick">
              <Ball n={pickForCol.value} size="sm" variant={pickForCol.outOfRange ? 'faded' : 'pick'} />
              <span className="meta">
                model's pick · {fmtPct(pickForCol.percentile, 0)} of this column sits below it
              </span>
            </div>
          )}
        </div>

        <ColumnCurve col={col} K={K} highlight={pickForCol?.value} />
        <div className="legend" style={{ marginTop: 2 }}>
          <span className="item"><span className="key-rect" style={{ background: 'var(--accent)' }} /> Observed in this column</span>
          <span className="item"><span className="key-line" style={{ borderColor: 'var(--series-2)' }} /> Expected shape</span>
        </div>

        <div className="col-facts">
          <div className="col-fact">
            <span className="k">Never below / above</span>
            <span className="v">{col.min} / {col.max}</span>
            <span className="d">
              in {col.draws.toLocaleString()} draws the {ORDINAL[col.position - 1]} ball has never fallen outside this range
            </span>
          </div>
          <div className="col-fact">
            <span className="k">Values never seen here</span>
            <span className="v">{col.neverSeen} of {K}</span>
            <span className="d">{col.distinct} different numbers have held this column</span>
          </div>
          <div className="col-fact">
            <span className="k">Average vs expected</span>
            <span className="v">{col.mean.toFixed(1)} vs {col.theoryMean.toFixed(1)}</span>
            <span className="d">
              {Math.abs(col.mean - col.theoryMean) < 1.2
                ? 'matches the mathematically expected value — this column is behaving normally'
                : 'drifts from the expected value — worth watching, but small samples wander'}
            </span>
          </div>
        </div>

        <div className="mini-title" style={{ marginTop: 4 }}>Most frequent in this column</div>
        <div className="chip-row">
          {col.top.map((t) => (
            <span className="chip" key={t.number}>
              <Ball n={t.number} size="sm" />
              <span className="meta">{t.count}× · expected {t.expected.toFixed(1)}</span>
            </span>
          ))}
        </div>
      </div>

      <p className="hint" style={{ display: 'block', marginTop: 14 }}>
        {pa.sorted ? (
          <>
            Straight talk: these column shapes are real and strong, but they come from sorting, not from a game bias —
            the observed averages track the mathematically expected ones almost exactly. So this does not make any single
            number more likely. Where it genuinely pays off is <strong>ticket shape</strong>: a line whose lowest number
            is above {col.position === 1 ? col.max : pa.columns[0].max} or whose highest is below{' '}
            {pa.columns[pa.columns.length - 1].min} has never occurred here, and the combination builder now penalizes
            shapes this history has never produced.
          </>
        ) : (
          <>
            This feed publishes numbers in draw order, so each column is a genuine draw slot rather than a sorted rank —
            any consistent per-column tendency here would be a real effect, and the ensemble's Position-fit signal
            already scores numbers against these distributions.
          </>
        )}
      </p>
    </SectionCard>
  )
}
