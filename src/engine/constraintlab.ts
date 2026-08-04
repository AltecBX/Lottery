import type { Draw } from './types.ts'
import {
  ConstraintState, contextAt, EMPTY_CONTEXT, extractFeatures, featureSpecs,
  positionIntervalProbability, universeSize, wilson,
  type DrawContext, type FeatureSpec, type RuleTier,
} from './constraints.ts'
import { detectEra } from './era.ts'

/** Coverage ladder: each candidate rule is a feature at one of these tail sizes. */
export const ALPHAS = [0.0005, 0.002, 0.01, 0.03]

/** Draws needed before a rule may be derived at all. */
export const MIN_CONSTRAINT_HISTORY = 120

/** How many random combinations the space-share estimate is measured over. */
export const SAMPLE_SIZE = 8000

export interface ConstraintRule {
  id: string
  featureKey: string
  label: string
  group: FeatureSpec['group']
  alpha: number
  /** Accepted range as derived from the whole history (what the UI shows) */
  lo: number
  hi: number
  hardMin: number
  hardMax: number
  observedMin: number
  observedMax: number
  tier: RuleTier
  /** Share of all combinations this rule alone admits (Monte Carlo) */
  spaceShare: number
  /** Share of unseen winners that satisfied it in walk-forward testing */
  survival: number
  survivalLo: number
  survivalHi: number
  evaluated: number
  /**
   * Standard errors by which survival exceeds space share. A fair draw puts
   * these equal, so this is the whole question: positive and large means the
   * rule keeps winners better than it keeps candidates.
   */
  edgeZ: number
  recent50: number
  recent100: number
  recent250: number
  /** First-half vs second-half survival, for drift */
  stability: number
  /** Survival over the first half alone — depends only on the earliest draws */
  firstHalfSurvival: number
  byDow: { dow: number; draws: number; survival: number }[]
  byEra: { label: string; draws: number; survival: number }[]
  /** Exact arithmetic probability, where the feature has one */
  theoryProbability: number | null
  /** Context-free and removes enough space to be worth combining */
  usable: boolean
  /**
   * Survival exceeds space share by enough to be real. A fair draw makes these
   * equal, so this is the only honest claim of an edge — and it is rare.
   */
  provenEdge: boolean
  note: string
}

export interface FunnelStep {
  ruleId: string
  label: string
  /** Space remaining after this rule and all before it */
  spaceShare: number
  /** Winner survival after this rule and all before it */
  survival: number
  /** Extra share of the universe this rule removed on top of the previous ones */
  removed: number
}

export interface ConstraintMode {
  key: 'conservative' | 'balanced' | 'aggressive'
  label: string
  /** Walk-forward winner survival this mode refuses to go below */
  target: number
  ruleIds: string[]
  spaceShare: number
  survival: number
  survivalLo: number
  combinationsBefore: number
  combinationsAfter: number
  /** Winners the selection would have thrown away, with their dates */
  eliminated: { date: string; numbers: number[]; failed: string[] }[]
  funnel: FunnelStep[]
  /** survival − spaceShare in standard errors, over the draws used to select */
  edgeZ: number
  /**
   * Survival on the later half of the record, which the greedy never saw.
   * The in-sample figure is selection-biased by construction — the optimiser
   * picked whichever rules happened to spare the most winners — so this is the
   * number that says whether the selection generalises.
   */
  holdoutSurvival: number
  holdoutDraws: number
  holdoutEdgeZ: number
}

export interface ConstraintLab {
  K: number
  drawSize: number
  universe: number
  evaluated: number
  /**
   * Set when the stored history reaches back into a retired number pool and the
   * lab ignored that part. Ranges are statements about a machine; one fitted
   * across a pool change describes a machine that no longer exists.
   */
  eraTrim: { cutoffDate: string; excluded: number; kept: number; earlyMax: number; currentMax: number } | null
  /**
   * Per sorted position: what the arithmetic allows, where the middle half of
   * draws land, and the near-total range. Derived from the same era-scoped
   * history as everything else here.
   */
  positionBands: {
    position: number
    hardMin: number
    hardMax: number
    /** Central band covering `coverage` of observed draws */
    lo: number
    hi: number
    coverage: number
    /** Interquartile band and median */
    p25: number
    p75: number
    median: number
  }[]
  /** Every candidate rule, best first */
  rules: ConstraintRule[]
  modes: ConstraintMode[]
  /** Points for the reduction-versus-survival chart, including the fair diagonal */
  pareto: { spaceShare: number; survival: number; rules: number }[]
  /** Monte Carlo sample size behind every space-share figure */
  sampleSize: number
  /**
   * The headline finding: does anything here beat the fair-lottery identity
   * that survival must equal space share?
   */
  verdict: string
}

