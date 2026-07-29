import { useState } from 'react'
import { useMeasure } from '../../hooks/useLocalStorage.ts'

export interface LineSeries {
  name: string
  color: string
  values: number[]
}

interface Props {
  xLabels: string[]
  series: LineSeries[]
  /** Semantic reference line (e.g. chance level) — drawn dashed, labeled in the legend */
  threshold?: { value: number; label: string }
  height?: number
  yFormat?: (v: number) => string
  yMaxHint?: number
}

/** Multi-series line chart with a snapping crosshair and one shared tooltip. */
export function LineChart({ xLabels, series, threshold, height = 220, yFormat = (v) => v.toFixed(2), yMaxHint }: Props) {
  const [ref, width] = useMeasure<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const M = { top: 10, right: 10, bottom: 24, left: 40 }
  const plotW = Math.max(0, width - M.left - M.right)
  const plotH = height - M.top - M.bottom
  const n = xLabels.length
  let dataMax = Math.max(yMaxHint ?? 0, threshold?.value ?? 0, ...series.flatMap((s) => s.values))
  if (dataMax <= 0) dataMax = 1
  // Clean tick step (1/2/2.5/5 × 10^k), axis max = first multiple above the data
  const rawStep = dataMax / 3.5
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rawStep) ?? pow * 10
  const max = Math.ceil((dataMax * 1.04) / step) * step
  const x = (i: number) => M.left + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1))
  const y = (v: number) => M.top + plotH * (1 - v / max)

  const yTicks: number[] = []
  for (let v = 0; v <= max + 1e-9; v += step) yTicks.push(v)
  const xEvery = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(plotW / 78))))

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    if (n === 0) return
    const i = Math.round(((px - M.left) / Math.max(1, plotW)) * (n - 1))
    setHover(Math.max(0, Math.min(n - 1, i)))
  }

  const ttLeft = hover !== null ? Math.min(x(hover) + 12, Math.max(0, width - 190)) : 0

  return (
    <div className="chart-box" ref={ref}>
      {width > 40 && n > 1 && (
        <svg width={width} height={height} role="img" aria-label="Line chart" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {yTicks.map((t, k) => (
            <g key={k}>
              <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={M.left - 7} y={y(t) + 3.5} textAnchor="end" fontSize={10.5} fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {yFormat(t)}
              </text>
            </g>
          ))}
          {xLabels.map((lbl, i) =>
            i % xEvery === 0 ? (
              <text key={i} x={x(i)} y={height - 7} textAnchor="middle" fontSize={10.5} fill="var(--muted)">
                {lbl}
              </text>
            ) : null,
          )}
          {threshold && (
            <line x1={M.left} x2={width - M.right} y1={y(threshold.value)} y2={y(threshold.value)} stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="5 4" />
          )}
          {series.map((s) => (
            <path
              key={s.name}
              d={s.values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + plotH} stroke="var(--axis)" strokeWidth={1} />
              {series.map((s) => (
                <circle key={s.name} cx={x(hover)} cy={y(s.values[hover])} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
      )}
      {hover !== null && (
        <div className="chart-tooltip" style={{ left: ttLeft, top: 4 }}>
          <div className="tt-title">{xLabels[hover]}</div>
          {series.map((s) => (
            <div className="tt-row" key={s.name}>
              <span className="tt-key" style={{ borderColor: s.color }} />
              <span className="tt-val">{yFormat(s.values[hover])}</span>
              <span className="tt-name">{s.name}</span>
            </div>
          ))}
          {threshold && (
            <div className="tt-row">
              <span className="tt-key" style={{ borderColor: 'var(--muted)', borderTopStyle: 'dashed' }} />
              <span className="tt-val">{yFormat(threshold.value)}</span>
              <span className="tt-name">{threshold.label}</span>
            </div>
          )}
        </div>
      )}
      <div className="legend">
        {series.map((s) => (
          <span className="item" key={s.name}>
            <span className="key-line" style={{ borderColor: s.color }} /> {s.name}
          </span>
        ))}
        {threshold && (
          <span className="item">
            <span className="key-dash" /> {threshold.label}
          </span>
        )}
      </div>
    </div>
  )
}
