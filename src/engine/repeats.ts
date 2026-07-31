import type { Draw } from './types.ts'
import { popcount } from './state.ts'
import { choose } from './odds.ts'

export interface RepeatPair {
  dateA: string
  dateB: string
  shared: number[]
}

export interface RepeatAnalysis {
  totalDraws: number
  drawSize: number
  /** C(K, D) — every possible main-number combination */
  possibleCombos: number
  /** Birthday-problem expectation: C(n,2) / C(K,D) full repeats expected by pure chance */
  expectedRepeats: number
  /** Full main-combination repeats actually observed (2+ occurrences of one set) */
  exactRepeats: { numbers: number[]; dates: string[] }[]
  /** Highest overlap observed between any two different draws (D = a full repeat) */
  maxOverlap: number
  /** The closest recurrences: pairs of draws sharing maxOverlap numbers (up to 4 kept) */
  closestPairs: RepeatPair[]
  /** pairsByOverlap[k] = number of draw pairs sharing exactly k main numbers (k >= 3 kept) */
  pairsByOverlap: number[]
  /** Expected pair counts by chance for the same overlap levels (hypergeometric) */
  expectedByOverlap: number[]
}

/**
 * Scan the whole history for repeated and near-repeated winning combinations.
 * Exact repeats use a hash of the sorted numbers; near-repeats compare every
 * pair of draws via bitmask popcount (O(n²) with ~5 words per draw — fine for
 * any realistic lottery history).
 */
export function analyzeRepeats(draws: Draw[], K: number, D: number): RepeatAnalysis {
  const n = draws.length
  const possible = choose(K, D)
  const pairsTotal = (n * (n - 1)) / 2

  // Exact repeats
  const byKey = new Map<string, number[]>()
  draws.forEach((d, i) => {
    const key = d.sorted.join('-')
    const list = byKey.get(key)
    if (list) list.push(i)
    else byKey.set(key, [i])
  })
  const exactRepeats: { numbers: number[]; dates: string[] }[] = []
  for (const idxs of byKey.values()) {
    if (idxs.length >= 2) {
      exactRepeats.push({ numbers: [...draws[idxs[0]].sorted], dates: idxs.map((i) => draws[i].date) })
    }
  }
  exactRepeats.sort((a, b) => b.dates.length - a.dates.length)

  // Pairwise overlaps via bitmasks
  const words = Math.ceil((K + 1) / 32)
  const masks: Uint32Array[] = draws.map((d) => {
    const m = new Uint32Array(words)
    for (const v of d.sorted) if (v <= K) m[v >> 5] |= 1 << (v & 31)
    return m
  })
  const pairsByOverlap = new Array<number>(D + 1).fill(0)
  let maxOverlap = 0
  let closestPairs: RepeatPair[] = []
  for (let a = 0; a < n; a++) {
    const ma = masks[a]
    for (let b = a + 1; b < n; b++) {
      const mb = masks[b]
      let o = 0
      for (let w = 0; w < words; w++) o += popcount(ma[w] & mb[w])
      pairsByOverlap[o]++
      if (o > maxOverlap) {
        maxOverlap = o
        closestPairs = []
      }
      if (o === maxOverlap && closestPairs.length < 4 && o > 0) {
        const shared: number[] = []
        for (const v of draws[a].sorted) if (draws[b].sorted.includes(v)) shared.push(v)
        closestPairs.push({ dateA: draws[a].date, dateB: draws[b].date, shared })
      }
    }
  }

  // Chance expectation for each overlap level: hypergeometric pmf × total pairs
  const expectedByOverlap = new Array<number>(D + 1).fill(0)
  for (let k = 0; k <= D; k++) {
    const p = (choose(D, k) * choose(K - D, D - k)) / possible
    expectedByOverlap[k] = pairsTotal * p
  }

  return {
    totalDraws: n,
    drawSize: D,
    possibleCombos: possible,
    expectedRepeats: possible > 0 ? pairsTotal / possible : 0,
    exactRepeats,
    maxOverlap,
    closestPairs,
    pairsByOverlap,
    expectedByOverlap,
  }
}
