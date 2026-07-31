import type { Draw } from './types.ts'
import { choose } from './odds.ts'

export interface ColumnStat {
  /** 1-based column index (1 = lowest ball in the draw, D = highest) */
  position: number
  /** Observed count of each value 1..K in this column (index 0 unused) */
  counts: Float64Array
  /** Exact order-statistic probability of each value 1..K landing in this column */
  theory: Float64Array
  draws: number
  mean: number
  theoryMean: number
  sd: number
  min: number
  max: number
  p10: number
  p25: number
  median: number
  p75: number
  p90: number
  /** How many distinct values have ever appeared in this column */
  distinct: number
  /** Values that have never appeared in this column, as a count */
  neverSeen: number
  /** Standout values: observed far above their theoretical rate in this column */
  top: { number: number; count: number; expected: number; z: number }[]
  /** Chi-square goodness-of-fit of observed vs order-statistic theory, and its dof */
  chi2: number
  chi2Dof: number
}

export interface PositionAnalysis {
  drawSize: number
  K: number
  totalDraws: number
  columns: ColumnStat[]
  /** True when the source feed is ascending (columns are order statistics, not draw order) */
  sorted: boolean
}

/** P(r-th smallest of D drawn from 1..K equals v) — exact order-statistic pmf. */
export function orderStatPmf(K: number, D: number, r: number, v: number): number {
  if (v < r || v > K - (D - r)) return 0
  return (choose(v - 1, r - 1) * choose(K - v, D - r)) / choose(K, D)
}

/**
 * Compare every draw column against the whole history of that same column.
 * For an ascending feed each column is an order statistic (1st = lowest ball,
 * D-th = highest), which has a strong, exactly-computable distribution — so the
 * observed shape is reported next to the theoretical one.
 */
export function analyzePositions(draws: Draw[], K: number, D: number, sorted: boolean): PositionAnalysis {
  const n = draws.length
  const columns: ColumnStat[] = []

  for (let p = 0; p < D; p++) {
    const counts = new Float64Array(K + 1)
    const values: number[] = []
    for (const d of draws) {
      const v = (sorted ? d.sorted : d.numbers)[p]
      if (v >= 1 && v <= K) { counts[v]++; values.push(v) }
    }
    const m = values.length
    if (m === 0) continue
    values.sort((a, b) => a - b)
    const mean = values.reduce((a, b) => a + b, 0) / m
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / m)
    const q = (f: number) => values[Math.min(m - 1, Math.floor(f * m))]

    const theory = new Float64Array(K + 1)
    let theoryMean = 0
    for (let v = 1; v <= K; v++) {
      theory[v] = sorted ? orderStatPmf(K, D, p + 1, v) : 1 / K
      theoryMean += v * theory[v]
    }

    let distinct = 0
    let chi2 = 0
    let chi2Dof = 0
    const top: ColumnStat['top'] = []
    for (let v = 1; v <= K; v++) {
      if (counts[v] > 0) distinct++
      const expected = m * theory[v]
      if (expected >= 5) {
        chi2 += ((counts[v] - expected) ** 2) / expected
        chi2Dof++
      }
      if (expected > 0.5) {
        const sdv = Math.sqrt(Math.max(1e-9, expected * (1 - theory[v])))
        top.push({ number: v, count: counts[v], expected, z: (counts[v] - expected) / sdv })
      }
    }
    top.sort((a, b) => b.z - a.z)

    columns.push({
      position: p + 1,
      counts,
      theory,
      draws: m,
      mean,
      theoryMean,
      sd,
      min: values[0],
      max: values[m - 1],
      p10: q(0.1),
      p25: q(0.25),
      median: q(0.5),
      p75: q(0.75),
      p90: q(0.9),
      distinct,
      neverSeen: K - distinct,
      top: top.slice(0, 5),
      chi2,
      chi2Dof: Math.max(1, chi2Dof - 1),
    })
  }

  return { drawSize: D, K, totalDraws: n, columns, sorted }
}

export interface PositionalFit {
  /** Per-column verdict for a candidate combination (sorted ascending) */
  perColumn: { position: number; value: number; percentile: number; typicalLow: number; typicalHigh: number; outOfRange: boolean }[]
  /** Mean log-likelihood of the combination's columns under the observed history */
  logLik: number
  /** How this combination's positional shape ranks vs history: 0..1 (higher = more typical) */
  plausibility: number
  /** Columns that have never historically held a value this extreme */
  impossibleColumns: number[]
}

/**
 * Score a candidate combination's positional shape against the per-column
 * history: is each ball in a range that column actually produces?
 */
export function positionalFit(analysis: PositionAnalysis, combo: number[]): PositionalFit {
  const sortedCombo = [...combo].sort((a, b) => a - b)
  const perColumn: PositionalFit['perColumn'] = []
  const impossibleColumns: number[] = []
  let logLik = 0

  sortedCombo.forEach((value, i) => {
    const col = analysis.columns[i]
    if (!col) return
    let below = 0
    for (let v = 1; v < value; v++) below += col.counts[v]
    const percentile = col.draws > 0 ? below / col.draws : 0
    const outOfRange = value < col.min || value > col.max
    if (outOfRange) impossibleColumns.push(i + 1)
    // Smoothed likelihood of this exact value in this column
    const pObs = (col.counts[value] + 1) / (col.draws + analysis.K)
    logLik += Math.log(pObs)
    perColumn.push({
      position: i + 1,
      value,
      percentile,
      typicalLow: col.p10,
      typicalHigh: col.p90,
      outOfRange,
    })
  })

  // Plausibility: share of columns landing inside their own typical (p10–p90) band
  const inBand = perColumn.filter((c) => c.value >= c.typicalLow && c.value <= c.typicalHigh).length
  return {
    perColumn,
    logLik: perColumn.length ? logLik / perColumn.length : 0,
    plausibility: perColumn.length ? inBand / perColumn.length : 0,
    impossibleColumns,
  }
}
