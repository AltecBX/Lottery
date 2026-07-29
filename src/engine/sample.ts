import type { Draw } from './types.ts'
import { dowOf, isoKey } from './dates.ts'

/** Deterministic PRNG so the sample dataset is identical on every load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const POOL = 56
const FOLLOWERS: Record<number, number> = { 7: 21, 13: 28, 45: 46, 3: 33, 22: 11 }
const SAT_BOOST = new Set([5, 10, 15, 40, 52])

/**
 * Synthetic Mon/Wed/Sat game with deliberate, discoverable structure:
 * uneven base weights, a Saturday bias, elevated repeat odds and a few
 * follower relationships — so the engine has real patterns to find and the
 * backtest has something to verify.
 */
export function generateSampleDraws(): Draw[] {
  const rand = mulberry32(0xc0ffee)
  const base: number[] = []
  for (let i = 1; i <= POOL; i++) {
    // Smooth uneven weights: some numbers genuinely run 30-40% hotter
    const wave = 1 + 0.32 * Math.sin(i * 1.7) + 0.22 * Math.cos(i * 0.53)
    base[i] = Math.max(0.35, wave)
  }

  const draws: Draw[] = []
  let prev: number[] = []
  // Mon/Wed/Sat from Jan 2022 through late Jul 2026
  let cursor = '2022-01-03'
  const end = '2026-07-27'
  const schedule = new Set([1, 3, 6])

  while (cursor <= end) {
    const dow = dowOf(cursor)
    if (schedule.has(dow)) {
      const weights: number[] = []
      for (let i = 1; i <= POOL; i++) {
        let w = base[i]
        if (dow === 6 && SAT_BOOST.has(i)) w *= 1.45
        if (prev.includes(i)) w *= 1.55
        weights[i] = w
      }
      for (const p of prev) {
        const f = FOLLOWERS[p]
        if (f) weights[f] *= 1.9
      }
      const picked: number[] = []
      const avail = Array.from({ length: POOL }, (_, k) => k + 1)
      for (let pick = 0; pick < 5; pick++) {
        let total = 0
        for (const i of avail) total += weights[i]
        let r = rand() * total
        let chosen = avail[avail.length - 1]
        for (const i of avail) {
          r -= weights[i]
          if (r <= 0) { chosen = i; break }
        }
        picked.push(chosen)
        avail.splice(avail.indexOf(chosen), 1)
      }
      picked.sort((a, b) => a - b)
      draws.push({ date: cursor, dow, numbers: [...picked], sorted: [...picked] })
      prev = picked
    }
    const [y, m, d] = cursor.split('-').map(Number)
    const nd = new Date(y, m - 1, d + 1)
    cursor = isoKey(nd.getFullYear(), nd.getMonth() + 1, nd.getDate())
  }
  return draws
}
