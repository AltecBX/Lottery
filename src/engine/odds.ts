/** n choose k as a float (exact for lottery-scale values). */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return Math.round(r)
}

/**
 * Probability that a fixed set of `picked` numbers overlaps the `drawn`-size
 * winning set in exactly `m` places, over a pool of K numbers (hypergeometric).
 */
export function hypergeomPmf(K: number, drawn: number, picked: number, m: number): number {
  const denom = choose(K, drawn)
  if (denom === 0) return 0
  return (choose(picked, m) * choose(K - picked, drawn - m)) / denom
}

/** Distribution of hit counts 0..min(picked, drawn) as an array. */
export function hitDistribution(K: number, drawn: number, picked: number): number[] {
  const maxM = Math.min(picked, drawn)
  const out: number[] = []
  for (let m = 0; m <= maxM; m++) out.push(hypergeomPmf(K, drawn, picked, m))
  return out
}

/** 1-in-N odds of matching exactly m of the drawn numbers with a drawn-size ticket. */
export function matchOdds(K: number, drawn: number, m: number): number {
  const p = hypergeomPmf(K, drawn, drawn, m)
  return p > 0 ? 1 / p : Infinity
}

/** 1-in-N odds of the jackpot (all mains, times the bonus pool when present). */
export function jackpotOdds(K: number, drawn: number, specialK: number): number {
  const mains = choose(K, drawn)
  return specialK > 0 ? mains * specialK : mains
}

export function formatOdds(oneIn: number): string {
  if (!Number.isFinite(oneIn)) return '—'
  if (oneIn >= 1e6) return `1 in ${(oneIn / 1e6).toFixed(oneIn >= 1e7 ? 0 : 1)} million`
  return `1 in ${Math.round(oneIn).toLocaleString()}`
}