/* ────────────────────────────── sampling ────────────────────────────── */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A uniform sample of the combination universe, measured once.
 *
 * Space share is estimated from this rather than counted exactly: counting the
 * combinations satisfying a conjunction of sum, gap, zone and positional
 * constraints has no closed form, and enumerating 11 million of them per rule
 * set would stall the worker. 40,000 draws from the uniform distribution give
 * every share a Wilson interval well under a percentage point, which is finer
 * than any decision here needs.
 */
export interface UniverseSample {
  size: number
  /** Context-independent feature values, [featureIndex][combo] */
  values: Float64Array[]
  /** Cumulative counts per feature for O(1) interval membership */
  cum: Float64Array[]
  offset: Int32Array
  /** Membership bitmask per combo, for overlap counts against a recent-draw set */
  masks: Uint32Array
  words: number
  combos: number[][]
}

/**
 * A uniform sample of the combination universe, measured once.
 *
 * Space share is estimated rather than counted: the number of combinations
 * satisfying a conjunction of sum, gap, zone and positional constraints has no
 * closed form, and enumerating eleven million per rule set per draw would stall
 * the worker for minutes.
 *
 * Context-independent features get a cumulative histogram so asking "how many
 * of the sample fall in [lo,hi]" is two array reads rather than a scan — which
 * matters because that question is asked once per rule per draw.
 */
export function sampleUniverse(
  K: number, D: number, n: number, specs: FeatureSpec[], seed = 0xC0FFEE,
): UniverseSample {
  const rnd = mulberry32(seed)
  const pool = new Int32Array(K)
  for (let i = 0; i < K; i++) pool[i] = i + 1
  const nFeat = specs.length
  const values = specs.map(() => new Float64Array(n))
  const words = Math.ceil((K + 1) / 32)
  const masks = new Uint32Array(n * words)
  const combos: number[][] = []
  const buf = new Float64Array(nFeat)

  for (let s = 0; s < n; s++) {
    for (let i = 0; i < D; i++) {
      const j = i + Math.floor(rnd() * (K - i))
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t
    }
    const combo = Array.from(pool.slice(0, D)).sort((a, b) => a - b)
    combos.push(combo)
    // EMPTY_CONTEXT leaves the conditional slots NaN; they are recomputed per
    // draw against that draw's own context, which is the whole point.
    extractFeatures(combo, K, EMPTY_CONTEXT, buf)
    for (let f = 0; f < nFeat; f++) values[f][s] = buf[f]
    for (const v of combo) masks[s * words + (v >>> 5)] |= 1 << (v & 31)
  }

  const offset = new Int32Array(nFeat)
  const cum = specs.map((spec, f) => {
    const lo = Math.floor(spec.hardMin)
    offset[f] = -lo
    const size = Math.ceil(spec.hardMax) - lo + 2
    const hist = new Float64Array(size)
    for (let s = 0; s < n; s++) {
      const v = values[f][s]
      if (!Number.isFinite(v)) continue
      const b = Math.round(v) + offset[f]
      if (b >= 0 && b < size) hist[b]++
    }
    const c = new Float64Array(size + 1)
    for (let b = 0; b < size; b++) c[b + 1] = c[b] + hist[b]
    return c
  })

  return { size: n, values, cum, offset, masks, words, combos }
}

/** How many sampled combinations fall inside [lo, hi] for one feature. */
function countIn(sample: UniverseSample, f: number, lo: number, hi: number): number {
  const c = sample.cum[f]
  const off = sample.offset[f]
  const a = Math.max(0, Math.min(c.length - 1, Math.round(lo) + off))
  const b = Math.max(0, Math.min(c.length - 1, Math.round(hi) + off + 1))
  return b <= a ? 0 : c[b] - c[a]
}

