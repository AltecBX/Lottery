import type { Draw } from './types.ts'
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

  // Pairwise overlaps via an inverted index: only pairs that actually share a
  // number are visited, so this is O(n·D·n·D/K) instead of O(n²·words).
  const postings: number[][] = Array.from({ length: K + 1 }, () => [])
  draws.forEach((d, i) => {
    for (const v of d.sorted) if (v >= 1 && v <= K) postings[v].push(i)
  })
  const pairsByOverlap = new Array<number>(D + 1).fill(0)
  const shareCount = new Int32Array(n)
  const touched = new Int32Array(n)
  let maxOverlap = 0
  let closestPairs: RepeatPair[] = []
  let pairsWithOverlap = 0
  for (let a = 0; a < n; a++) {
    let nTouched = 0
    for (const v of draws[a].sorted) {
      if (v < 1 || v > K) continue
      for (const b of postings[v]) {
        if (b <= a) continue
        if (shareCount[b] === 0) touched[nTouched++] = b
        shareCount[b]++
      }
    }
    for (let t = 0; t < nTouched; t++) {
      const b = touched[t]
      const o = shareCount[b]
      shareCount[b] = 0
      pairsByOverlap[o]++
      pairsWithOverlap++
      if (o > maxOverlap) { maxOverlap = o; closestPairs = [] }
      if (o === maxOverlap && closestPairs.length < 4) {
        const shared = draws[a].sorted.filter((v) => draws[b].sorted.includes(v))
        closestPairs.push({ dateA: draws[a].date, dateB: draws[b].date, shared })
      }
    }
  }
  // Pairs sharing nothing are the remainder — never enumerated, just counted.
  pairsByOverlap[0] = pairsTotal - pairsWithOverlap

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
