import type {
  Draw, DowProfile, FollowerEntry, HotColdEntry, OverdueEntry, PairEntry,
  PositionProfile, StreakEntry, TrendEntry,
} from './types.ts'
import { HistoryState } from './state.ts'

export function hotCold(state: HistoryState): { hot: HotColdEntry[]; cold: HotColdEntry[] } {
  const w = Math.min(state.n, 20)
  const entries: HotColdEntry[] = []
  for (let i = 1; i <= state.K; i++) {
    const p = state.rate(i, 10)
    const expected = w * p
    const sd = Math.sqrt(Math.max(1e-9, w * p * (1 - p)))
    entries.push({ number: i, count20: state.w20[i], expected20: expected, z: w > 0 ? (state.w20[i] - expected) / sd : 0 })
  }
  const byZ = [...entries].sort((a, b) => b.z - a.z)
  return { hot: byZ.slice(0, 8), cold: byZ.slice(-8).reverse() }
}

export function overdueList(state: HistoryState): OverdueEntry[] {
  const out: OverdueEntry[] = []
  for (let i = 1; i <= state.K; i++) {
    if (state.counts[i] < 2) continue
    const meanGap = state.meanGap(i)
    const since = state.drawsSince(i)
    out.push({ number: i, drawsSinceSeen: since, meanGap, ratio: since / Math.max(1, meanGap) })
  }
  return out.sort((a, b) => b.ratio - a.ratio).slice(0, 8)
}

export function topPairs(state: HistoryState, limit = 15): PairEntry[] {
  const S = state.K + 1
  const n = Math.max(1, state.n)
  const corr = ((state.D - 1) * state.K) / (state.D * (state.K - 1))
  const out: PairEntry[] = []
  for (let a = 1; a <= state.K; a++)
    for (let b = a + 1; b <= state.K; b++) {
      const c = state.pairCounts[a * S + b]
      if (c < 2) continue
      const expected = n * (state.counts[a] / n) * (state.counts[b] / n) * corr
      out.push({ a, b, count: c, expected, lift: (c + 0.5) / (expected + 0.5) })
    }
  return out.sort((p, q) => q.count - p.count || q.lift - p.lift).slice(0, limit)
}

export function topFollowers(state: HistoryState, limit = 12): FollowerEntry[] {
  const S = state.K + 1
  const out: FollowerEntry[] = []
  /*
   * This scan tries every (from → to) pair — about K² hypotheses — so the bar
   * has to price the search in or the table fills with its own extremes: with a
   * lift cutoff of 1.15 a provably fair generator returned the full twelve rows
   * on every one of twenty runs, lifts up to 2.87, all noise by construction.
   * A binomial z of 4 against the flat rate expects ~0.15 false rows across all
   * 4,761 tests, so anything shown genuinely cleared the noise, and an empty
   * table is the honest usual answer.
   */
  const base = state.D / state.K
  for (let j = 1; j <= state.K; j++) {
    const opp = state.transOpp[j]
    if (opp < 6) continue
    for (let i = 1; i <= state.K; i++) {
      const c = state.trans[j * S + i]
      if (c < 4) continue
      const rate = c / opp
      const z = (rate - base) / Math.sqrt((base * (1 - base)) / opp)
      if (z < 4) continue
      out.push({ from: j, to: i, count: c, opportunities: opp, rate, lift: rate / base })
    }
  }
  return out.sort((a, b) => b.lift * Math.log(1 + b.count) - a.lift * Math.log(1 + a.count)).slice(0, limit)
}

/**
 * Does the weekday actually change which numbers come up? For each draw day,
 * compare every number's count on that day against the flat expectation with a
 * chi-square goodness-of-fit test. `z` puts the statistic on a standard scale:
 * |z| under 2 is ordinary variation, above 3 is a genuine anomaly worth a look.
 */
