import type { Draw } from './types.ts'
import { choose } from './odds.ts'
import { bonferroniZ, normalCdf, normalQuantile, poolVsRandom } from './stats.ts'

/**
 * The top of the sorted draw — the 4th and 5th numbers — where the reduction
 * ideas people reach for first live: "the last ball is nearly always above
 * 40", "the top two sit close together", "the top ball stays near last
 * draw's". Each is tested here the only way that settles it.
 *
 * Every share is exact, not sampled: the number of D-sets whose two largest
 * members are a < b is C(a−1, D−2), because the other D−2 must come from below
 * a. So "how much of the space does this keep" has no Monte Carlo error, and
 * the one remaining question — does it keep winners at a higher rate than it
 * keeps combinations — is a clean binomial test against an equally sized
 * random pool.
 *
 * Each restriction is re-fitted before every draw from earlier draws only,
 * with its coverage fixed in advance (not tuned), and judged on that draw.
 */

export interface PeriodResult { from: string; to: string; n: number; held: number; share: number; z: number }

export interface RestrictionResult {
  key: string
  label: string
  how: string
  n: number
  held: number
  missed: number
  /** Mean exact share of the space it kept, over the same draws */
  share: number
  survival: number
  ciLo: number
  ciHi: number
  /** What an equally sized random pool would have held */
  expected: number
  z: number
  /** As fitted on every draw so far: the restriction you would apply next */
  today: { before: number; after: number; eliminated: number; rule: string }
  /** Three consecutive, non-overlapping stretches of the record */
  periods: PeriodResult[]
  verdict: 'predictive' | 'chance' | 'worse'
}

export interface TailStudy {
  K: number
  D: number
  n: number
  from: string
  to: string
  restrictions: RestrictionResult[]
  /** Bonferroni bar over the restrictions */
  zNeeded: number
  /** Does the joint (4th, 5th) histogram match the exact theory? */
  joint: { chi2: number; df: number; z: number; text: string }
  /** Correlation between the 4th and 5th numbers, against its exact value */
  correlation: { observed: number; theory: number; z: number }
}

const WARMUP = 120

interface Restriction {
  key: string
  label: string
  how: string
  /** Fit on past draws and return a membership test with its exact share */
  fit: (past: Draw[], prev: Draw | null) => { keeps: (s: number[]) => boolean; share: number; rule: string }
}

/** Exact joint pmf of the two largest of D drawn from 1..K: T[a][b] for a < b. */
export function jointTheory(K: number, D: number): Float64Array {
  const U = choose(K, D)
  const T = new Float64Array((K + 1) * (K + 1))
  for (let a = D - 1; a <= K - 1; a++) {
    const c = choose(a - 1, D - 2) / U
    for (let b = a + 1; b <= K; b++) T[a * (K + 1) + b] = c
  }
  return T
}

/** Exact share of combinations whose largest member lies in [lo, hi]. */
export function topShare(K: number, D: number, lo: number, hi: number): number {
  let s = 0
  for (let b = Math.max(D, lo); b <= Math.min(K, hi); b++) s += choose(b - 1, D - 1)
  return s / choose(K, D)
}

const quantile = (sorted: number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]

