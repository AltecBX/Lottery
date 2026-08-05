import type { ComboPrediction, NumberPrediction } from './types.ts'
import { HistoryState } from './state.ts'
import type { PositionAnalysis } from './positions.ts'

function pairLogLift(state: HistoryState, a: number, b: number): number {
  const S = state.K + 1
  const lo = Math.min(a, b), hi = Math.max(a, b)
  const pc = state.pairCounts[lo * S + hi]
  const n = Math.max(1, state.n)
  const pa = state.counts[a] / n
  const pb = state.counts[b] / n
  const D = state.D
  const corr = ((D - 1) * state.K) / (D * (state.K - 1)) // without-replacement correction
  const expected = n * pa * pb * corr
  return Math.log((pc + 0.75) / (expected + 0.75))
}

/** Visit every k-combination of indices 0..n-1. */
function forEachCombination(n: number, k: number, visit: (idx: number[]) => void): void {
  const idx = Array.from({ length: k }, (_, i) => i)
  if (k > n) return
  for (;;) {
    visit(idx)
    // advance
    let i = k - 1
    while (i >= 0 && idx[i] === n - k + i) i--
    if (i < 0) return
    idx[i]++
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1
  }
}

/**
 * Build ranked combinations from the strongest candidates.
 * Combo score = member ensemble scores + pair-affinity bonus + shape plausibility
 * (sum and odd/even balance relative to what history actually produces).
 */
export function buildCombos(
  state: HistoryState,
  predictions: NumberPrediction[],
  maxCombos = 8,
  positions: PositionAnalysis | null = null,
  accept: ((sorted: number[]) => boolean) | null = null,
): { best: ComboPrediction | null; alts: ComboPrediction[] } {
  const D = state.D
  if (state.K < D || predictions.length < D) return { best: null, alts: [] }
  const candCount = Math.min(D + 7, predictions.length) // C(12,5)=792, C(13,6)=1716
  const cand = predictions.slice(0, candCount)
  const scoreOf = new Map(cand.map((p) => [p.number, p.score]))
  const probOf = new Map(cand.map((p) => [p.number, p.probability]))
  const nums = cand.map((p) => p.number)

  const sumMean = state.sumMean()
  const sumSd = Math.max(1, state.sumSd())
  const n = Math.max(1, state.n)
  let oddModeP = 0
  for (let o = 0; o <= D; o++) oddModeP = Math.max(oddModeP, (state.oddHist[o] + 1) / (n + D + 1))

  /**
   * Penalize combinations whose sorted shape sits far outside what each column
   * of the history actually produces (e.g. a "lowest ball" of 55 in a game where
   * column 1 has never exceeded 51). Normal shapes are untouched — the term only
   * bites beyond 1.5 sd, so it breaks ties toward realistic draws.
   */
  const positionPenalty = (sortedSet: number[]): number => {
    if (!positions) return 0
    let acc = 0
    for (let i = 0; i < sortedSet.length; i++) {
      const col = positions.columns[i]
      if (!col || col.sd <= 0) continue
      const z = Math.abs(sortedSet[i] - col.mean) / col.sd
      if (z > 1.5) acc += (z - 1.5) ** 2
      if (sortedSet[i] < col.min || sortedSet[i] > col.max) acc += 4
    }
    return acc
  }

  interface Scored { numbers: number[]; score: number; pairAvg: number; sumZ: number; posPenalty: number; inPool: boolean }
  const combos: Scored[] = []
  const pairsPerCombo = (D * (D - 1)) / 2
  forEachCombination(nums.length, D, (idx) => {
    const set = idx.map((i) => nums[i])
    let base = 0
    for (const v of set) base += scoreOf.get(v) ?? 0
    let pairSum = 0
    for (let i = 0; i < D; i++)
      for (let j = i + 1; j < D; j++) pairSum += pairLogLift(state, set[i], set[j])
    const pairAvg = pairSum / pairsPerCombo
    const total = set.reduce((s, v) => s + v, 0)
    const sumZ = (total - sumMean) / sumSd
    const odd = set.filter((v) => v % 2 === 1).length
    const oddP = (state.oddHist[odd] + 1) / (n + D + 1)
    const oddBonus = Math.log(oddP / oddModeP) // <= 0
    const sortedSet = [...set].sort((p, q) => p - q)
    const posPenalty = positionPenalty(sortedSet)
    const score = base + 0.3 * pairAvg - 0.06 * sumZ * sumZ + 0.25 * oddBonus - 0.12 * posPenalty
    combos.push({ numbers: sortedSet, score, pairAvg, sumZ, posPenalty, inPool: accept ? accept(sortedSet) : true })
  })

  combos.sort((p, q) => q.score - p.score)
  // Generate from the reduced pool: combinations outside it are only used if
  // the candidate numbers cannot form enough inside it — the filter must never
  // be able to silence the prediction entirely.
  const inPool = combos.filter((c) => c.inPool)
  const top = inPool.length >= 1 ? inPool.slice(0, maxCombos) : combos.slice(0, maxCombos)
  if (top.length === 0) return { best: null, alts: [] }
  const best = top[0]

  const toPrediction = (cb: Scored): ComboPrediction => {
    const S = state.K + 1
    let bestPair: { a: number; b: number; count: number } | null = null
    for (let i = 0; i < D; i++)
      for (let j = i + 1; j < D; j++) {
        const a = cb.numbers[i], b = cb.numbers[j]
        const count = state.pairCounts[a * S + b]
        if (!bestPair || count > bestPair.count) bestPair = { a, b, count }
      }
    const notes: string[] = []
    const inTop = cb.numbers.filter((v) => predictions.slice(0, D).some((p) => p.number === v)).length
    notes.push(`${inTop} of ${D} from the top-${D} ranking`)
    if (bestPair && bestPair.count >= 3) notes.push(`pair ${bestPair.a}·${bestPair.b} drawn together ${bestPair.count}×`)
    const total = cb.numbers.reduce((s, v) => s + v, 0)
    notes.push(`sum ${total} (typical ${Math.round(sumMean)}±${Math.round(sumSd)})`)
    const odd = cb.numbers.filter((v) => v % 2 === 1).length
    notes.push(`${odd} odd · ${D - odd} even`)
    if (positions && cb.posPenalty < 0.5) notes.push('column shape typical')
    if (accept) notes.push(cb.inPool ? 'inside the reduced pool' : 'outside the reduced pool — best available')
    return {
      numbers: cb.numbers,
      score: cb.score,
      relative: Math.round(100 * Math.exp(0.9 * (cb.score - best.score))),
      avgProbability: cb.numbers.reduce((s, v) => s + (probOf.get(v) ?? 0), 0) / D,
      pairLift: Math.exp(cb.pairAvg),
      sumZ: cb.sumZ,
      notes,
    }
  }

  const list = top.map(toPrediction)
  return { best: list[0] ?? null, alts: list.slice(1) }
}