export function weekdaySignificance(
  state: HistoryState,
  scheduleDows: number[],
): { dow: number; draws: number; chi2: number; dof: number; z: number }[] {
  const S = state.K + 1
  const out: { dow: number; draws: number; chi2: number; dof: number; z: number }[] = []
  for (const dow of scheduleDows) {
    const nDraws = state.drawsByDow[dow]
    if (nDraws < 20) continue
    const expected = (nDraws * state.D) / state.K
    if (expected < 1) continue
    let chi2 = 0
    for (let i = 1; i <= state.K; i++) {
      const obs = state.countsByDow[dow * S + i]
      chi2 += ((obs - expected) ** 2) / expected
    }
    /*
     * Each draw contributes D numbers without replacement, so the K counts are
     * negatively correlated and the raw statistic averages K−D, not K−1 — on
     * fair data the unscaled z sat at mean −0.30, sd 0.95 instead of 0/1.
     * Rescaling by (K−1)/(K−D) restores the chi²_{K−1} law exactly (measured:
     * mean z 0.04, sd 1.01, tails at their nominal rates).
     */
    const dof = state.K - 1
    const adj = chi2 * ((state.K - 1) / Math.max(1, state.K - state.D))
    out.push({ dow, draws: nDraws, chi2: adj, dof, z: (adj - dof) / Math.sqrt(2 * dof) })
  }
  return out
}

export function dowProfiles(state: HistoryState, scheduleDows: number[]): DowProfile[] {
  const S = state.K + 1
  return scheduleDows.map((dow) => {
    const draws = state.drawsByDow[dow]
    const rows: DowProfile['top'] = []
    for (let i = 1; i <= state.K; i++) {
      const c = state.countsByDow[dow * S + i]
      if (c === 0) continue
      const rate = c / Math.max(1, draws)
      const overall = state.n ? state.counts[i] / state.n : 0
      rows.push({ number: i, count: c, rate, lift: overall > 0 ? rate / overall : 0 })
    }
    rows.sort((a, b) => b.count - a.count || b.lift - a.lift)
    return { dow, draws, top: rows.slice(0, 6) }
  })
}

export function trends(state: HistoryState): { rising: TrendEntry[]; falling: TrendEntry[] } {
  const w10 = Math.max(1, Math.min(state.n, 10))
  const w50 = Math.max(1, Math.min(state.n, 50))
  const list: TrendEntry[] = []
  for (let i = 1; i <= state.K; i++) {
    const r10 = state.w10[i] / w10
    const r50 = state.w50[i] / w50
    list.push({ number: i, rate10: r10, rate50: r50, momentum: r10 - r50 })
  }
  const sorted = [...list].sort((a, b) => b.momentum - a.momentum)
  return {
    rising: sorted.slice(0, 6).filter((t) => t.momentum > 0),
    falling: sorted.slice(-6).reverse().filter((t) => t.momentum < 0),
  }
}

export function currentStreaks(state: HistoryState): StreakEntry[] {
  const out: StreakEntry[] = []
  for (let i = 1; i <= state.K; i++) {
    if (state.streak[i] >= 2) out.push({ number: i, streak: state.streak[i] })
  }
  return out.sort((a, b) => b.streak - a.streak).slice(0, 8)
}

export function positionProfiles(state: HistoryState): PositionProfile[] {
  const S = state.K + 1
  const out: PositionProfile[] = []
  for (let p = 0; p < state.D; p++) {
    const hist: number[] = []
    let total = 0
    for (let i = 1; i <= state.K; i++) {
      const c = state.posCounts[p * S + i]
      hist.push(c)
      total += c
    }
    if (total === 0) continue
    const q = (frac: number): number => {
      let acc = 0
      const target = frac * total
      for (let i = 0; i < hist.length; i++) {
        acc += hist[i]
        if (acc >= target) return i + 1
      }
      return state.K
    }
    let min = 1, max = state.K
    for (let i = 0; i < hist.length; i++) if (hist[i] > 0) { min = i + 1; break }
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i] > 0) { max = i + 1; break }
    out.push({ position: p + 1, min, p25: q(0.25), median: q(0.5), p75: q(0.75), max, histogram: hist })
  }
  return out
}

export function windowCounts(draws: Draw[], K: number, window: number): { number: number; count: number }[] {
  const counts = new Uint32Array(K + 1)
  const slice = draws.slice(-window)
  for (const d of slice) for (const i of d.sorted) if (i <= K) counts[i]++
  const out: { number: number; count: number }[] = []
  for (let i = 1; i <= K; i++) out.push({ number: i, count: counts[i] })
  return out
}