function restrictions(K: number, D: number, T: Float64Array): Restriction[] {
  const W = K + 1
  return [
    {
      key: 'topBand', label: `${D}th number inside its usual band`,
      how: 'The middle 95% of every earlier draw\'s largest number.',
      fit: (past) => {
        const v = past.map((d) => d.sorted[D - 1]).sort((a, b) => a - b)
        const lo = quantile(v, 0.025)
        const hi = quantile(v, 0.975)
        return { keeps: (s) => s[D - 1] >= lo && s[D - 1] <= hi, share: topShare(K, D, lo, hi), rule: `${D}th number ${lo}–${hi}` }
      },
    },
    {
      key: 'jointCore', label: `${D - 1}th and ${D}th together, in their usual region`,
      how: `The (${D - 1}th, ${D}th) cells that held 90% of earlier draws, smoothed towards the exact theory so an unseen cell is never ruled out on absence alone.`,
      fit: (past) => {
        const m = 50
        const counts = new Map<number, number>()
        for (const d of past) {
          const k = d.sorted[D - 2] * W + d.sorted[D - 1]
          counts.set(k, (counts.get(k) ?? 0) + 1)
        }
        const cells: { k: number; p: number }[] = []
        for (let a = D - 1; a < K; a++) {
          for (let b = a + 1; b <= K; b++) {
            const k = a * W + b
            cells.push({ k, p: ((counts.get(k) ?? 0) + m * T[k]) / (past.length + m) })
          }
        }
        cells.sort((x, y) => y.p - x.p || x.k - y.k)
        const keep = new Set<number>()
        let mass = 0, share = 0
        for (const c of cells) {
          if (mass >= 0.9) break
          keep.add(c.k); mass += c.p; share += T[c.k]
        }
        return { keeps: (s) => keep.has(s[D - 2] * W + s[D - 1]), share, rule: `${keep.size} of ${cells.length} (${D - 1}th, ${D}th) cells` }
      },
    },
    {
      key: 'topGap', label: `${D - 1}th and ${D}th close together`,
      how: `Gap between the two largest numbers no wider than 90% of earlier gaps.`,
      fit: (past) => {
        const g = quantile(past.map((d) => d.sorted[D - 1] - d.sorted[D - 2]).sort((a, b) => a - b), 0.9)
        let share = 0
        for (let a = D - 1; a < K; a++) for (let b = a + 1; b <= Math.min(K, a + g); b++) share += T[a * W + b]
        return { keeps: (s) => s[D - 1] - s[D - 2] <= g, share, rule: `gap ≤ ${g}` }
      },
    },
    {
      key: 'topFollows', label: `${D}th number near the previous draw's`,
      how: `Within the distance that covered 80% of earlier draw-to-draw moves of the largest number.`,
      fit: (past, prev) => {
        if (!prev) return { keeps: () => true, share: 1, rule: 'no previous draw' }
        const moves: number[] = []
        for (let i = 1; i < past.length; i++) moves.push(Math.abs(past[i].sorted[D - 1] - past[i - 1].sorted[D - 1]))
        const w = quantile(moves.sort((a, b) => a - b), 0.8)
        const c = prev.sorted[D - 1]
        return { keeps: (s) => Math.abs(s[D - 1] - c) <= w, share: topShare(K, D, c - w, c + w), rule: `${D}th number ${Math.max(D, c - w)}–${Math.min(K, c + w)}` }
      },
    },
  ]
}

/**
 * Run the study on one era's draws (one main-number pool throughout).
 */
