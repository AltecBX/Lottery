/**
 * The few pieces of inference the research side of the app relies on, kept in
 * one place so every "is this real?" answer is computed the same way.
 */

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf; |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2)
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y)
}

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/**
 * The z a result must reach, one-sided, for `tests` simultaneous looks at
 * family-wise error `alpha` (Bonferroni). Searching 74 rules and reporting the
 * best at z = 2 is not a 2.3% event on a fair machine — some rule clears 2 most
 * of the time — so the bar has to rise with the number of things tried.
 */
export function bonferroniZ(tests: number, alpha = 0.05): number {
  return normalQuantile(1 - alpha / Math.max(1, tests))
}

/** One-sided p-value for z. */
export const pUpper = (z: number): number => 1 - normalCdf(z)

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(hits: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 }
  const p = hits / n
  const den = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) }
}

/**
 * Does a pool hold winners better than an equally sized random pool would?
 *
 * A random pool keeping a share p of the combinations holds any given winner
 * with probability exactly p, so over n draws it holds Binomial(n, p). The
 * share itself is measured on a Monte Carlo sample of S combinations, and that
 * error does not average away across draws — the same sample prices every
 * step — so it is added once rather than ignored.
 */
export function poolVsRandom(held: number, n: number, share: number, sampleSize = Infinity): {
  expected: number; sd: number; z: number; ciLo: number; ciHi: number
} {
  const p = Math.min(1 - 1e-9, Math.max(1e-9, share))
  const varBinom = n * p * (1 - p)
  const varMc = Number.isFinite(sampleSize) ? (n * n * p * (1 - p)) / sampleSize : 0
  const sd = Math.sqrt(varBinom + varMc)
  const ci = wilsonInterval(held, n)
  return { expected: n * p, sd, z: sd > 0 ? (held - n * p) / sd : 0, ciLo: ci.lo, ciHi: ci.hi }
}