const popcount = (x: number): number => {
  x -= (x >>> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >>> 24
}

/* ────────────────────────────── the engine ────────────────────────────── */

const passes = (v: number, lo: number, hi: number): boolean => !Number.isFinite(v) || (v >= lo && v <= hi)

/**
 * Rebuild every candidate rule from scratch at every draw, using only draws
 * that came before it, and record whether the real winner survived.
 *
 * This is the only measurement that means anything. A constraint fitted to the
 * whole history will of course contain the whole history; the question is
 * whether a constraint fitted to the past contains the future.
 */
export function analyzeConstraints(allDraws: Draw[], poolMax: number, D: number): ConstraintLab | null {
  // A range is a statement about a machine. Powerball's mains went 59 → 69 in
  // October 2015 and Mega Millions' went 75 → 70 in 2017, so "the 5th number
  // stays under 60" fitted across that boundary describes a machine that no
  // longer exists — and scored against a 69-ball sample it reads as a colossal
  // edge that can never repeat. Whatever the rest of the app is set to analyse,
  // the lab works inside one rule era and says which draws it left out.
  const eraInfo = detectEra(allDraws)
  const draws = eraInfo ? allDraws.slice(eraInfo.cutoffIndex) : allDraws
  // Only correct the pool when the retired era is what inflated it; a pool that
  // grew leaves today's maximum as the real one, and a manual override stands.
  const K = eraInfo && eraInfo.earlyMax > eraInfo.currentMax ? eraInfo.currentMax : poolMax
  const eraTrim = eraInfo
    ? {
        cutoffDate: eraInfo.cutoffDate,
        excluded: eraInfo.excluded,
        kept: eraInfo.kept,
        earlyMax: eraInfo.earlyMax,
        currentMax: eraInfo.currentMax,
      }
    : null

  const specs = featureSpecs(K, D)
  const nFeat = specs.length
  const nRules = nFeat * ALPHAS.length
  const universe = universeSize(K, D)
  if (draws.length < MIN_CONSTRAINT_HISTORY + 40) return null

  const idxOf = new Map(specs.map((sp, i) => [sp.key, i]))
  const iSum = idxOf.get('sum')!
  const iSpread = idxOf.get('spread')!
  const iOdd = idxOf.get('odd')!
  // Conditional features are a shift of a context-free one, or an overlap count
  const shifted: Record<string, number> = { dSum: iSum, dSpread: iSpread, dOdd: iOdd }

  const sample = sampleUniverse(K, D, SAMPLE_SIZE, specs)
  const state = new ConstraintState(K, D)
  const evaluatedIdx: number[] = []
  const passMatrix = new Uint8Array(draws.length * nRules)
  // Every rule's interval as it stood at each draw, kept so that space share can
  // be re-measured against the same rule survival was tested with.
  const stepIv: StepIntervals = {
    lo: new Float64Array((draws.length - MIN_CONSTRAINT_HISTORY) * nRules),
    hi: new Float64Array((draws.length - MIN_CONSTRAINT_HISTORY) * nRules),
    featOfRule: new Int32Array(nRules),
  }
  for (let fi = 0; fi < nFeat; fi++) {
    for (let a = 0; a < ALPHAS.length; a++) stepIv.featOfRule[fi * ALPHAS.length + a] = fi
  }
  // Space share is accumulated per draw against that draw's own context, so it
  // is averaged over exactly the same contexts as survival. Measuring it at a
  // single context instead makes conditional rules look predictive when they
  // are only being compared against the wrong baseline.
  const spaceAcc = new Float64Array(nRules)
  const scratch = ALPHAS.map(() => ({ lo: 0, hi: 0 }))
  const featBuf = new Float64Array(nFeat)
  const words = sample.words
  const ctxMask = new Uint32Array(words * 3)
  const overlapHist = [new Float64Array(D + 2), new Float64Array(D + 2), new Float64Array(D + 2)]

  for (let i = 0; i < MIN_CONSTRAINT_HISTORY; i++) {
    state.push(extractFeatures(draws[i].sorted, K, contextAt(draws, i), featBuf), draws[i].dow)
  }

  for (let i = MIN_CONSTRAINT_HISTORY; i < draws.length; i++) {
    const step = evaluatedIdx.length
    const ctx = contextAt(draws, i)
    const f = extractFeatures(draws[i].sorted, K, ctx)

    // Recent-draw membership as bitmasks, so an overlap count is a popcount
    ctxMask.fill(0)
    if (ctx.prev) {
      for (const v of ctx.prev) ctxMask[(v >>> 5)] |= 1 << (v & 31)
      for (const v of ctx.last3) ctxMask[words + (v >>> 5)] |= 1 << (v & 31)
      for (const v of ctx.last10) ctxMask[2 * words + (v >>> 5)] |= 1 << (v & 31)
      for (let h = 0; h < 3; h++) overlapHist[h].fill(0)
      for (let sIdx = 0; sIdx < sample.size; sIdx++) {
        const base = sIdx * words
        for (let h = 0; h < 3; h++) {
          let c = 0
          for (let w = 0; w < words; w++) c += popcount(sample.masks[base + w] & ctxMask[h * words + w])
          overlapHist[h][c]++
        }
      }
    }

    for (let fi = 0; fi < nFeat; fi++) {
      state.intervalsFor(fi, ALPHAS, scratch)
      const key = specs[fi].key
      const shiftBase = shifted[key]
      const overlapIdx = key === 'repeatPrev' ? 0 : key === 'overlap3' ? 1 : key === 'overlap10' ? 2 : -1
      for (let a = 0; a < ALPHAS.length; a++) {
        const { lo, hi } = scratch[a]
        const r = fi * ALPHAS.length + a
        passMatrix[step * nRules + r] = passes(f[fi], lo, hi) ? 1 : 0
        stepIv.lo[step * nRules + r] = lo
        stepIv.hi[step * nRules + r] = hi

        let share: number
        if (shiftBase !== undefined) {
          if (!ctx.prev) share = 1
          else {
            const base = shiftBase === iSum ? ctx.prevSum : shiftBase === iSpread ? ctx.prevSpread : ctx.prevOdd
            share = countIn(sample, shiftBase, lo + base, hi + base) / sample.size
          }
        } else if (overlapIdx >= 0) {
          if (!ctx.prev) share = 1
          else {
            let c = 0
            for (let v = Math.max(0, Math.ceil(lo)); v <= Math.min(D, Math.floor(hi)); v++) c += overlapHist[overlapIdx][v]
            share = c / sample.size
          }
        } else {
          share = countIn(sample, fi, lo, hi) / sample.size
        }
        spaceAcc[r] += share
      }
    }
    evaluatedIdx.push(i)
    state.push(f, draws[i].dow)
  }

  const evaluated = evaluatedIdx.length
  if (evaluated < 40) return null

  const era = detectEra(draws)
  const eraSplit = era ? era.cutoffIndex : -1

  const finalIv: { lo: number; hi: number }[][] = []
  for (let fi = 0; fi < nFeat; fi++) {
    const row = ALPHAS.map(() => ({ lo: 0, hi: 0 }))
    state.intervalsFor(fi, ALPHAS, row)
    finalIv.push(row)
  }

  const ruleSurvivors: (Uint8Array | null)[] = []
  const rules: ConstraintRule[] = []

  for (let fi = 0; fi < nFeat; fi++) {
    const spec = specs[fi]
    const obs = state.observedRange(fi)
    const contextFree = !spec.conditional
    for (let a = 0; a < ALPHAS.length; a++) {
      const r = fi * ALPHAS.length + a
      const { lo, hi } = finalIv[fi][a]

      let hits = 0, recent50 = 0, recent100 = 0, recent250 = 0
      const dowHit = new Array(7).fill(0)
      const dowN = new Array(7).fill(0)
      let eraOldHit = 0, eraOldN = 0, eraNewHit = 0, eraNewN = 0
      let firstHalf = 0, firstN = 0, secondHalf = 0, secondN = 0
      for (let step = 0; step < evaluated; step++) {
        const ok = passMatrix[step * nRules + r]
        hits += ok
        const fromEnd = evaluated - step
        if (fromEnd <= 50) recent50 += ok
        if (fromEnd <= 100) recent100 += ok
        if (fromEnd <= 250) recent250 += ok
        const di = evaluatedIdx[step]
        const dow = draws[di].dow
        dowN[dow]++; dowHit[dow] += ok
        if (eraSplit >= 0) {
          if (di < eraSplit) { eraOldN++; eraOldHit += ok } else { eraNewN++; eraNewHit += ok }
        }
        if (step < evaluated / 2) { firstN++; firstHalf += ok } else { secondN++; secondHalf += ok }
      }

      // Only context-free rules can be combined: their membership is the same
      // whatever the previous draw was, so a joint estimate stays valid.
      let keep: Uint8Array | null = null
      if (contextFree) {
        keep = new Uint8Array(sample.size)
        for (let sIdx = 0; sIdx < sample.size; sIdx++) {
          keep[sIdx] = passes(sample.values[fi][sIdx], lo, hi) ? 1 : 0
        }
      }
      ruleSurvivors.push(keep)

      const spaceShare = spaceAcc[r] / evaluated
      const survival = hits / evaluated
      const ci = wilson(hits, evaluated)
      const se = Math.sqrt(Math.max(1e-12, (spaceShare * (1 - spaceShare)) / evaluated))
      const edgeZ = (survival - spaceShare) / se
      const theory = spec.group === 'position' ? positionIntervalProbability(K, D, fi + 1, lo, hi) : null
      const removes = 1 - spaceShare

      const provenEdge = edgeZ >= 2
      let tier: RuleTier
      let usable = contextFree
      let note = ''
      if (lo <= spec.hardMin && hi >= spec.hardMax) {
        tier = 'typical'; usable = false
        note = 'Accepts everything the arithmetic allows — nothing to remove.'
      } else if (removes < 0.001) {
        tier = 'typical'; usable = false
        note = 'Removes almost none of the space; not worth a rule.'
      } else if (spaceShare < 0.02) {
        tier = 'ultra-rare'
        note = `Keeps ${(spaceShare * 100).toFixed(2)}% of the arithmetic space.`
      } else if (provenEdge) {
        tier = 'historically-rare'
        note = `Retains winners ${edgeZ.toFixed(1)}σ above its own space share — a real edge.`
      } else {
        // Removing candidates and winners at the same rate is exactly what a
        // fair machine produces. The rule still reduces the space; it just does
        // not do so for free, and must never be sold as an edge.
        tier = 'unsupported'
        note = `Removes ${(removes * 100).toFixed(1)}% of candidates and ${((1 - survival) * 100).toFixed(1)}% of winners — matched, so it costs what it saves.`
      }
      if (Number.isNaN(obs.min)) {
        tier = 'typical'; usable = false; note = 'No observations behind this feature yet.'
      }
      if (!contextFree) {
        note += ' Depends on the previous draw, so it is measured but not combined.'
      }

      rules.push({
        id: `${spec.key}@${ALPHAS[a]}`,
        featureKey: spec.key,
        label: spec.label,
        group: spec.group,
        alpha: ALPHAS[a],
        lo, hi,
        hardMin: spec.hardMin, hardMax: spec.hardMax,
        observedMin: obs.min, observedMax: obs.max,
        tier, spaceShare, survival,
        survivalLo: ci.lo, survivalHi: ci.hi,
        evaluated, edgeZ,
        recent50: recent50 / Math.min(50, evaluated),
        recent100: recent100 / Math.min(100, evaluated),
        recent250: recent250 / Math.min(250, evaluated),
        stability: (secondN ? secondHalf / secondN : 0) - (firstN ? firstHalf / firstN : 0),
        firstHalfSurvival: firstN ? firstHalf / firstN : 0,
        byDow: dowN.map((n, dow) => ({ dow, draws: n, survival: n ? dowHit[dow] / n : 0 })).filter((d) => d.draws > 0),
        byEra: eraSplit >= 0
          ? [
              { label: 'Earlier rules', draws: eraOldN, survival: eraOldN ? eraOldHit / eraOldN : 0 },
              { label: 'Current rules', draws: eraNewN, survival: eraNewN ? eraNewHit / eraNewN : 0 },
            ]
          : [],
        theoryProbability: theory,
        usable, provenEdge, note,
      })
    }
  }

  const modes = buildModes(rules, ruleSurvivors, passMatrix, nRules, evaluated, evaluatedIdx, draws, sample, stepIv, universe)
  const pareto = buildPareto(rules, ruleSurvivors, passMatrix, nRules, evaluated, sample, stepIv)

  // Positions occupy the first D feature slots, in order.
  const bandAlpha = ALPHAS[1]
  const positionBands = Array.from({ length: D }, (_, fi) => {
    const wide = state.interval(fi, bandAlpha)
    const mid = state.interval(fi, 0.25)
    const med = state.interval(fi, 0.5)
    return {
      position: fi + 1,
      hardMin: specs[fi].hardMin,
      hardMax: specs[fi].hardMax,
      lo: wide.lo, hi: wide.hi, coverage: 1 - 2 * bandAlpha,
      p25: mid.lo, p75: mid.hi, median: med.lo,
    }
  })

  const usableRules = rules.filter((r) => r.usable)
  const best = [...usableRules].sort((a, b) => b.edgeZ - a.edgeZ)[0]
  // Reporting the strongest rule's z-score without saying whether it cleared the
  // bar reads as a finding whichever way it fell. Below 2σ it is noise, and the
  // verdict has to say so in the same breath as the number.
  const verdict = !best
    ? 'No constraint retained winners better than it retained candidates. Every shape filter removed winners at the rate it removed the space — which is precisely what a fair machine produces, and means none of them reduce the search space for free.'
    : best.provenEdge
      ? `Strongest rule keeps winners ${best.edgeZ.toFixed(1)} standard errors above its own space share (${best.label}, ${(best.spaceShare * 100).toFixed(1)}% of the space kept, ${(best.survival * 100).toFixed(2)}% of unseen winners kept).`
      : `Nothing beat the fair line. The strongest of ${usableRules.length} usable rules (${best.label}) reached only ${best.edgeZ.toFixed(1)}σ above its own space share, which is inside what a fair machine produces by chance — so every one of them removes winners at the rate it removes candidates.`

  rules.sort((a, b) => Number(b.usable) - Number(a.usable) || b.edgeZ - a.edgeZ)

  return {
    K, drawSize: D, universe, evaluated, eraTrim, positionBands,
    rules, modes, pareto, sampleSize: sample.size, verdict,
  }
}

/** Each rule's accepted interval as it stood at every evaluated draw. */
interface StepIntervals {
  lo: Float64Array
  hi: Float64Array
  featOfRule: Int32Array
}

/**
 * Space share measured at the same intervals the survival test used.
 *
 * Survival is walk-forward: at draw t the rule was whatever draws 1..t−1
 * implied, and early rules are tighter than the ones a full history produces.
 * Scoring that survival against the share of the space the FINAL interval keeps
 * compares two different rules — and the gap is not academic. On a full
 * Powerball history it flatters a selection by two percentage points, which is
 * the whole distance between "beats the fair line by 2σ" and "does not beat it
 * at all". So the space share is rebuilt per draw as well, and averaged over
 * the same draws survival was averaged over.
 *
 * Every prefix of `chosen` comes back from the one pass: the rules are applied
 * in order, so the survivor count after each is already in hand. Steps are
 * sampled at `stride` because consecutive intervals are near-identical — at
 * stride 3 the estimate moves by 0.006 of a percentage point.
 */
function matchedPrefixShares(
  chosen: number[],
  iv: StepIntervals,
  sample: UniverseSample,
  nRules: number,
  from: number,
  to: number,
  stride: number,
): { prefix: number[]; steps: number } {
  const n = sample.size
  const alive = new Uint8Array(n)
  const acc = new Float64Array(chosen.length)
  let steps = 0
  for (let step = from; step < to; step += stride) {
    alive.fill(1)
    for (let k = 0; k < chosen.length; k++) {
      const r = chosen[k]
      const vals = sample.values[iv.featOfRule[r]]
      const lo = iv.lo[step * nRules + r]
      const hi = iv.hi[step * nRules + r]
      let live = 0
      for (let s = 0; s < n; s++) {
        let a = alive[s]
        if (a && (vals[s] < lo || vals[s] > hi)) a = 0
        alive[s] = a
        live += a
      }
      acc[k] += live / n
    }
    steps++
  }
  return { prefix: Array.from(acc, (v) => (steps ? v / steps : 1)), steps }
}

/** Sample enough draws for the step-average to settle without paying for all of them. */
const strideFor = (evaluated: number): number => Math.max(1, Math.round(evaluated / 450))

/**
 * Joint survival for a selected set of rules, plus the final-interval space
 * share used only to rank candidates during the greedy search. Anything
 * reported to the reader is re-measured by `matchedPrefixShares`.
 */
function evaluateSet(
  ids: number[],
  ruleSurvivors: (Uint8Array | null)[],
  passMatrix: Uint8Array,
  nRules: number,
  evaluated: number,
  sampleSize: number,
  from = 0,
): { survival: number; spaceShare: number; failedSteps: number[]; n: number } {
  const failedSteps: number[] = []
  let hits = 0
  for (let step = from; step < evaluated; step++) {
    let ok = true
    for (const r of ids) {
      if (!passMatrix[step * nRules + r]) { ok = false; break }
    }
    if (ok) hits++
    else failedSteps.push(step)
  }
  let kept = 0
  for (let s = 0; s < sampleSize; s++) {
    let ok = true
    for (const r of ids) {
      const mask = ruleSurvivors[r]
      if (mask && !mask[s]) { ok = false; break }
    }
    if (ok) kept++
  }
  const n = evaluated - from
  return { survival: n > 0 ? hits / n : 1, spaceShare: kept / sampleSize, failedSteps, n }
}

/*
 * Winner-retention floors the optimiser works to.
 *
 * Deliberately not 99.9%: the identity caps reduction at whatever you decline
 * to retain, so a 99.9% floor permits removing 0.1% of the space — and with 634
 * held-out draws a single missed winner is already 0.16%, so the target sits
 * below the resolution of the record it is measured on. Every rule failed it
 * and the mode removed nothing. These floors are coarse enough for this much
 * history to express and still leave the ladder meaningful.
 */
const MODE_TARGETS: { key: ConstraintMode['key']; label: string; target: number }[] = [
  { key: 'conservative', label: 'Conservative', target: 0.99 },
  { key: 'balanced', label: 'Balanced', target: 0.97 },
  { key: 'aggressive', label: 'Aggressive', target: 0.94 },
]

/**
 * Greedily assemble the strongest selection that still clears a survival floor.
 *
 * Candidates are tried best-edge first, and one is kept only if the joint
 * walk-forward survival stays at or above the target after adding it. Rules
 * that failed their own edge test are never offered.
 */
function buildModes(
  rules: ConstraintRule[],
  ruleSurvivors: (Uint8Array | null)[],
  passMatrix: Uint8Array,
  nRules: number,
  evaluated: number,
  evaluatedIdx: number[],
  draws: Draw[],
  sample: UniverseSample,
  stepIv: StepIntervals,
  universe: number,
): ConstraintMode[] {
  const sampleSize = sample.size
  const stride = strideFor(evaluated)
  // Ranked by how much space each removes on its own; the greedy step below
  // decides what that costs in winners.
  const candidates = rules
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.usable)
    .sort((a, b) => a.r.spaceShare - b.r.spaceShare)
    .slice(0, 40)

  return MODE_TARGETS.map(({ key, label, target }) => {
    const chosen: number[] = []
    const funnel: FunnelStep[] = []
    // Select on the first half only; the second half stays unseen so the
    // selection can be judged rather than admired.
    const half = Math.floor(evaluated / 2)
    let current = { survival: 1, spaceShare: 1, failedSteps: [] as number[], n: half }
    const taken = new Set<number>()

    for (;;) {
      let bestIdx = -1
      let bestRes: ReturnType<typeof evaluateSet> | null = null
      let bestScore = 0
      for (const { i } of candidates) {
        if (taken.has(i)) continue
        const res = evaluateSet([...chosen, i], ruleSurvivors, passMatrix, nRules, half, sampleSize)
        if (res.survival < target) continue
        const gain = current.spaceShare - res.spaceShare
        if (gain <= 1e-6) continue
        // Space removed per winner surrendered — the only trade that matters
        const cost = Math.max(1e-4, current.survival - res.survival)
        const score = gain / cost
        if (score > bestScore) { bestScore = score; bestIdx = i; bestRes = res }
      }
      if (bestIdx < 0 || !bestRes) break
      chosen.push(bestIdx)
      taken.add(bestIdx)
      funnel.push({
        ruleId: rules[bestIdx].id,
        label: rules[bestIdx].label,
        spaceShare: bestRes.spaceShare,
        survival: bestRes.survival,
        removed: current.spaceShare - bestRes.spaceShare,
      })
      current = bestRes
    }

    const holdout = evaluateSet(chosen, ruleSurvivors, passMatrix, nRules, evaluated, sampleSize, half)
    const full = evaluateSet(chosen, ruleSurvivors, passMatrix, nRules, evaluated, sampleSize)

    // Re-measure the space against the walk-forward intervals, in-sample and
    // held-out separately, so each survival figure is compared with the share
    // its own rules were keeping at the time.
    const inS = matchedPrefixShares(chosen, stepIv, sample, nRules, 0, half, stride)
    const outS = matchedPrefixShares(chosen, stepIv, sample, nRules, half, evaluated, stride)
    const last = chosen.length - 1
    const inShare = chosen.length ? inS.prefix[last] : 1
    const outShare = chosen.length ? outS.prefix[last] : 1
    const totalSteps = Math.max(1, inS.steps + outS.steps)
    const prefixAll = chosen.map((_, k) => (inS.prefix[k] * inS.steps + outS.prefix[k] * outS.steps) / totalSteps)
    const spaceShare = chosen.length ? prefixAll[last] : 1
    for (let k = 0; k < funnel.length; k++) {
      funnel[k].spaceShare = prefixAll[k]
      funnel[k].removed = (k > 0 ? prefixAll[k - 1] : 1) - prefixAll[k]
    }

    const se = Math.sqrt(Math.max(1e-12, (inShare * (1 - inShare)) / Math.max(1, half)))
    const seOut = Math.sqrt(Math.max(1e-12, (outShare * (1 - outShare)) / Math.max(1, holdout.n)))
    const eliminated = full.failedSteps.slice(0, 25).map((step) => {
      const d = draws[evaluatedIdx[step]]
      const failed = chosen.filter((r) => !passMatrix[step * nRules + r]).map((r) => rules[r].label)
      return { date: d.date, numbers: d.sorted, failed }
    })

    return {
      key, label, target,
      ruleIds: chosen.map((i) => rules[i].id),
      spaceShare,
      survival: full.survival,
      survivalLo: wilson(Math.round(full.survival * evaluated), evaluated).lo,
      combinationsBefore: universe,
      combinationsAfter: Math.round(universe * spaceShare),
      eliminated, funnel,
      edgeZ: (current.survival - inShare) / se,
      holdoutSurvival: holdout.survival,
      holdoutDraws: holdout.n,
      holdoutEdgeZ: (holdout.survival - outShare) / seOut,
    }
  })
}

