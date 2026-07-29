import { useState } from 'react'
import { useMeasure } from '../../hooks/useLocalStorage.ts'

export interface BarDatum {
  label: string
  value: number
  highlight?: boolean
}

interface Props {
  data: BarDatum[]
  height?: number
  color?: string
  highlightColor?: string
  xTickEvery?: number
  format?: (v: number) => string
  tooltipTitle?: (d: BarDatum) => string
}

function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1]
  const target = max / 3.5
  const pow = Math.pow(10, Math.floor(Math.log10(target)))
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= target) ?? pow * 10
  const ticks: number[] = []
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(6)))
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step)
  return ticks
}

/** Column chart: thin marks, 4px rounded data-end, square baseline, 2px surface gaps. */
export function BarChart({ data, height = 190, color = 'var(--accent)', highlightColor = 'var(--series-2)', xTickEvery, format = (v) => String(v), tooltipTitle }: Props) {
  const [ref, width] = useMeasure<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const M = { top: 10, right: 6, bottom: 24, left: 34 }
  const plotW = Math.max(0, width - M.left - M.right)
  const plotH = height - M.top - M.bottom
  const max = Math.max(1, ...data.map((d) => d.value))
  const ticks = niceTicks(max)
  const yMax = ticks[ticks.length - 1]
  const band = data.length > 0 ? plotW / data.length : 0
  const barW = Math.max(1, Math.min(24, band - 2))
  const every = xTickEvery ?? Math.max(1, Math.ceil(data.length / Math.max(4, Math.floor(plotW / 46))))
  const y = (v: number) => M.top + plotH * (1 - v / yMax)

  const hovered = hover !== null ? data[hover] : null
  const ttX = hover !== null ? Math.min(M.left + hover * band + band / 2, Math.max(0, width - 150)) : 0

  return (
    <div className="chart-box" ref={ref}>
      {width > 40 && (
        <svg width={width} height={height} role="img" aria-label="Bar chart">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={M.left - 7} y={y(t) + 3.5} textAnchor="end" fontSize={10.5} fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {format(t)}
              </text>
            </g>
          ))}
          <line x1={M.left} x2={width - M.right} y1={y(0)} y2={y(0)} stroke="var(--axis)" strokeWidth={1} />
          {data.map((d, i) => {
            const bx = M.left + i * band + (band - barW) / 2
            const by = y(d.value)
            const h = Math.max(0, y(0) - by)
            const r = Math.min(4, barW / 2, h)
            const fill = d.highlight ? highlightColor : color
            return (
              <g key={i}>
                {h > 0 && (
                  <path
                    d={`M ${bx} ${by + r} Q ${bx} ${by} ${bx + r} ${by} L ${bx + barW - r} ${by} Q ${bx + barW} ${by} ${bx + barW} ${by + r} L ${bx + barW} ${y(0)} L ${bx} ${y(0)} Z`}
                    fill={fill}
                    style={hover === i ? { filter: 'brightness(1.15)' } : undefined}
                  />
                )}
                {i % every === 0 && (
                  <text x={M.left + i * band + band / 2} y={height - 7} textAnchor="middle" fontSize={10.5} fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {d.label}
                  </text>
                )}
                <rect
                  x={M.left + i * band} y={M.top} width={Math.max(band, 8)} height={plotH}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                />
              </g>
            )
          })}
        </svg>
      )}
      {hovered && (
        <div className="chart-tooltip" style={{ left: ttX, top: 2 }}>
          <div className="tt-title">{tooltipTitle ? tooltipTitle(hovered) : hovered.label}</div>
          <div className="tt-row">
            <span className="tt-key" style={{ borderColor: hovered.highlight ? highlightColor : color }} />
            <span className="tt-val">{format(hovered.value)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