export function studyTopPositions(draws: Draw[], K: number, D: number): TailStudy | null {
  if (D < 2 || draws.length < WARMUP + 60) return null
  const T = jointTheory(K, D)
  const specs = restrictions(K, D, T)
  const universe = choose(K, D)
  // A verdict can go either way — keeps more winners than its share, or fewer
  // — so the family is every restriction in both directions.
  const zNeeded = bonferroniZ(2 * specs.length)
  const n = draws.length - WARMUP

  const results: RestrictionResult[] = specs.map((r) => {
    const keptAt = new Uint8Array(n)
    const shareAt = new Float64Array(n)
    for (let t = WARMUP; t < draws.length; t++) {
      const fit = r.fit(draws.slice(0, t), draws[t - 1])
      keptAt[t - WARMUP] = fit.keeps(draws[t].sorted) ? 1 : 0
      shareAt[t - WARMUP] = fit.share
    }
    let held = 0, shareSum = 0
    for (let i = 0; i < n; i++) { held += keptAt[i]; shareSum += shareAt[i] }
    const share = shareSum / n
    const test = poolVsRandom(held, n, share)
    const periods: PeriodResult[] = [0, 1, 2].map((k) => {
      const a = Math.floor((k * n) / 3)
      const b = Math.floor(((k + 1) * n) / 3)
      let h = 0, s = 0
      for (let i = a; i < b; i++) { h += keptAt[i]; s += shareAt[i] }
      return { from: draws[WARMUP + a].date, to: draws[WARMUP + b - 1].date, n: b - a, held: h, share: s / Math.max(1, b - a), z: poolVsRandom(h, b - a, s / Math.max(1, b - a)).z }
    })
    const now = r.fit(draws, draws[draws.length - 1])
    return {
      key: r.key, label: r.label, how: r.how,
      n, held, missed: n - held, share, survival: held / n,
      ciLo: test.ciLo, ciHi: test.ciHi, expected: test.expected, z: test.z,
      today: { before: universe, after: Math.round(universe * now.share), eliminated: 1 - now.share, rule: now.rule },
      periods,
      verdict: test.z >= zNeeded ? 'predictive' : test.z <= -zNeeded ? 'worse' : 'chance',
    }
  })

  // The joint histogram against theory, in a 6×6 grid of equal theoretical
  // marginal mass, so every cell expects a usable count.
  const W = K + 1
  const margin = (pos: 0 | 1) => {
    const m = new Float64Array(W)
    for (let a = D - 1; a < K; a++) for (let b = a + 1; b <= K; b++) m[pos ? b : a] += T[a * W + b]
    const edges: number[] = []
    let c = 0
    for (let v = 1; v <= K; v++) { c += m[v]; if (edges.length < 5 && c >= (edges.length + 1) / 6) edges.push(v) }
    return (v: number) => { let i = 0; while (i < edges.length && v > edges[i]) i++; return i }
  }
  const bin4 = margin(0), bin5 = margin(1)
  const expected = new Float64Array(36)
  for (let a = D - 1; a < K; a++) for (let b = a + 1; b <= K; b++) expected[bin4(a) * 6 + bin5(b)] += T[a * W + b] * draws.length
  const observed = new Float64Array(36)
  for (const d of draws) observed[bin4(d.sorted[D - 2]) * 6 + bin5(d.sorted[D - 1])]++
  let chi2 = 0, cells = 0
  for (let i = 0; i < 36; i++) {
    if (expected[i] < 1) continue
    chi2 += (observed[i] - expected[i]) ** 2 / expected[i]
    cells++
  }
  const df = Math.max(1, cells - 1)
  // Wilson–Hilferty: chi-square to an approximate standard normal
  const jz = ((chi2 / df) ** (1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df))
  const p = 1 - normalCdf(jz)
  const joint = {
    chi2, df, z: jz,
    text: jz >= normalQuantile(0.95)
      ? `The ${D - 1}th and ${D}th numbers fall unevenly against the exact theory (χ² ${chi2.toFixed(1)} on ${df} df, p ${p.toFixed(3)}) — worth watching, but one test among many.`
      : `The ${D - 1}th and ${D}th numbers land where the exact theory says they should (χ² ${chi2.toFixed(1)} on ${df} df, p ${p.toFixed(2)}).`,
  }

  // Correlation of the two largest numbers, against its exact value
  let e4 = 0, e5 = 0, e44 = 0, e55 = 0, e45 = 0
  for (let a = D - 1; a < K; a++) {
    for (let b = a + 1; b <= K; b++) {
      const q = T[a * W + b]
      e4 += q * a; e5 += q * b; e44 += q * a * a; e55 += q * b * b; e45 += q * a * b
    }
  }
  const rho = (e45 - e4 * e5) / Math.sqrt((e44 - e4 * e4) * (e55 - e5 * e5))
  let s4 = 0, s5 = 0, s44 = 0, s55 = 0, s45 = 0
  for (const d of draws) {
    const a = d.sorted[D - 2], b = d.sorted[D - 1]
    s4 += a; s5 += b; s44 += a * a; s55 += b * b; s45 += a * b
  }
  const N = draws.length
  const r = (s45 / N - (s4 / N) * (s5 / N)) / Math.sqrt((s44 / N - (s4 / N) ** 2) * (s55 / N - (s5 / N) ** 2))
  const correlation = { observed: r, theory: rho, z: (r - rho) / ((1 - rho * rho) / Math.sqrt(N - 1)) }

  return {
    K, D, n, from: draws[WARMUP].date, to: draws[draws.length - 1].date,
    restrictions: results, zNeeded, joint, correlation,
  }
}
