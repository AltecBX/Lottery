import type { ComboPrediction, NumberPrediction } from './types.ts'
import { HistoryState } from './state.ts'

function pairLogLift(state: HistoryState, a: number, b: number): number {
  const S = state.K + 1
  const lo = Math.min(a, b), hi = Math.max(a, b)
  const pc = state.pairCounts[lo * S + hi]
  const n = Math.max(1, state.n)
  const pa = state.counts[a] / n
  const pb = state.counts[b] / n
  const corr = (4 * state.K) / (5 * (state.K - 1)) // without-replacement correction
  const expected = n * pa * pb * corr
  return Math.log((pc + 0.75) / (expected + 0.75))
}

/**
 * Build ranked 5-number combinations from the strongest candidates.
 * Combo score = member ensemble scores + pair-affinity bonus + shape plausibility
 * (sum and odd/even balance relative to what history actually produces).
 */
export function buildCombos(
  state: HistoryState,
  predictions: NumberPrediction[],
  maxCombos = 8,
): { best: ComboPrediction | null; alts: ComboPrediction[] } {
  if (state.K < 5 || predictions.length < 5) return { best: null, alts: [] }
  const cand = predictions.slice(0, Math.min(12, predictions.length))
  const scoreOf = new Map(cand.map((p) => [p.number, p.score]))
  const probOf = new Map(cand.map((p) => [p.number, p.probability]))
  const nums = cand.map((p) => p.number)

  const sumMean = state.sumMean()
  const sumSd = Math.max(1, state.sumSd())
  const n = Math.max(1, state.n)
  let oddModeP = 0
  for (let o = 0; o <= 5; o++) oddModeP = Math.max(oddModeP, (state.oddHist[o] + 1) / (n + 6))

  interface Scored { numbers: number[]; score: number; pairAvg: number; sumZ: number; oddBonus: number }
  const combos: Scored[] = []
  const c = nums.length
  for (let a = 0; a < c - 4; a++)
    for (let b = a + 1; b < c - 3; b++)
      for (let x = b + 1; x < c - 2; x++)
        for (let y = x + 1; y < c - 1; y++)
          for (let z = y + 1; z < c; z++) {
            const set = [nums[a], nums[b], nums[x], nums[y], nums[z]]
            let base = 0
            for (const v of set) base += scoreOf.get(v) ?? 0
            let pairSum = 0
            for (let i = 0; i < 5; i++)
              for (let j = i + 1; j < 5; j++) pairSum += pairLogLift(state, set[i], set[j])
            const pairAvg = pairSum / 10
            const total = set.reduce((s, v) => s + v, 0)
            const sumZ = (total - sumMean) / sumSd
            const odd = set.filter((v) => v % 2 === 1).length
            const oddP = (state.oddHist[odd] + 1) / (n + 6)
            const oddBonus = Math.log(oddP / oddModeP) // <= 0
            const score = base + 0.3 * pairAvg - 0.06 * sumZ * sumZ + 0.25 * oddBonus
            combos.push({ numbers: set.sort((p, q) => p - q), score, pairAvg, sumZ, oddBonus })
          }

  combos.sort((p, q) => q.score - p.score)
  const top = combos.slice(0, maxCombos)
  const best = top[0]

  const toPrediction = (cb: Scored): ComboPrediction => {
    const S = state.K + 1
    let bestPair: { a: number; b: number; count: number } | null = null
    for (let i = 0; i < 5; i++)
      for (let j = i + 1; j < 5; j++) {
        const a = cb.numbers[i], b = cb.numbers[j]
        const count = state.pairCounts[a * S + b]
        if (!bestPair || count > bestPair.count) bestPair = { a, b, count }
      }
    const notes: string[] = []
    const inTop5 = cb.numbers.filter((v) => predictions.slice(0, 5).some((p) => p.number === v)).length
    notes.push(`${inTop5} of 5 from the top-5 ranking`)
    if (bestPair && bestPair.count >= 3) notes.push(`pair ${bestPair.a}·${bestPair.b} drawn together ${bestPair.count}×`)
    const total = cb.numbers.reduce((s, v) => s + v, 0)
    notes.push(`sum ${total} (typical ${Math.round(sumMean)}±${Math.round(sumSd)})`)
    const odd = cb.numbers.filter((v) => v % 2 === 1).length
    notes.push(`${odd} odd · ${5 - odd} even`)
    return {
      numbers: cb.numbers,
      score: cb.score,
      relative: Math.round(100 * Math.exp(0.9 * (cb.score - best.score))),
      avgProbability: cb.numbers.reduce((s, v) => s + (probOf.get(v) ?? 0), 0) / 5,
      pairLift: Math.exp(cb.pairAvg),
      sumZ: cb.sumZ,
      notes,
    }
  }

  const list = top.map(toPrediction)
  return { best: list[0] ?? null, alts: list.slice(1) }
}