/**
 * The frontier: every prefix of the greedy ordering, so the chart can show
 * reduction against survival with the fair-lottery diagonal behind it.
 */
function buildPareto(
  rules: ConstraintRule[],
  ruleSurvivors: (Uint8Array | null)[],
  passMatrix: Uint8Array,
  nRules: number,
  evaluated: number,
  sample: UniverseSample,
  stepIv: StepIntervals,
): ConstraintLab['pareto'] {
  const order = rules
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.usable)
    .sort((a, b) => a.r.spaceShare - b.r.spaceShare)
    .slice(0, 12)

  const chosen = order.map(({ i }) => i)
  const points: ConstraintLab['pareto'] = [{ spaceShare: 1, survival: 1, rules: 0 }]
  if (!chosen.length) return points
  const shares = matchedPrefixShares(chosen, stepIv, sample, nRules, 0, evaluated, strideFor(evaluated))
  for (let k = 0; k < chosen.length; k++) {
    const res = evaluateSet(chosen.slice(0, k + 1), ruleSurvivors, passMatrix, nRules, evaluated, sample.size)
    points.push({ spaceShare: shares.prefix[k], survival: res.survival, rules: k + 1 })
  }
  return points
}

/* ─────────────────────── inspecting one combination ─────────────────────── */

export interface ComboVerdict {
  numbers: number[]
  passed: { id: string; label: string; value: number; lo: number; hi: number }[]
  failed: { id: string; label: string; value: number; lo: number; hi: number; tier: RuleTier }[]
  /** True when nothing in the active selection rejects it */
  survives: boolean
}

/** Run one combination through a mode's rule set and show every verdict. */
export function inspectCombination(
  lab: ConstraintLab,
  mode: ConstraintMode,
  combo: number[],
  ctx: DrawContext,
): ComboVerdict {
  const sorted = [...combo].sort((a, b) => a - b)
  const specs = featureSpecs(lab.K, lab.drawSize)
  const f = extractFeatures(sorted, lab.K, ctx)
  const byKey = new Map(specs.map((s, i) => [s.key, i]))
  const passed: ComboVerdict['passed'] = []
  const failed: ComboVerdict['failed'] = []

  for (const id of mode.ruleIds) {
    const rule = lab.rules.find((r) => r.id === id)
    if (!rule) continue
    const fi = byKey.get(rule.featureKey)
    if (fi === undefined) continue
    const value = f[fi]
    const entry = { id: rule.id, label: rule.label, value, lo: rule.lo, hi: rule.hi }
    if (passes(value, rule.lo, rule.hi)) passed.push(entry)
    else failed.push({ ...entry, tier: rule.tier })
  }
  return { numbers: sorted, passed, failed, survives: failed.length === 0 }
}
