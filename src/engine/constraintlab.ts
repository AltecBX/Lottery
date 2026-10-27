import type { Draw } from './types.ts'
import {
  ConstraintState, contextAt, EMPTY_CONTEXT, extractFeatures, featureSpecs,
  positionIntervalProbability, universeSize, wilson,
  type DrawContext, type FeatureSpec, type RuleTier,
} from './constraints.ts'
import { detectEra } from './era.ts'
import { choose } from './odds.ts'
import { bonferroniZ, poolVsRandom } from './stats.ts'

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

/** One re-selection in the replay: rules chosen at `origin` from earlier draws, scored on the draws after. */
export interface ValidationFold {
  /** Date of the first draw this selection was scored on; it was chosen from draws before it */
  origin: string
  ruleIds: string[]
  draws: number
  held: number
  /** Space the selection kept, measured at the same intervals its survival was tested with */
  share: number
}

/**
 * How a mode's selection procedure did on draws it had not seen.
 *
 * The procedure — rank rules, greedily stack them to a survival floor — is
 * re-run every `REFIT_EVERY` draws using only the draws before that point, and
 * each selection is scored on the draws that follow until the next one. Every
 * verdict here therefore comes from a rule set chosen without the draw it is
 * judged on, and appending draws never changes an earlier verdict.
 */
export interface ModeValidation {
  folds: ValidationFold[]
  /** First draw scored; '' when the record is too short to score any */
  from: string
  draws: number
  held: number
  survival: number
  /** Matched space share over the same draws: what a random pool of this size would hold */
  share: number
  /** Standard errors by which `held` beats an equally sized random pool */
  z: number
  ciLo: number
  ciHi: number
  /** z the best of the modes must reach before any one of them counts (Bonferroni) */
  zNeeded: number
  verdict: 'edge' | 'worse' | 'noise' | 'insufficient'
  /**
   * Mean Jaccard distance between successive selections: 0 when every refit
   * chose the same rules, 1 when no two shared one.
   */
  turnover: number
  /** Every scored date the selection in force rejected the winner */
  failedDates: string[]
  /**
   * The draws after the method was frozen — the only ones no design decision in
   * this file has ever been tuned against. Everything earlier was in view while
   * the targets, alphas and features were chosen.
   */
  prospective: { since: string; draws: number; held: number; share: number; z: number }
}

export interface ConstraintMode {
  key: 'conservative' | 'balanced' | 'aggressive' | 'deep'
  label: string
  /** Walk-forward winner survival this mode refuses to go below on the draws it selects from */
  target: number
  /** The rules in force now, selected from every evaluated draw */
  ruleIds: string[]
  /** Space kept by those rules, matched to the intervals their survival was tested at */
  spaceShare: number
  /**
   * Share of the space the bands keep at today's intervals — the pool the app
   * actually deals from, and what `combinationsAfter` counts.
   */
  currentShare: number
  /** In-sample survival of today's selection: chosen on these same draws, so flattered */
  survival: number
  survivalLo: number
  combinationsBefore: number
  combinationsAfter: number
  /** Winners the selection would have thrown away, with their dates */
  eliminated: { date: string; numbers: number[]; failed: string[] }[]
  /** Every date today's selection rejects the winner, in-sample, uncapped */
  failedDates: string[]
  funnel: FunnelStep[]
  /** survival − spaceShare in standard errors, over the draws used to select — selection-biased */
  edgeZ: number
  /**
   * Out-of-sample survival from the replay (`validation`): each draw judged by
   * a selection made without it. The in-sample figure is selection-biased by
   * construction, so this is the number that says whether the method works.
   */
  holdoutSurvival: number
  holdoutDraws: number
  /** Matched space share over the held-out draws — the line `holdoutSurvival` has to beat */
  holdoutShare: number
  holdoutEdgeZ: number
  validation: ModeValidation
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
  /** Sorted-spreadsheet shapes priced exactly: combos, share, expected vs observed */
  presets: PresetElimination[]
  /**
   * Every family on the cut list, counted across the full record, and whether
   * the record still supports cutting it. Optional only so hand-built labs in
   * tests keep working; the engine always sets it.
   */
  cuts?: CutStatus[]
  /**
   * Tests of the machine rather than of any one rule. If combinations really do
   * come out uniformly, every family is priced fairly by necessity and no
   * further searching can turn one up — so this is the question that decides
   * whether the search is worth continuing.
   */
  fairness: { key: string; label: string; stat: string; z: number; verdict: string }[]
  /** Record totals in the era's own draws — the sum cut's boundaries */
  sumRecord: { min: number; max: number; minDate: string; maxDate: string } | null
  /**
   * Rules that look compelling on a sorted sheet and fail a walk-forward test.
   * Shown so a rejection is evidence rather than an opinion.
   */
  rejected: { label: string; broke: number; chances: number; rate: number; note: string }[]
  /** Every candidate rule, best first */
  rules: ConstraintRule[]
  modes: ConstraintMode[]
  /** Points for the reduction-versus-survival chart, including the fair diagonal */
  pareto: { spaceShare: number; survival: number; rules: number }[]
  /** Monte Carlo sample size behind every space-share figure */
  sampleSize: number
  /**
   * The bars every claim here was held to: how many rules and modes were looked
   * at, the z each needed, and the date the method stopped being tuned. Optional
   * only so hand-built labs in tests keep working.
   */
  significance?: { ruleTests: number; ruleZ: number; modeTests: number; modeZ: number; frozenOn: string }
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
export function analyzeConstraints(
  allDraws: Draw[], poolMax: number, D: number,
  opts: { eraStart?: string } = {},
): ConstraintLab | null {
  // A range is a statement about a machine. Powerball's mains went 59 → 69 in
  // October 2015 and Mega Millions' went 75 → 70 in 2017, so "the 5th number
  // stays under 60" fitted across that boundary describes a machine that no
  // longer exists — and scored against a 69-ball sample it reads as a colossal
  // edge that can never repeat. Whatever the rest of the app is set to analyse,
  // the lab works inside one rule era and says which draws it left out.
  //
  // For an official game the era comes from the published rule schedule
  // (`eraStart`), and it is the white-ball era: every feature here is a
  // property of the five main numbers, so a change to the bonus pool alone —
  // Mega Millions in 2025 — does not end it.
  const scheduled = opts.eraStart
    ? (() => {
        const idx = allDraws.findIndex((d) => d.date >= opts.eraStart!)
        if (idx <= 0) return null
        let earlyMax = 0
        for (let i = 0; i < idx; i++) for (const n of allDraws[i].sorted) earlyMax = Math.max(earlyMax, n)
        return { cutoffIndex: idx, cutoffDate: allDraws[idx].date, excluded: idx, kept: allDraws.length - idx, earlyMax, currentMax: poolMax }
      })()
    : null
  const eraInfo = opts.eraStart ? scheduled : detectEra(allDraws)
  const draws = eraInfo ? allDraws.slice(eraInfo.cutoffIndex) : allDraws
  // Only correct the pool when the retired era is what inflated it; a pool that
  // grew leaves today's maximum as the real one, and a manual override stands.
  const K = !opts.eraStart && eraInfo && eraInfo.earlyMax > eraInfo.currentMax ? eraInfo.currentMax : poolMax
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
  // The same sums as running totals, so a selection made at step s can rank
  // rules by the space they kept over steps 0..s−1 alone.
  const spaceCum = new Float64Array((draws.length - MIN_CONSTRAINT_HISTORY + 1) * nRules)
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
        spaceCum[(step + 1) * nRules + r] = spaceCum[step * nRules + r] + share
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
  /*
   * Every rule is tested, and the table is read for its best — so the bar for
   * calling one real is the one a family of `nRules` looks needs. At the old
   * fixed 2σ, a fair machine hands several of 136 rules an "edge" every run.
   */
  const ruleZNeeded = bonferroniZ(nRules)

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
      // The space share is itself an estimate from one Monte Carlo sample, and
      // that error is shared by every step, so it counts once in full.
      const edgeZ = poolVsRandom(hits, evaluated, spaceShare, sample.size).z
      const theory = spec.group === 'position' ? positionIntervalProbability(K, D, fi + 1, lo, hi) : null
      const removes = 1 - spaceShare

      const provenEdge = edgeZ >= ruleZNeeded
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
        note = `Retains winners ${edgeZ.toFixed(1)}σ above its own space share — past the ${ruleZNeeded.toFixed(1)}σ that ${nRules} rules tested at once require.`
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

  const finalLo = new Float64Array(nRules)
  const finalHi = new Float64Array(nRules)
  for (let fi = 0; fi < nFeat; fi++) {
    for (let a = 0; a < ALPHAS.length; a++) {
      finalLo[fi * ALPHAS.length + a] = finalIv[fi][a].lo
      finalHi[fi * ALPHAS.length + a] = finalIv[fi][a].hi
    }
  }
  const modes = buildModes({
    rules, specs, passMatrix, nRules, evaluated, evaluatedIdx, draws, sample, stepIv, spaceCum, finalLo, finalHi, universe,
  })
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

  const presets = presetEliminations(draws, K, D, universe, positionBands.map((b) => ({ lo: b.lo, hi: b.hi })))
  let sumRecord: ConstraintLab['sumRecord'] = null
  for (const d of draws) {
    const total = d.sorted.reduce((a, b) => a + b, 0)
    if (!sumRecord) {
      sumRecord = { min: total, max: total, minDate: d.date, maxDate: d.date }
    } else {
      if (total < sumRecord.min) { sumRecord.min = total; sumRecord.minDate = d.date }
      if (total > sumRecord.max) { sumRecord.max = total; sumRecord.maxDate = d.date }
    }
  }

  /*
   * Per-bonus-ball floors: "when the Powerball was 26 the total was never below
   * 62" and so on down the pool. It is a real reading of a sorted sheet and a
   * trap, because slicing the era's draws across the bonus pool leaves about
   * fifty per value — and the minimum of fifty samples is nowhere near the true
   * floor, so the next fifty routinely dive under it. Measured rather than
   * argued: the floor each bonus value had established is checked against the
   * next draw that used it.
   */
  /*
   * Rules that read well off a sorted sheet, each put through the same test:
   * build the rule from everything before a draw, then ask whether that draw
   * breaks it. A rule worth applying almost never gets broken.
   *
   * The slicing family is the instructive one. "The total was never below X
   * when the bonus ball was 26" splits the record across the bonus pool, and
   * the finer the slice, the fewer draws hold up each floor — so the floor sits
   * higher than the truth and the next draw walks under it. Running the same
   * test at three granularities shows the break rate tracking group size and
   * nothing else, which is what a sampling artefact looks like from the inside.
   */
  const rejected: ConstraintLab['rejected'] = []
  const totalOf = (d: Draw) => d.sorted.reduce((a, b) => a + b, 0)
  const sliceTest = (key: (d: Draw) => number | null) => {
    const floor = new Map<number, number>()
    let broke = 0
    let chances = 0
    for (const d of draws) {
      const k = key(d)
      if (k === null) continue
      const v = totalOf(d)
      const prev = floor.get(k)
      if (prev !== undefined) { chances++; if (v < prev) broke++ }
      floor.set(k, prev === undefined ? v : Math.min(prev, v))
    }
    return { broke, chances, groups: floor.size }
  }

  const pooled = sliceTest(() => 0)
  const sliceCandidates: { label: string; key: (d: Draw) => number | null }[] = [
    { label: 'A separate total floor for each bonus ball', key: (d) => d.special ?? null },
    { label: 'A separate total floor for each starting decade', key: (d) => Math.floor((d.sorted[0] - 1) / 10) },
    { label: 'A separate total floor for each odd/even split', key: (d) => d.sorted.filter((n) => n % 2).length },
    { label: 'A separate total floor for each draw weekday', key: (d) => d.dow },
  ]
  for (const c of sliceCandidates) {
    const r = sliceTest(c.key)
    if (r.chances < 100 || r.groups < 2) continue
    const rate = r.broke / r.chances
    const pooledRate = pooled.chances ? pooled.broke / pooled.chances : 0
    if (rate <= pooledRate * 1.5) continue
    const per = Math.round(draws.length / r.groups)
    rejected.push({
      label: c.label,
      broke: r.broke, chances: r.chances, rate,
      note: `Splitting the record ${r.groups} ways leaves about ${per} draws behind each floor, so each one is the lowest of a small sample rather than a real limit — and the next draw goes under it ${(rate * 100).toFixed(1)}% of the time. One pooled floor over the same draws breaks ${(pooledRate * 100).toFixed(1)}%, which is the cut the lab actually applies.`,
    })
  }
  rejected.sort((a, b) => b.rate - a.rate)

  const fairness = fairnessTests(draws, K, D, universe)

  const usableRules = rules.filter((r) => r.usable)
  const best = [...usableRules].sort((a, b) => b.edgeZ - a.edgeZ)[0]
  // Reporting the strongest rule's z-score without saying whether it cleared the
  // bar reads as a finding whichever way it fell. The bar is the one the whole
  // family of rules needs — the best of 136 fair coins clears 2σ most of the
  // time — and the verdict states it in the same breath as the number.
  const verdict = !best
    ? 'No constraint retained winners better than it retained candidates. Every shape filter removed winners at the rate it removed the space — which is precisely what a fair machine produces, and means none of them reduce the search space for free.'
    : best.provenEdge
      ? `Strongest rule keeps winners ${best.edgeZ.toFixed(1)} standard errors above its own space share (${best.label}, ${(best.spaceShare * 100).toFixed(1)}% of the space kept, ${(best.survival * 100).toFixed(2)}% of unseen winners kept) — past the ${ruleZNeeded.toFixed(1)}σ that ${nRules} rules tested at once require.`
      : `Nothing beat the fair line. The strongest of ${usableRules.length} usable rules (${best.label}) reached ${best.edgeZ.toFixed(1)}σ above its own space share; with ${nRules} rules tested at once, a real edge needs ${ruleZNeeded.toFixed(1)}σ, and the best of that many on a fair machine routinely lands where this one did — so every one of them removes winners at the rate it removes candidates.`

  rules.sort((a, b) => Number(b.usable) - Number(a.usable) || b.edgeZ - a.edgeZ)

  return {
    K, drawSize: D, universe, evaluated, eraTrim, positionBands, presets, sumRecord, rejected, fairness,
    cuts: cutStatus(allDraws, K, D),
    rules, modes, pareto, sampleSize: sample.size, verdict,
    significance: {
      ruleTests: nRules,
      ruleZ: ruleZNeeded,
      modeTests: MODE_TARGETS.length,
      modeZ: bonferroniZ(MODE_TARGETS.length),
      frozenOn: METHOD_FROZEN_ON,
    },
  }
}

/* ─────────────── the eliminations you can see by sorting ─────────────── */

export interface PresetElimination {
  key: string
  label: string
  /** Exact count of combinations with this shape */
  combos: number
  /** combos / universe */
  share: number
  /** What fairness predicts for this history: share × draws */
  expected: number
  /** How many draws in the era actually had the shape */
  observed: number
  note: string
}

/** Combinations whose r-th smallest number is ≤ v: at least r of the D inside 1..v. */
export function countRthAtMost(K: number, D: number, r: number, v: number): number {
  let total = 0
  for (let j = r; j <= D; j++) total += choose(v, j) * choose(K - v, D - j)
  return total
}

/** Combinations whose numbers all fit inside one window of `W` consecutive values. */
export function windowCount(K: number, D: number, W: number): number {
  // Count each set once by its minimum: the other D−1 numbers come from the
  // W−1 values above it (fewer near the top of the pool).
  let total = 0
  for (let m = 1; m <= K - 1; m++) total += choose(Math.min(W - 1, K - m), D - 1)
  return total
}

/**
 * Fixed structural families, each with an exact count and a membership test.
 *
 * Unlike a "never seen below X" threshold read off the history, these are
 * defined before the data is consulted, so they cannot be fitted to it — the
 * count is arithmetic and the only question is how often the family shows up.
 * On a full Powerball era every one of them lands on its expected count, which
 * is the fair-lottery identity turning up again in a different disguise.
 */
/**
 * Number sets small enough that picking the whole draw out of one of them is a
 * family in its own right.
 *
 * Every entry is a "all five come from this handful" shape. Both the exact
 * family count and the ledger's enumeration read from here, so a family can
 * never be priced one way and deducted another — the bug that would otherwise
 * be invisible, because each side looks right on its own.
 */
export function narrowGroups(K: number): { key: string; groups: number[][] }[] {
  const upTo = (f: (n: number) => boolean): number[] => {
    const r: number[] = []
    for (let n = 1; n <= K; n++) if (f(n)) r.push(n)
    return r
  }
  const out: { key: string; groups: number[][] }[] = []

  // All five multiples of one number, six or higher. Multiples of two, three
  // and four have all come up — 94 draws share a factor that small — so the
  // family starts where the history goes quiet.
  const multiples: number[][] = []
  for (let m = 6; m <= K; m++) multiples.push(upTo((n) => n % m === 0))
  out.push({ key: 'sameMultiple', groups: multiples })

  // One column of a narrow grid: all five leaving the same remainder. Seven and
  // eight wide are deliberately absent — both have been drawn.
  const cols: number[][] = []
  for (const m of NARROW_GRIDS) for (let r = 0; r < m; r++) cols.push(upTo((n) => n % m === r))
  out.push({ key: 'gridColumn', groups: cols })

  // The play slip is fourteen across, so after the row and the column the
  // diagonal is the last straight line left on it.
  const row = (n: number) => Math.floor((n - 1) / 14)
  const col = (n: number) => (n - 1) % 14
  const diag: number[][] = []
  for (let c = -14; c <= 14; c++) diag.push(upTo((n) => col(n) - row(n) === c))
  for (let c = 0; c <= 28; c++) diag.push(upTo((n) => col(n) + row(n) === c))
  out.push({ key: 'slipDiagonal', groups: diag })

  // The whole ticket written with only two digits: 12-21-22-11-12 and its kind.
  const pairs: number[][] = []
  for (let a = 0; a <= 9; a++) {
    for (let b = a + 1; b <= 9; b++) {
      pairs.push(upTo((n) => String(n).split('').every((c) => Number(c) === a || Number(c) === b)))
    }
  }
  out.push({ key: 'twoDigits', groups: pairs })

  out.push({ key: 'powerTwo', groups: [upTo((n) => (n & (n - 1)) === 0)] })
  out.push({ key: 'repdigit', groups: [upTo((n) => n >= 11 && new Set(String(n)).size === 1)] })
  return out
}

/** Grid widths where a full column has never been drawn — 7 and 8 both have. */
const NARROW_GRIDS = [9, 11, 12, 13]

/** How many distinct D-subsets a set of groups covers between them. */
function unionSubsets(groups: number[][], D: number): number {
  const seen = new Set<string>()
  for (const g of groups) for (const combo of kSubsets(g, D)) seen.add(combo.join('-'))
  return seen.size
}

/**
 * Widest even step that still gets cut.
 *
 * A progression stepping by 1..11 — 1-7-13-19-25, 5-10-15-20-25, 2-6-10-14-18 —
 * has never been drawn in the whole record. Neither has one stepping by 12..17,
 * except the one that has: 3-19-35-51-67, step sixteen, on 2026-04-29. So this
 * boundary is not a principle, it is where the single observed hit happens to
 * sit, and the honest consequence is that the parent family stays measured
 * rather than cut. Kept as one constant so the family test, the exact count and
 * the ledger's enumeration can never drift apart.
 */
export const MAX_CUT_STEP = 11

export function structuralFamilies(K: number, D: number): {
  key: string
  label: string
  combos: number
  test: (sorted: number[]) => boolean
  note: string
}[] {
  const prime = (n: number): boolean => {
    if (n < 2) return false
    for (let d = 2; d * d <= n; d++) if (n % d === 0) return false
    return true
  }
  const countWhere = (f: (n: number) => boolean): number => {
    let c = 0
    for (let n = 1; n <= K; n++) if (f(n)) c++
    return c
  }
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const narrow = new Map(narrowGroups(K).map((g) => [g.key, g.groups]))
  const narrowCount = (key: string): number => unionSubsets(narrow.get(key)!, D)
  const decadeOf = (n: number): number => Math.floor((n - 1) / 10)
  let oneDecade = 0
  for (let d = 0; d <= decadeOf(K); d++) oneDecade += choose(countWhere((n) => decadeOf(n) === d), D)
  let sameDigit = 0
  for (let g = 0; g <= 9; g++) sameDigit += choose(countWhere((n) => n % 10 === g), D)
  let spaced = 0
  for (let step = 1; step <= Math.floor((K - 1) / (D - 1)); step++) spaced += K - step * (D - 1)
  let tightSpaced = 0
  for (let step = 1; step <= MAX_CUT_STEP; step++) tightSpaced += Math.max(0, K - step * (D - 1))

  return [
    {
      key: 'oneDecade',
      label: 'All five inside one decade',
      combos: oneDecade,
      test: (s) => decadeOf(s[0]) === decadeOf(s[D - 1]),
      note: 'Cut by choice, not by evidence — 2-5-6-9-10 came up on 2003-02-22. Expected 1.19 across the record and seen once, so this removal has already cost one real winner.',
    },
    {
      key: 'mult5',
      label: 'All five multiples of five',
      combos: choose(countWhere((n) => n % 5 === 0), D),
      test: (s) => s.every((n) => n % 5 === 0),
      note: 'Cut by choice, not by evidence — 5-15-25-30-40 came up on 2009-10-14. The round-number ticket does get drawn, about once every thirty years.',
    },
    {
      key: 'sameDigit',
      label: 'All five sharing a last digit',
      combos: sameDigit,
      test: (s) => new Set(s.map((n) => n % 10)).size === 1,
      note: '7-17-27-37-47 and the nine other digit runs.',
    },
    {
      key: 'evenSpaced',
      label: 'Evenly spaced across the pool',
      combos: spaced,
      test: (s) => { const g = s[1] - s[0]; return s.every((n, i) => i === 0 || n - s[i - 1] === g) },
      note: 'Measured, never cut — the parent family, and it did come up: 3-19-35-51-67 on 2026-04-29.',
    },
    {
      key: 'evenStepTight',
      label: `Evenly spaced, steps of ${MAX_CUT_STEP} or less`,
      combos: tightSpaced,
      test: (s) => {
        const g = s[1] - s[0]
        return g <= MAX_CUT_STEP && s.every((n, i) => i === 0 || n - s[i - 1] === g)
      },
      note: `Every step from 1 to ${MAX_CUT_STEP} — 1-7-13-19-25, 5-10-15-20-25, 2-6-10-14-18 — and not one has ever been drawn. But the line sits at ${MAX_CUT_STEP} only because the one progression this machine did draw steps by sixteen, so the wider steps stay in. That boundary was read off the record rather than derived, which is why the parent family above stays measured and uncut beside it.`,
    },
    {
      // A Powerball slip is five columns of fourteen, so one slip row is a
      // horizontal line across the ticket — the smallest family in the game.
      // Wider than the touching-pairs family and not implied by it: 14-16-18-20-21
      // has one adjacent pair yet is every bit as clustered as 14-15-16-17-18.
      key: 'tightSpan',
      label: 'All five inside an eight-number span',
      combos: windowCount(K, D, 8),
      test: (s) => s[D - 1] - s[0] <= 7,
      note: 'Cut by choice, not by evidence — 44-45-47-50-51 came up on 2015-09-09, five numbers inside a span of eight. Expected 1.58 across the record, seen once.',
    },
    {
      // The one clustered shape with no precedent anywhere in the record. Its
      // neighbours all have some: four in a row plus one was drawn in 2019.
      key: 'runFive',
      label: 'Five consecutive numbers',
      combos: Math.max(0, K - D + 1),
      test: (s) => s.every((n, i) => i === 0 || n - s[i - 1] === 1),
      note: 'The whole draw in one unbroken run — 14-15-16-17-18 and the 64 others like it. The only tight shape with no precedent: four in a row plus a stray was drawn on 2019-02-20 as 27-49-50-51-52.',
    },
    {
      key: 'slipRow',
      label: 'A straight line across the play slip',
      combos: (() => {
        let t = 0
        for (let r = 0; r < 14; r++) t += choose(countWhere((n) => (n - 1) % 14 === r), D)
        return t
      })(),
      test: (s) => new Set(s.map((n) => (n - 1) % 14)).size === 1,
      note: 'Five numbers on one slip row — thirteen such tickets exist in the whole game.',
    },
    {
      key: 'slipColumn',
      label: 'All five in one slip column',
      combos: (() => {
        let t = 0
        for (let c = 0; c < 5; c++) t += choose(countWhere((n) => Math.min(4, Math.floor((n - 1) / 14)) === c), D)
        return t
      })(),
      test: (s) => new Set(s.map((n) => Math.min(4, Math.floor((n - 1) / 14)))).size === 1,
      note: 'Measured, never cut — 9,295 tickets and about one due per era, so its turn is coming.',
    },
    {
      key: 'squareCube',
      label: 'Every number a square or a cube',
      combos: choose(countWhere((n) => Number.isInteger(Math.sqrt(n)) || Number.isInteger(Math.cbrt(n))), D),
      test: (s) => s.every((n) => Number.isInteger(Math.sqrt(n)) || Number.isInteger(Math.cbrt(n))),
      note: 'Drawn from 1, 4, 8, 9, 16, 25, 27, 36, 49 and 64 — nothing else qualifies.',
    },
    {
      key: 'fib',
      label: 'Every number in the Fibonacci run',
      combos: choose(countWhere((n) => [1, 2, 3, 5, 8, 13, 21, 34, 55].includes(n)), D),
      test: (s) => s.every((n) => [1, 2, 3, 5, 8, 13, 21, 34, 55].includes(n)),
      note: 'Only nine Fibonacci numbers fit inside the pool.',
    },
    {
      key: 'digitSum',
      label: 'All five with the same digit sum',
      combos: (() => {
        const ds = (n: number) => String(n).split('').reduce((a, c) => a + Number(c), 0)
        let t = 0
        for (let v = 1; v <= 20; v++) t += choose(countWhere((n) => ds(n) === v), D)
        return t
      })(),
      test: (s) => {
        const ds = (n: number) => String(n).split('').reduce((a, c) => a + Number(c), 0)
        return new Set(s.map(ds)).size === 1
      },
      note: '9-18-27-36-45 and the handful of others whose digits add to the same total.',
    },
    {
      key: 'column7',
      label: 'All five in one column of seven',
      // Residues mod 7: six classes of ten and one of nine at K=69
      combos: (() => {
        let t = 0
        for (let r = 0; r < 7; r++) t += choose(countWhere((n) => (n - 1) % 7 === r), D)
        return t
      })(),
      test: (s) => new Set(s.map((n) => (n - 1) % 7)).size === 1,
      note: 'Measured, never cut — 16-23-30-44-58 came up on 2016-12-28, every number seven apart in the grid.',
    },
    {
      key: 'wideGaps',
      // All gaps at least g leaves C(K − (D−1)(g−1), D) ways
      label: 'Every gap fifteen or wider',
      combos: choose(K - (D - 1) * 14, D),
      test: (s) => s.every((n, i) => i === 0 || n - s[i - 1] >= 15),
      note: 'Measured, never cut — 3-19-35-51-67 again, four gaps of sixteen.',
    },
    {
      key: 'allPrime',
      label: 'All five prime',
      combos: choose(countWhere(prime), D),
      test: (s) => s.every(prime),
      note: 'Measured, never cut — it has occurred, on the schedule its count predicts.',
    },
    {
      key: 'sameMultiple',
      label: 'All five multiples of the same number',
      combos: narrowCount('sameMultiple'),
      test: (s) => s.reduce(gcd) >= 6,
      note: 'Sixes, sevens, eights and up — 6-12-30-48-66 and its kind. Twos, threes and fours are not here: 94 draws share a factor that small, so the family can only start where the record goes quiet.',
    },
    {
      key: 'gridColumn',
      label: `All five in one column of a ${NARROW_GRIDS.join(', ')}-wide grid`,
      combos: narrowCount('gridColumn'),
      test: (s) => NARROW_GRIDS.some((m) => new Set(s.map((n) => n % m)).size === 1),
      note: 'Same remainder every time, so they line up in a column however the pool is written out. Seven and eight wide are deliberately missing — both have been drawn.',
    },
    {
      key: 'slipDiagonal',
      label: 'A diagonal across the play slip',
      combos: narrowCount('slipDiagonal'),
      test: (s) => {
        const key = (n: number, dir: number) => ((n - 1) % 14) + dir * Math.floor((n - 1) / 14)
        return new Set(s.map((n) => key(n, -1))).size === 1 || new Set(s.map((n) => key(n, 1))).size === 1
      },
      note: 'The slip is fourteen across, so after the row and the column the diagonal is the last straight line left to draw on it.',
    },
    {
      key: 'twoDigits',
      label: 'The whole ticket written with two digits',
      combos: narrowCount('twoDigits'),
      test: (s) => new Set(s.flatMap((n) => String(n).split(''))).size <= 2,
      note: '1-11-12-21-22 uses nothing but ones and twos. Ten digits, forty-five pairs, and not one of those tickets has ever come up.',
    },
    {
      key: 'powerTwo',
      label: 'All five powers of two',
      combos: narrowCount('powerTwo'),
      test: (s) => s.every((n) => (n & (n - 1)) === 0),
      note: 'The doubling ticket: 1, 2, 4, 8, 16, 32 and 64 are every power of two the pool holds.',
    },
    {
      key: 'repdigit',
      label: 'All five double-numbers',
      combos: narrowCount('repdigit'),
      test: (s) => s.every((n) => n >= 11 && new Set(String(n)).size === 1),
      note: '11-22-33-44-55-66, the numbers people circle because they look deliberate. Six of them exist, so the whole family is a handful of tickets.',
    },
    {
      key: 'mirrorPool',
      // Pairs (a, K+1−a), plus the midpoint when both K and D allow one
      label: 'A mirror image of the pool',
      combos: D % 2 === 0 ? choose(Math.floor(K / 2), D / 2)
        : K % 2 === 1 ? choose(Math.floor(K / 2), (D - 1) / 2) : 0,
      test: (s) => s.every((n, i) => n + s[D - 1 - i] === K + 1),
      note: 'Measured, never cut — 3-19-35-51-67 on 2026-04-29 folds onto itself exactly: 3+67, 19+51, and 35 dead centre. That one draw is also an even progression and a full column of an eight-wide grid, three "impossible" shapes in a single ticket.',
    },
    {
      key: 'fibLike',
      label: 'Each number the sum of the two before it',
      combos: (() => {
        if (D < 3) return 0
        let t = 0
        for (let a = 1; a <= K; a++) {
          for (let b = a + 1; b <= K; b++) {
            const seq = [a, b]
            while (seq.length < D) seq.push(seq[seq.length - 1] + seq[seq.length - 2])
            if (seq[D - 1] <= K) t++
          }
        }
        return t
      })(),
      test: (s) => s.every((n, i) => i < 2 || n === s[i - 1] + s[i - 2]),
      note: 'Measured, never cut — 1-3-4-7-11 came up on 2002-06-19, and 3+4 is 7, 4+7 is 11.',
    },
    {
      key: 'triangular',
      label: 'All five triangular numbers',
      combos: choose(countWhere((n) => Number.isInteger(Math.sqrt(8 * n + 1))), D),
      test: (s) => s.every((n) => Number.isInteger(Math.sqrt(8 * n + 1))),
      note: 'Measured, never cut — 3-21-28-36-45 came up on 1996-12-18, every number a running total of 1+2+3+…',
    },
  ]
}

/** The families safe enough to leave out of the pool: tiny, and never observed. */
/**
 * The families safe enough to leave out of the pool: tiny, and never drawn in
 * the whole recorded history of the game — every era, not just this one.
 *
 * Four families were cut here that should not have been, for two separate
 * reasons. One decade (2003-02-22), all multiples of five (2009-10-14) and an
 * eight-number span (2015-09-09) were each drawn in a retired era, and scoping
 * the never-seen check to the current era hid all three. Three or more touching
 * pairs needs no such excuse: 27-49-50-51-52 fell on 2019-02-20, inside this
 * era, and the table was already reporting it as seen once when the family was
 * cut anyway. Each landed within ordinary noise of its own count, which is the
 * fair-lottery identity again: a shape shows up at the rate its size predicts,
 * and being able to name it afterwards does not make it rare. All four are
 * measured here rather than cut, and only the five-in-a-row shape they contain
 * — 65 tickets, still unseen — stays out.
 */
export const CUT_FAMILIES = new Set([
  'sameDigit', 'slipRow', 'squareCube', 'fib', 'digitSum', 'runFive',
  'evenStepTight', 'sameMultiple', 'gridColumn', 'slipDiagonal', 'twoDigits', 'powerTwo', 'repdigit',
])

/**
 * Families removed from the pool by choice rather than by evidence.
 *
 * Each has been drawn exactly once in 3,535 draws, and each landed within
 * ordinary noise of its own expected count — so unlike the set above, these
 * carry no claim that the shape cannot happen. They are out because the reader
 * looked at the price and decided one occurrence in thirty-odd years was worth
 * spending. Kept apart from CUT_FAMILIES precisely so that decision stays
 * visible: the value is the draw it has already cost.
 *
 * Three or more touching pairs is deliberately not here. It has been drawn
 * three times, most recently 27-49-50-51-52 in 2019, which is a different
 * proposition from once.
 */
export const CHOSEN_CUTS = new Map([
  ['oneDecade', '2-5-6-9-10 on 2003-02-22'],
  ['mult5', '5-15-25-30-40 on 2009-10-14'],
  ['tightSpan', '44-45-47-50-51 on 2015-09-09'],
])

/** Everything the pool can remove: proven-absent plus chosen. */
export const POOL_CUTS = new Set([...CUT_FAMILIES, ...CHOSEN_CUTS.keys()])

/** Each chosen cut had been drawn exactly this many times when it was chosen. */
export const CHOSEN_CUT_TOLERANCE = 1

/**
 * The last draw the cut list was set against. Every draw after it tests the
 * families on data they were never chosen from — the only honest test they
 * can get, because each family was found by looking at the record first.
 */
export const CUTS_SET_ON = '2026-08-03'

/**
 * Whether a family is still entitled to its place on the cut list, now that
 * it has been drawn `drawn` times across the full record.
 *
 * The list used to be a constant, which quietly made a promise the code never
 * checked: "cut only what has never been drawn". Drawn once tomorrow, a family
 * would have stayed cut forever while the Lab went on calling it unseen. The
 * rule is now enforced every time the engine runs. A proven-absent family goes
 * the first time it appears; a chosen one — accepted at one occurrence — goes
 * the moment a second one would make that choice a different decision.
 */
export function stillCut(key: string, drawn: number): boolean {
  if (CUT_FAMILIES.has(key)) return drawn === 0
  if (CHOSEN_CUTS.has(key)) return drawn <= CHOSEN_CUT_TOLERANCE
  return false
}

/** One family on the cut list and whether the record still supports cutting it. */
export interface CutStatus {
  key: string
  label: string
  /** Times drawn across the full record, every era */
  drawn: number
  /** The most recent draw with this shape */
  last: string | null
  kind: 'unseen' | 'chosen'
  active: boolean
}

/**
 * Count every cut family across the full record — every era, because that is
 * the record the cuts were chosen against, and a shape drawn in 2003 was still
 * drawn.
 */
export function cutStatus(allDraws: Draw[], K: number, D: number): CutStatus[] {
  return structuralFamilies(K, D)
    .filter((f) => POOL_CUTS.has(f.key))
    .map((f) => {
      let drawn = 0
      let last: string | null = null
      for (const d of allDraws) {
        if (d.sorted.length === D && f.test(d.sorted)) { drawn++; last = d.date }
      }
      return {
        key: f.key,
        label: f.label,
        drawn,
        last,
        kind: CUT_FAMILIES.has(f.key) ? 'unseen' as const : 'chosen' as const,
        active: stillCut(f.key, drawn),
      }
    })
}

/** The families the pool removes right now. */
export function activeCuts(lab: ConstraintLab): Set<string> {
  if (!lab.cuts) return new Set(POOL_CUTS)
  return new Set(lab.cuts.filter((c) => c.active).map((c) => c.key))
}

/**
 * Combinations with at least `minPairs` adjacent pairs (values differing by 1).
 *
 * One family covers every "looks too clustered" example at once: five in a row
 * like 14-15-16-17-18, four in a row plus a stray like 1-2-3-4-6 or 1-2-3-4-50,
 * and split runs like 1-2-3-65-66 all carry three or more adjacencies. The count
 * is exact: a D-subset of 1..K with exactly t adjacencies can be built
 * C(D−1,t)·C(K−D+1,D−t) ways.
 */
export function adjacencyAtLeast(K: number, D: number, minPairs: number): number {
  let total = 0
  for (let t = minPairs; t <= D - 1; t++) total += choose(D - 1, t) * choose(K - D + 1, D - t)
  return total
}

/** Every member of the ≥3-adjacency family, for exact ledger dedup. */
export function* clusteredCombos(K: number, D: number): Generator<number[]> {
  // A set is its runs: lengths r1..rk (each ≥1, summing to D) placed left to
  // right with at least one skipped value between runs. Adjacencies = D − k, so
  // three or more means k ≤ D − 3.
  const parts: number[] = []
  const combo: number[] = []
  function* place(pi: number, start: number): Generator<number[]> {
    if (pi === parts.length) {
      yield [...combo]
      return
    }
    const len = parts[pi]
    const rest = parts.slice(pi + 1).reduce((s, v) => s + v + 1, -1)
    for (let m = start; m + len - 1 + (rest > 0 ? rest + 1 : 0) <= K; m++) {
      for (let i = 0; i < len; i++) combo.push(m + i)
      yield* place(pi + 1, m + len + 1)
      combo.length -= len
    }
  }
  function* compositions(remaining: number, k: number): Generator<number[]> {
    if (k === 1) { yield [remaining]; return }
    for (let first = 1; first <= remaining - (k - 1); first++) {
      for (const rest of compositions(remaining - first, k - 1)) yield [first, ...rest]
    }
  }
  for (let k = 1; k <= D - 3; k++) {
    for (const comp of compositions(D, k)) {
      parts.length = 0
      parts.push(...comp)
      yield* place(0, 1)
    }
  }
}

/**
 * Combinations whose r-th smallest lands inside [lo[r], hi[r]] for every r.
 *
 * Five position bands are one joint constraint, not five separate ones, and
 * counting them needs a pass over the pool that tracks how many have been
 * chosen so far — the closed forms for a single position do not compose.
 */
export function positionBandCount(K: number, D: number, lo: number[], hi: number[]): number {
  let dp = new Float64Array(D + 1)
  dp[0] = 1
  for (let v = 1; v <= K; v++) {
    const next = new Float64Array(D + 1)
    for (let c = 0; c <= D; c++) {
      if (!dp[c]) continue
      next[c] += dp[c]
      if (c < D && v >= lo[c] && v <= hi[c]) next[c + 1] += dp[c]
    }
    dp = next
  }
  return Math.round(dp[D])
}

/** Combinations of D from 1..K whose values sum to at most `s` — exact, by DP. */
export function sumAtMostCount(K: number, D: number, s: number): number {
  const maxSum = ((2 * K - D + 1) * D) / 2
  const lim = Math.min(s, maxSum)
  if (lim < (D * (D + 1)) / 2) return 0
  const dp = Array.from({ length: D + 1 }, () => new Float64Array(lim + 1))
  dp[0][0] = 1
  for (let n = 1; n <= K; n++) {
    for (let j = D; j >= 1; j--) {
      const row = dp[j], prev = dp[j - 1]
      for (let t = lim; t >= n; t--) row[t] += prev[t - n]
    }
  }
  let total = 0
  for (let t = 0; t <= lim; t++) total += dp[D][t]
  return Math.round(total)
}

/** Combinations where at least four numbers share a last digit. */
export function sameDigitCount(K: number, D: number): number {
  // Two digit-groups of four would need eight numbers, so digits never overlap
  // and a straight sum over digits is exact.
  let total = 0
  for (let d = 0; d <= 9; d++) {
    let c = 0
    for (let n = 1; n <= K; n++) if (n % 10 === d) c++
    for (let j = 4; j <= Math.min(D, c); j++) total += choose(c, j) * choose(K - c, D - j)
  }
  return total
}

/**
 * The shapes anyone finds by sorting a spreadsheet of past draws, each priced
 * exactly.
 *
 * Sorting by a column and seeing "the 4th number is never under 6" feels like a
 * discovery about the machine, and the whole point of this table is to show it
 * is a discovery about counting: the 4th number staying at or under 5 needs four
 * of the five numbers crammed into 1..5, and only 321 of the 11,238,513
 * combinations manage it. The draws are not avoiding these shapes — there is
 * almost nothing there to hit. That is why every `observed` below lands where
 * `expected` says, and why removing all of them changes the odds by nothing a
 * player could ever feel: the winner had the same near-zero chance of being
 * there in the first place.
 */
const fmtBand = (lo: number[], hi: number[]): string => lo.map((l, i) => `${l}-${hi[i]}`).join(' / ')

function presetEliminations(
  draws: Draw[], K: number, D: number, universe: number,
  bands?: { lo: number; hi: number }[],
): PresetElimination[] {
  const n = draws.length
  const out: PresetElimination[] = []
  const add = (key: string, label: string, combos: number, observed: number, note: string) => {
    const share = combos / universe
    out.push({ key, label, combos, share, expected: share * n, observed, note })
  }

  // "The next-to-largest is never small" — needs D−1 numbers inside 1..5
  const vLow = 5
  let nextToLargestLow = 0
  let largestLow = 0
  let startsRun = 0
  let allDates = 0
  const vTop = Math.min(9, K - 1)
  const dateMax = Math.min(31, K)
  for (const d of draws) {
    if (d.sorted[D - 2] <= vLow) nextToLargestLow++
    if (d.sorted[D - 1] <= vTop) largestLow++
    if (d.sorted[D - 1] - d.sorted[0] === D - 1) startsRun++
    if (d.sorted[D - 1] <= dateMax) allDates++
  }
  add('pos4low', `Next-to-largest number ≤ ${vLow}`, countRthAtMost(K, D, D - 1, vLow), nextToLargestLow,
    `Needs ${D - 1} of the ${D} numbers crammed into 1–${vLow}.`)
  add('pos5low', `Largest number ≤ ${vTop}`, choose(vTop, D), largestLow,
    `Needs every number inside 1–${vTop}.`)
  add('run', `All ${D} consecutive`, K - D + 1, startsRun,
    'The 1-2-3-4-5 family — one straight run anywhere in the pool.')

  // The same instinct, pointed at shapes a sorted spreadsheet does not surface
  const topZone = Math.max(1, K - 9)
  let allHigh = 0
  let window10 = 0
  let digit4 = 0
  let clustered = 0
  let minSum = Number.POSITIVE_INFINITY
  let maxSum = 0
  for (const d of draws) {
    if (d.sorted[0] >= topZone) allHigh++
    if (d.sorted[D - 1] - d.sorted[0] <= 9) window10++
    const perDigit = new Array<number>(10).fill(0)
    let maxDigit = 0
    let adj = 0
    let total = 0
    for (let i = 0; i < D; i++) {
      const n = d.sorted[i]
      total += n
      const g = ++perDigit[n % 10]
      if (g > maxDigit) maxDigit = g
      if (i > 0 && n - d.sorted[i - 1] === 1) adj++
    }
    if (maxDigit >= 4) digit4++
    if (adj >= 3) clustered++
    if (total < minSum) minSum = total
    if (total > maxSum) maxSum = total
  }
  add('clustered', 'Three or more touching pairs', adjacencyAtLeast(K, D, 3), clustered,
    'Measured, never cut — drawn three times: 1-2-3-26-27, 19-20-21-45-46, and 27-49-50-51-52 on 2019-02-20, which is four in a row plus a stray. Expected 4.73 across the record, seen 3. Only the unbroken five-in-a-row inside it stays cut.')
  if (Number.isFinite(minSum)) {
    const below = sumAtMostCount(K, D, minSum - 1)
    if (below > 0) {
      add('sumLow', `Total below ${minSum}`, below, 0,
        `The lowest total ever drawn here is ${minSum} — sorting cannot show this one; it takes the sum column.`)
    }
    const arithMax = ((2 * K - D + 1) * D) / 2
    const above = choose(K, D) - sumAtMostCount(K, D, maxSum)
    if (above > 0 && maxSum < arithMax) {
      add('sumHigh', `Total above ${maxSum}`, above, 0,
        `The highest total ever drawn here is ${maxSum} — the mirror record, equally invisible in a sorted sheet.`)
    }
  }
  add('allHigh', `Every number ≥ ${topZone}`, choose(K - topZone + 1, D), allHigh,
    'The mirror of the all-low instinct: the whole draw crammed into the top ten.')
  add('window10', 'All inside one 10-number stretch', windowCount(K, D, 10), window10,
    'Any tight cluster, wherever it sits — 12-14-15-18-21 as much as 1-2-3-4-5.')
  add('digit4', 'Four share a last digit', sameDigitCount(K, D), digit4,
    'The 7-17-27-37 family, for every digit.')

  for (const fam of structuralFamilies(K, D)) {
    let seen = 0
    for (const d of draws) if (fam.test(d.sorted)) seen++
    add(fam.key, fam.label, fam.combos, seen, fam.note)
  }

  // The five walk-forward position bands, priced as the single joint rule they
  // are. Worth showing because it is the largest cut anyone reaches for by
  // reading a sorted sheet — and it lands exactly on its own share.
  if (bands && bands.length === D) {
    const lo = bands.map((b) => b.lo)
    const hi = bands.map((b) => b.hi)
    let insideBands = 0
    for (const d of draws) if (d.sorted.every((n, i) => n >= lo[i] && n <= hi[i])) insideBands++
    add('posBands', `Outside the ${fmtBand(lo, hi)} position bands`,
      universe - positionBandCount(K, D, lo, hi), draws.length - insideBands,
      'Five bands at once — the biggest cut a sorted sheet suggests, and it removes winners at exactly the rate it removes combinations.')
  }

  add('dates', `Every number ≤ ${dateMax}`, choose(dateMax, D), allDates,
    'The calendar zone. Not rare — but heavily played, because birthdays live here. Sharing risk, not drawing risk.')

  // Repeat of a past jackpot: the one elimination that grows with the history
  const seen = new Set<string>()
  let repeats = 0
  for (const d of draws) {
    const key = d.sorted.join('-')
    if (seen.has(key)) repeats++
    seen.add(key)
  }
  const expRepeats = (n * (n - 1)) / 2 / universe
  out.push({
    key: 'pastWinner',
    label: 'Exact repeat of a past jackpot',
    combos: seen.size,
    share: seen.size / universe,
    expected: expRepeats,
    observed: repeats,
    note: `With ${n.toLocaleString()} draws in ${universe.toLocaleString()} combinations, fairness expects ${expRepeats.toFixed(2)} repeats so far — none is unremarkable, and each past winner stays exactly as likely as any other combination.`,
  })
  return out
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

/**
 * Sample enough draws for the step-average to settle without paying for all of
 * them. The budget is per rule: a deep selection of thirty rules walks the
 * sample thirty times per step, so its stride grows to keep the whole pass at
 * a fixed cost — measured error at stride 3 was 0.006 of a percentage point.
 */
const strideFor = (evaluated: number, ruleCount = 1): number =>
  Math.max(1, Math.round(evaluated / 450), Math.round((evaluated * ruleCount) / 3000))

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
  /*
   * The under-200-million setting. Cutting a Powerball-sized pool below 200M
   * means removing about a third of the space, and the identity prices that in
   * winners: roughly a third of them go too. This mode exists so the trade can
   * be taken with open eyes rather than pretended away — the ledger prints the
   * remainder and the winners-kept figure side by side.
   */
  /*
   * The deepest setting, and the end of the ladder rather than a rung on it.
   * Given a lower floor the greedy stalls in the same place: with 28 rules
   * applied, every remaining candidate would drop winner survival past the
   * floor in one step. That stall is the identity showing through — the rule
   * family has no cut left that removes space without removing winners with it.
   */
  { key: 'deep', label: 'Deep cut', target: 0.68 },
]

/** Draws the first replay selection learns from before any draw is scored against it. */
export const FIRST_ORIGIN_STEPS = 200

/**
 * Draws between re-selections in the replay — about a year of a twice-weekly
 * game. Fixed in absolute steps from the start of the era, so appending draws
 * only ever adds folds: no earlier selection, and no earlier verdict, moves.
 */
export const REFIT_EVERY = 100

/**
 * The day this method stopped being tuned. The targets, alphas, feature list
 * and replay design were all chosen with the record up to here in view, so the
 * replay before it is validation, not a clean test. Draws after it are the only
 * ones nothing in this file was ever fitted to — and they are reported apart.
 */
export const METHOD_FROZEN_ON = '2026-10-27'

/** Everything the walk-forward pass recorded, as the selection needs it. */
interface WalkRecord {
  rules: ConstraintRule[]
  specs: FeatureSpec[]
  passMatrix: Uint8Array
  nRules: number
  evaluated: number
  evaluatedIdx: number[]
  draws: Draw[]
  sample: UniverseSample
  stepIv: StepIntervals
  /** Running per-rule space-share totals: [s·nRules + r] sums steps 0..s−1 */
  spaceCum: Float64Array
  /** Intervals fitted on the whole era — what is in force today */
  finalLo: Float64Array
  finalHi: Float64Array
  universe: number
}

/** What a selection made just before step `split` could see. */
interface SelectionView {
  split: number
  candidates: number[]
  /** Each candidate's interval as it stood at `split`, applied to the sample */
  masks: Map<number, Uint8Array>
}

/**
 * The candidates a selection made just before step `split` could know about:
 * which rules were eligible, how much space each had kept so far, and each
 * one's interval as it stood then. At `split = evaluated` this is today.
 *
 * The selection used to rank candidates by their full-record space share and
 * price them at end-of-record intervals, while scoring itself on the record's
 * second half — so the draws it was judged on had already shaped what it
 * chose. Swapping only those draws for fresh random ones changed every mode's
 * rule set in both games. Nothing here reads a step at or after `split`.
 */
function selectionView(w: WalkRecord, split: number): SelectionView {
  const today = split >= w.evaluated
  const ivAt = (r: number) => today
    ? { lo: w.finalLo[r], hi: w.finalHi[r] }
    : { lo: w.stepIv.lo[split * w.nRules + r], hi: w.stepIv.hi[split * w.nRules + r] }
  const ranked: { r: number; share: number }[] = []
  for (let r = 0; r < w.nRules; r++) {
    const spec = w.specs[w.stepIv.featOfRule[r]]
    // Only context-free rules combine: their membership does not move with the previous draw
    if (spec.conditional) continue
    const { lo, hi } = ivAt(r)
    if (lo <= spec.hardMin && hi >= spec.hardMax) continue
    const share = w.spaceCum[split * w.nRules + r] / split
    if (1 - share < 0.001) continue
    ranked.push({ r, share })
  }
  // Ranked by how much space each removes on its own; the greedy step decides
  // what that costs in winners.
  ranked.sort((a, b) => a.share - b.share || a.r - b.r)
  const candidates = ranked.slice(0, 40).map((c) => c.r)
  const masks = new Map<number, Uint8Array>()
  for (const r of candidates) {
    const vals = w.sample.values[w.stepIv.featOfRule[r]]
    const { lo, hi } = ivAt(r)
    const m = new Uint8Array(w.sample.size)
    for (let s = 0; s < m.length; s++) m[s] = passes(vals[s], lo, hi) ? 1 : 0
    masks.set(r, m)
  }
  return { split, candidates, masks }
}

/**
 * Greedily assemble the strongest selection that still clears a survival floor
 * on the steps before the view's split.
 *
 * Candidates are tried in order, and one is kept only if joint walk-forward
 * survival stays at or above the target after adding it. The joint state is
 * carried incrementally — one survivor mask over the sample, one pass mask over
 * the steps — so trying a candidate is a single AND-and-count against each,
 * which is what keeps the deep setting affordable at every refit.
 */
function greedySelect(
  w: WalkRecord, view: SelectionView, target: number,
): { chosen: number[]; path: { spaceShare: number; survival: number }[] } {
  const S = w.sample.size
  const n = view.split
  const aliveS = new Uint8Array(S).fill(1)
  const aliveH = new Uint8Array(n).fill(1)
  const chosen: number[] = []
  const path: { spaceShare: number; survival: number }[] = []
  const taken = new Set<number>()
  let current = { survival: 1, spaceShare: 1 }
  for (;;) {
    let bestIdx = -1
    let bestRes: { survival: number; spaceShare: number } | null = null
    let bestScore = 0
    for (const i of view.candidates) {
      if (taken.has(i)) continue
      const mask = view.masks.get(i)!
      let kept = 0
      for (let s = 0; s < S; s++) kept += aliveS[s] & mask[s]
      let hits = 0
      for (let step = 0; step < n; step++) hits += aliveH[step] & w.passMatrix[step * w.nRules + i]
      const res = { survival: n > 0 ? hits / n : 1, spaceShare: kept / S }
      if (res.survival < target) continue
      const gain = current.spaceShare - res.spaceShare
      if (gain <= 1e-6) continue
      // Space removed per winner surrendered — the only trade that matters
      const cost = Math.max(1e-4, current.survival - res.survival)
      const score = gain / cost
      if (score > bestScore) { bestScore = score; bestIdx = i; bestRes = res }
    }
    if (bestIdx < 0 || !bestRes) break
    const chosenMask = view.masks.get(bestIdx)!
    for (let s = 0; s < S; s++) aliveS[s] &= chosenMask[s]
    for (let step = 0; step < n; step++) aliveH[step] &= w.passMatrix[step * w.nRules + bestIdx]
    chosen.push(bestIdx)
    taken.add(bestIdx)
    path.push(bestRes)
    current = bestRes
  }
  return { chosen, path }
}

/** Steps at which the replay re-selects: fixed from the era's start, so they never move. */
export function replayOrigins(evaluated: number): number[] {
  const out: number[] = []
  for (let o = FIRST_ORIGIN_STEPS; o < evaluated; o += REFIT_EVERY) out.push(o)
  return out
}

const allPass = (w: WalkRecord, chosen: number[], step: number): boolean => {
  for (const r of chosen) if (!w.passMatrix[step * w.nRules + r]) return false
  return true
}

/**
 * Nested chronological validation of one mode: re-run the whole selection at
 * every origin from the draws before it, score it on the draws up to the next
 * origin, and pool the verdicts. This tests the procedure the app runs — choose
 * from everything known, deal from the result — rather than one rule set that
 * was chosen with the answers in view.
 */
function validateMode(
  w: WalkRecord, views: SelectionView[], target: number,
): { validation: ModeValidation; eliminated: ConstraintMode['eliminated'] } {
  const S = w.sample.size
  const zNeeded = bonferroniZ(MODE_TARGETS.length)
  const folds: ValidationFold[] = []
  const failedDates: string[] = []
  const eliminated: ConstraintMode['eliminated'] = []
  let held = 0, n = 0, expected = 0
  let pHeld = 0, pN = 0, pExpected = 0
  const sets: Set<number>[] = []
  for (let k = 0; k < views.length; k++) {
    const from = views[k].split
    const to = k + 1 < views.length ? views[k + 1].split : w.evaluated
    const { chosen } = greedySelect(w, views[k], target)
    sets.push(new Set(chosen))
    const stride = Math.max(1, Math.round((to - from) / 50), Math.round(((to - from) * chosen.length) / 600))
    const share = chosen.length
      ? matchedPrefixShares(chosen, w.stepIv, w.sample, w.nRules, from, to, stride).prefix[chosen.length - 1]
      : 1
    let foldHeld = 0
    for (let step = from; step < to; step++) {
      const d = w.draws[w.evaluatedIdx[step]]
      const ok = allPass(w, chosen, step)
      if (ok) foldHeld++
      else {
        failedDates.push(d.date)
        eliminated.push({
          date: d.date,
          numbers: d.sorted,
          failed: chosen.filter((r) => !w.passMatrix[step * w.nRules + r]).map((r) => w.rules[r].label),
        })
      }
      if (d.date > METHOD_FROZEN_ON) { pN++; pHeld += ok ? 1 : 0; pExpected += share }
    }
    folds.push({ origin: w.draws[w.evaluatedIdx[from]].date, ruleIds: chosen.map((r) => w.rules[r].id), draws: to - from, held: foldHeld, share })
    held += foldHeld
    n += to - from
    expected += share * (to - from)
  }

  // Pooling the folds at their average share overstates the variance a little
  // (each fold's own share is closer to its draws), so the z errs towards noise.
  const share = n ? expected / n : 1
  const test = poolVsRandom(held, n, share, S)
  const pShare = pN ? pExpected / pN : 1
  let turnover = 0
  for (let k = 1; k < sets.length; k++) {
    const a = sets[k - 1], b = sets[k]
    let inter = 0
    for (const r of a) if (b.has(r)) inter++
    const union = a.size + b.size - inter
    turnover += union ? 1 - inter / union : 0
  }
  return {
    validation: {
      folds,
      from: folds.length ? folds[0].origin : '',
      draws: n,
      held,
      survival: n ? held / n : 1,
      share,
      z: n ? test.z : 0,
      ciLo: test.ciLo,
      ciHi: test.ciHi,
      zNeeded,
      verdict: n < 100 ? 'insufficient' : test.z >= zNeeded ? 'edge' : test.z <= -zNeeded ? 'worse' : 'noise',
      turnover: sets.length > 1 ? turnover / (sets.length - 1) : 0,
      failedDates,
      prospective: {
        since: METHOD_FROZEN_ON,
        draws: pN,
        held: pHeld,
        share: pShare,
        z: pN ? poolVsRandom(pHeld, pN, pShare, S).z : 0,
      },
    },
    // Most recent first: the latest misses say most about the pool in use now
    eliminated: eliminated.slice(-25).reverse(),
  }
}

/**
 * Today's selection for every mode, plus the replay that says whether the way
 * it was chosen holds up on draws it never saw.
 *
 * Today's rules are chosen from every evaluated draw — the same procedure the
 * replay re-runs at each origin — so the figure to trust is the replay's, and
 * the in-sample survival beside it is reported as exactly that.
 */
function buildModes(w: WalkRecord): ConstraintMode[] {
  const S = w.sample.size
  const origins = replayOrigins(w.evaluated)
  const views = origins.map((o) => selectionView(w, o))
  const today = selectionView(w, w.evaluated)

  return MODE_TARGETS.map(({ key, label, target }) => {
    const { chosen, path } = greedySelect(w, today, target)
    const funnel: FunnelStep[] = chosen.map((r, k) => ({
      ruleId: w.rules[r].id,
      label: w.rules[r].label,
      spaceShare: path[k].spaceShare,
      survival: path[k].survival,
      removed: (k > 0 ? path[k - 1].spaceShare : 1) - path[k].spaceShare,
    }))

    let hits = 0
    const failedSteps: number[] = []
    for (let step = 0; step < w.evaluated; step++) {
      if (allPass(w, chosen, step)) hits++
      else failedSteps.push(step)
    }
    let kept = 0
    for (let s = 0; s < S; s++) {
      let ok = 1
      for (const r of chosen) if (!today.masks.get(r)![s]) { ok = 0; break }
      kept += ok
    }
    const currentShare = kept / S

    // Re-measure the space against the walk-forward intervals, so the in-sample
    // survival is compared with the share its own rules were keeping at the time.
    const stride = strideFor(w.evaluated, Math.max(1, chosen.length))
    const matched = chosen.length
      ? matchedPrefixShares(chosen, w.stepIv, w.sample, w.nRules, 0, w.evaluated, stride).prefix
      : []
    const spaceShare = chosen.length ? matched[chosen.length - 1] : 1
    for (let k = 0; k < funnel.length; k++) {
      funnel[k].spaceShare = matched[k]
      funnel[k].removed = (k > 0 ? matched[k - 1] : 1) - matched[k]
    }

    const { validation, eliminated } = validateMode(w, views, target)
    return {
      key, label, target,
      ruleIds: chosen.map((r) => w.rules[r].id),
      spaceShare,
      currentShare,
      survival: hits / w.evaluated,
      survivalLo: wilson(hits, w.evaluated).lo,
      combinationsBefore: w.universe,
      combinationsAfter: Math.round(w.universe * currentShare),
      eliminated,
      failedDates: failedSteps.map((step) => w.draws[w.evaluatedIdx[step]].date),
      funnel,
      edgeZ: poolVsRandom(hits, w.evaluated, spaceShare, S).z,
      holdoutSurvival: validation.survival,
      holdoutDraws: validation.draws,
      holdoutShare: validation.share,
      holdoutEdgeZ: validation.z,
      validation,
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
  const shares = matchedPrefixShares(chosen, stepIv, sample, nRules, 0, evaluated, strideFor(evaluated, chosen.length))
  for (let k = 0; k < chosen.length; k++) {
    const res = evaluateSet(chosen.slice(0, k + 1), ruleSurvivors, passMatrix, nRules, evaluated, sample.size)
    points.push({ spaceShare: shares.prefix[k], survival: res.survival, rules: k + 1 })
  }
  return points
}

/**
 * Whether the machine is fair, tested eight ways.
 *
 * Every other measurement in this file asks whether one particular rule beats
 * its own space share. This asks the question underneath all of them: are the
 * combinations drawn uniformly at all? If they are, the fair-lottery identity
 * holds by definition and no family anywhere can be cut for free — which makes
 * this the test that decides whether hunting for more of them is worth doing.
 *
 * The third one carries the most weight. Every combination has a rank in the
 * colex ordering of all C(K,D) of them, and under a uniform draw those ranks
 * are uniform on [0,1); a Kolmogorov–Smirnov test against that is a single
 * check of the whole hypothesis rather than of one slice through it.
 */
function fairnessTests(
  draws: Draw[], K: number, D: number, universe: number,
): ConstraintLab['fairness'] {
  const N = draws.length
  const out: ConstraintLab['fairness'] = []
  if (N < 200) return out
  const say = (z: number) => (Math.abs(z) < 2 ? 'as expected' : Math.abs(z) < 3 ? 'worth watching' : 'off the line')
  const push = (key: string, label: string, stat: string, z: number) =>
    out.push({ key, label, stat, z, verdict: say(z) })

  // 1. Every ball equally likely
  const cnt = new Array(K + 1).fill(0)
  for (const d of draws) for (const n of d.sorted) cnt[n]++
  const expected = (N * D) / K
  let chi = 0
  for (let n = 1; n <= K; n++) chi += (cnt[n] - expected) ** 2 / expected
  push('balls', 'Every number equally likely', `${cnt.slice(1).reduce((a, b) => Math.min(a, b))}–${cnt.slice(1).reduce((a, b) => Math.max(a, b))} times each, expected ${expected.toFixed(0)}`,
    (chi - (K - 1)) / Math.sqrt(2 * (K - 1)))

  // 2. The whole combination, uniform across the entire space
  const ranks = draws
    .map((d) => {
      let r = 0
      for (let i = 0; i < D; i++) r += choose(d.sorted[i] - 1, i + 1)
      return r / universe
    })
    .sort((a, b) => a - b)
  let ks = 0
  for (let i = 0; i < N; i++) {
    ks = Math.max(ks, Math.abs(ranks[i] - i / N), Math.abs((i + 1) / N - ranks[i]))
  }
  // KS converts to a comparable scale: 1.36/√N is the 5% point, i.e. |z| = 2
  push('uniform', 'Whole combinations spread evenly over all ' + universe.toLocaleString(),
    `largest gap from uniform ${(ks * 100).toFixed(2)}%, 5% limit ${((1.36 / Math.sqrt(N)) * 100).toFixed(2)}%`,
    (ks / (1.36 / Math.sqrt(N))) * 2)

  // 3. One draw says nothing about the next
  const sums = draws.map((d) => d.sorted.reduce((a, b) => a + b, 0))
  const mean = sums.reduce((a, b) => a + b, 0) / N
  let num = 0
  let den = 0
  for (let i = 0; i < N; i++) {
    den += (sums[i] - mean) ** 2
    if (i) num += (sums[i] - mean) * (sums[i - 1] - mean)
  }
  const r1 = den > 0 ? num / den : 0
  push('serial', 'Each draw independent of the one before', `sum correlation ${r1.toFixed(3)}`, r1 * Math.sqrt(N))

  // 4. Numbers carried over from the previous draw
  let rep = 0
  for (let i = 1; i < N; i++) {
    for (const n of draws[i].sorted) if (draws[i - 1].sorted.includes(n)) rep++
  }
  const eRep = (D * D) / K
  const vRep = (eRep * (1 - D / K)) / (N - 1)
  push('repeat', 'Numbers held over from the last draw',
    `${(rep / (N - 1)).toFixed(3)} per draw, expected ${eRep.toFixed(3)}`,
    (rep / (N - 1) - eRep) / Math.sqrt(Math.max(1e-9, vRep)))

  // 5. How long a number waits between appearances
  const last = new Array(K + 1).fill(-1)
  const gaps: number[] = []
  draws.forEach((d, i) => {
    for (const n of d.sorted) {
      if (last[n] >= 0) gaps.push(i - last[n])
      last[n] = i
    }
  })
  if (gaps.length > 50) {
    const gm = gaps.reduce((a, b) => a + b, 0) / gaps.length
    const eGap = K / D
    push('gaps', 'How long a number waits to return',
      `${gm.toFixed(1)} draws on average, expected ${eGap.toFixed(1)}`,
      (gm - eGap) / (Math.sqrt(eGap * (eGap - 1)) / Math.sqrt(gaps.length)))
  }

  // 6. The bonus ball, on its own machine
  const withSpecial = draws.filter((d) => d.special !== undefined)
  if (withSpecial.length > 200) {
    let sk = 0
    for (const d of withSpecial) sk = Math.max(sk, d.special!)
    if (sk >= 2) {
      const sc = new Array(sk + 1).fill(0)
      for (const d of withSpecial) sc[d.special!]++
      const es = withSpecial.length / sk
      let schi = 0
      for (let n = 1; n <= sk; n++) schi += (sc[n] - es) ** 2 / es
      push('bonus', 'Every bonus ball equally likely', `${sk} values, expected ${es.toFixed(0)} each`,
        (schi - (sk - 1)) / Math.sqrt(2 * (sk - 1)))
    }
  }
  return out
}

/* ───────────────────────── the reduction ledger ───────────────────────── */

export interface LedgerRow {
  key: string
  label: string
  /** Full combinations (main-sets × bonus balls) this row removes */
  removed: number
  /** Running remainder after this row */
  remaining: number
  /** What the removal cost in real, walk-forward-tested winners */
  winnersNote: string
  /** True when the count is an exact enumeration rather than Monte Carlo */
  exact: boolean
}

export interface ReductionLedger {
  /** C(K,D) × bonus pool — every way the machine can land */
  start: number
  rows: LedgerRow[]
  remaining: number
  /** Share of the full pool still standing */
  remainingShare: number
  /** Winner survival of the whole stack, from the walk-forward record */
  winnersKept: number
  /** Times the bonus ball repeated its previous value in this history */
  bonusBackToBack: number
  /** Draws whose main-set had already been drawn before — the retire-the-past rule's real cost */
  mainRepeats: number
  /** The receipt, when a main-set really did repeat */
  repeatExample: { numbers: number[]; first: string; second: string } | null
}

/** Every D-combination of 1..K with total ≤ bound, by pruned DFS. */
export function* sumBoundedCombos(K: number, D: number, bound: number): Generator<number[]> {
  const combo: number[] = []
  // Minimal completion from value v: v, v+1, … — prune when even that overshoots
  function* walk(start: number, left: number, budget: number): Generator<number[]> {
    if (left === 0) { yield [...combo]; return }
    for (let v = start; v <= K - left + 1; v++) {
      const minRest = left * v + (left * (left - 1)) / 2
      if (minRest > budget) return
      combo.push(v)
      yield* walk(v + 1, left - 1, budget - v)
      combo.pop()
    }
  }
  yield* walk(1, D, bound)
}

/** Exact membership test for a mode's context-free rule set. */
export function modePredicate(lab: ConstraintLab, mode: ConstraintMode): (sorted: number[]) => boolean {
  const specs = featureSpecs(lab.K, lab.drawSize)
  const byKey = new Map(specs.map((s, i) => [s.key, i]))
  const rules = mode.ruleIds
    .map((id) => lab.rules.find((r) => r.id === id))
    .filter((r): r is ConstraintRule => !!r)
    .map((r) => ({ fi: byKey.get(r.featureKey)!, lo: r.lo, hi: r.hi }))
  if (!rules.length) return () => true
  return (sorted: number[]): boolean => {
    const f = extractFeatures(sorted, lab.K, EMPTY_CONTEXT)
    for (const { fi, lo, hi } of rules) {
      const v = f[fi]
      if (Number.isFinite(v) && (v < lo || v > hi)) return false
    }
    return true
  }
}

/**
 * The reduced pool as a membership test, for generating predictions inside it:
 * the mode's shape bands, no already-drawn main-set, and none of the never-seen
 * families (small next-to-largest, everything under 10, three or more touching
 * pairs). Exactly the ledger's rows, as a predicate.
 */
/** One past draw judged against the pool as it stood before that draw. */
export interface PoolVerdict {
  date: string
  kept: boolean
  /** Which layer removed it, or null when the pool would have held it */
  cutBy: string | null
}

/**
 * Replay the reduced pool across the record, judging every draw by the pool as
 * it stood *before* that draw was known.
 *
 * The point of the exercise is to answer "how would this cut have done?" without
 * the answer being rigged, so every layer that depends on the data is rebuilt
 * per step: the record totals come from earlier draws only, so a draw that sets
 * a new record is cut by the boundary it is about to move; a main-set counts as
 * already-drawn only if it appeared earlier. The mode's shape bands arrive
 * pre-computed from the lab's own walk-forward pass. The static layers — the
 * families, the position floors — carry no leak because they never consult the
 * data at all.
 *
 * Draws before the lab's warm-up get no verdict, and neither do draws from a
 * retired pool: both are absent from the returned map rather than guessed at.
 */
export function poolWalkForward(
  lab: ConstraintLab,
  mode: ConstraintMode,
  allDraws: Draw[],
): PoolVerdict[] {
  const D = lab.drawSize
  // Slice exactly where the lab did — re-detecting here could disagree with a
  // scheduled boundary and misalign every verdict by the difference.
  const cut = lab.eraTrim ? allDraws.findIndex((d) => d.date >= lab.eraTrim!.cutoffDate) : 0
  const eraInfo = lab.eraTrim && cut > 0 ? { cutoffIndex: cut } : null
  const draws = eraInfo ? allDraws.slice(eraInfo.cutoffIndex) : allDraws
  /*
   * The bands are judged by the replay: each draw against the rules selected
   * before it. Today's selection was chosen on these same draws, so scoring the
   * record with it — as this once did — counts every draw it was fitted to as a
   * success it predicted. Draws before the first replay origin were only ever
   * selected from, never tested, so they get no verdict.
   */
  const bandFailed = new Set(mode.validation.failedDates)
  const firstScored = mode.validation.from
    ? draws.findIndex((d) => d.date >= mode.validation.from)
    : -1
  const firstJudged = firstScored < 0 ? draws.length : firstScored
  const judged = new Set<string>()

  /*
   * A family is judged by the cut list as it stood before each draw: counted
   * across everything earlier, retired era included, since that is the record
   * the cuts are chosen against. A family drawn at step i was genuinely on the
   * list when draw i arrived — that draw is charged to it — and genuinely off
   * the list for every draw after.
   */
  const families = structuralFamilies(lab.K, D).filter((f) => POOL_CUTS.has(f.key))
  const drawnBefore = new Map(families.map((f) => [f.key, 0]))
  const countIn = (s: number[]) => {
    for (const f of families) if (f.test(s)) drawnBefore.set(f.key, drawnBefore.get(f.key)! + 1)
  }
  if (eraInfo) for (const d of allDraws.slice(0, eraInfo.cutoffIndex)) if (d.sorted.length === D) countIn(d.sorted)
  const seen = new Set<string>()
  const out: PoolVerdict[] = []
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY

  for (let i = 0; i < draws.length; i++) {
    const d = draws[i]
    const s = d.sorted
    const key = s.join('-')
    const total = s.reduce((a, b) => a + b, 0)
    if (i >= firstJudged && !judged.has(d.date)) {
      judged.add(d.date)
      let cutBy: string | null = null
      if (bandFailed.has(d.date)) cutBy = `${mode.label} shape bands`
      else if (seen.has(key)) cutBy = 'already drawn'
      else if (s[D - 2] <= 5 || s[D - 1] <= 9) cutBy = 'position floor'
      else if (i > 0 && (total <= lo || total >= hi)) cutBy = 'record total'
      else {
        const fam = families.find((f) => stillCut(f.key, drawnBefore.get(f.key)!) && f.test(s))
        if (fam) cutBy = fam.label
      }
      out.push({ date: d.date, kept: cutBy === null, cutBy })
    }
    countIn(s)
    seen.add(key)
    if (total < lo) lo = total
    if (total > hi) hi = total
  }
  return out
}

export function reducedPoolAcceptor(
  lab: ConstraintLab,
  mode: ConstraintMode,
  pastKeys: ReadonlySet<string>,
): (sorted: number[]) => boolean {
  const passesMode = modePredicate(lab, mode)
  const D = lab.drawSize
  const rec = lab.sumRecord
  const live = activeCuts(lab)
  const families = structuralFamilies(lab.K, D).filter((f) => live.has(f.key))
  return (sorted: number[]): boolean => {
    if (sorted[D - 2] <= 5 || sorted[D - 1] <= 9) return false
    let total = 0
    for (let i = 0; i < D; i++) total += sorted[i]
    // Adjacency is no longer cut wholesale: three touching pairs has been drawn
    // three times, most recently 27-49-50-51-52 in 2019. Only the unbroken
    // five-in-a-row survives as a family, and it comes through the loop below.
    for (const fam of families) if (fam.test(sorted)) return false
    // Totals at or beyond the era's records are cut — deliberately including
    // the record draws themselves, and the ledger charges those two winners.
    if (rec && (total <= rec.min || total >= rec.max)) return false
    if (pastKeys.has(sorted.join('-'))) return false
    return passesMode(sorted)
  }
}

/** Every k-subset of `arr`, for the tiny families that get enumerated exactly. */
function* kSubsets(arr: number[], k: number): Generator<number[]> {
  const idx = Array.from({ length: k }, (_, i) => i)
  const n = arr.length
  if (k > n) return
  for (;;) {
    yield idx.map((i) => arr[i])
    let p = k - 1
    while (p >= 0 && idx[p] === n - k + p) p--
    if (p < 0) return
    idx[p]++
    for (let q = p + 1; q < k; q++) idx[q] = idx[q - 1] + 1
  }
}

/**
 * The deduction run in full, starting from every combination the machine can
 * land — mains × bonus pool — and subtracting in order:
 *
 *  1. the active mode's shape bands (Monte Carlo, walk-forward-tested),
 *  2. every main-set already drawn, retired with every bonus ball,
 *  3. the never-seen families, enumerated combination by combination so the
 *     overlap with the first two rows is exact and nothing is counted twice.
 *
 * Each row carries its cost in real winners from the same walk-forward record,
 * because a removal is only as good as what it kept. And the final line stays
 * the final line: the remainder is the list worth choosing from, while any one
 * ticket inside it is still 1 in the full pool — the draw is made from the
 * whole space, not from the list.
 */
/** What the family row has cost, read from the record rather than written in. */
function familiesNote(lab: ConstraintLab): string {
  const cuts = lab.cuts ?? []
  const chosen = cuts.filter((c) => c.kind === 'chosen' && c.active)
  const released = cuts.filter((c) => !c.active)
  const taken = chosen.reduce((s, c) => s + c.drawn, 0)
  let note = taken > 0
    ? `cost 0 tested winners in this era — but the ${chosen.length} chosen cuts have taken ${taken} draw${taken === 1 ? '' : 's'} across the full record`
    : 'cost 0 tested winners — none of these shapes has ever been drawn'
  if (released.length) {
    note += `; released after being drawn: ${released.map((c) => `${c.label} (${c.last})`).join(', ')}`
  }
  return note
}

export function reductionLedger(
  lab: ConstraintLab,
  mode: ConstraintMode,
  draws: Draw[],
  specialK: number,
): ReductionLedger {
  const K = lab.K
  const D = lab.drawSize
  const sk = Math.max(1, specialK)
  const start = lab.universe * sk
  const rows: LedgerRow[] = []
  let remaining = start

  const passesMode = modePredicate(lab, mode)
  const modeRuleCount = mode.ruleIds.length

  const push = (key: string, label: string, removed: number, winnersNote: string, exact: boolean) => {
    remaining -= removed
    rows.push({ key, label, removed, remaining, winnersNote, exact })
  }

  if (modeRuleCount > 0) {
    // Today's bands at today's intervals — the same test `passesMode` applies
    // to every row below, so the rows stay consistent with each other.
    const removed = Math.round(start * (1 - mode.currentShare))
    const v = mode.validation
    push('mode', `${mode.label} shape bands (${modeRuleCount} rules, tested walk-forward)`, removed,
      v.draws > 0
        ? `kept ${(v.survival * 100).toFixed(2)}% of ${v.draws.toLocaleString()} winners it had not been chosen on, where a random pool this size keeps ${(v.share * 100).toFixed(2)}%`
        : `kept ${(mode.survival * 100).toFixed(2)}% of the ${lab.evaluated.toLocaleString()} winners it was chosen on — too little history to test it on any others`,
      false)
  }

  // Every main-set already drawn, retired with every bonus ball — counting only
  // sets the bands did not already remove, so nothing is deducted twice.
  //
  // This rule's cost is not hypothetical. "It already came out" reads as free
  // because no one expects a repeat — but the full Powerball record contains
  // one: 2-13-20-21-23 fell on 2003-02-08 and again on 2008-01-09. Whatever
  // history is loaded, the real cost is counted from it and reported.
  const seen = new Map<string, string>()
  const pastSurvivors: number[][] = []
  let mainRepeats = 0
  let repeatExample: ReductionLedger['repeatExample'] = null
  for (const d of draws) {
    const key = d.sorted.join('-')
    const firstDate = seen.get(key)
    if (firstDate !== undefined) {
      mainRepeats++
      if (!repeatExample) repeatExample = { numbers: d.sorted, first: firstDate, second: d.date }
      continue
    }
    seen.set(key, d.date)
    if (passesMode(d.sorted)) pastSurvivors.push(d.sorted)
  }
  push('past', `Every main-set already drawn (${seen.size.toLocaleString()}), with all ${sk} bonus balls`,
    pastSurvivors.length * sk,
    mainRepeats === 0
      ? 'cost 0 tested winners so far — no main-set has repeated in this history'
      : `would have cost ${mainRepeats} real winner${mainRepeats === 1 ? '' : 's'} — main-sets have repeated here`,
    true)

  // Never-seen families, enumerated exactly and deduped against everything above
  const family = new Map<string, number[]>()
  const addCombo = (combo: number[]) => {
    const key = combo.join('-')
    if (!family.has(key)) family.set(key, combo)
  }
  const low5 = [1, 2, 3, 4, 5].filter((n) => n <= K)
  for (const base of kSubsets(low5, Math.min(D - 1, low5.length))) {
    for (let other = 1; other <= K; other++) {
      if (base.includes(other)) continue
      addCombo([...base, other].sort((a, b) => a - b))
    }
  }
  const top9 = Array.from({ length: Math.min(9, K) }, (_, i) => i + 1)
  for (const combo of kSubsets(top9, D)) addCombo([...combo])
  // Structural families safe enough to cut: enumerated so their overlap with
  // everything above is exact rather than estimated.
  const live = activeCuts(lab)
  const cutFams = structuralFamilies(K, D).filter((f) => live.has(f.key))
  // The groups below are a superset walk, cheap to enumerate; each member is
  // only deducted if a family still on the list actually claims it, so a
  // family released by a new draw drops out of the ledger on its own.
  const addFamilyCombo = (combo: number[]) => {
    if (cutFams.some((f) => f.test(combo))) addCombo(combo)
  }
  if (cutFams.length) {
    const walk = (start: number, pick: number[]) => {
      if (pick.length === D) {
        for (const f of cutFams) if (f.test(pick)) { addCombo([...pick]); return }
        return
      }
      for (let v = start; v <= K - (D - pick.length) + 1; v++) {
        pick.push(v)
        walk(v + 1, pick)
        pick.pop()
      }
    }
    // Only the decades, multiples and digit runs can qualify, so walking each
    // family's own members is far cheaper than the whole universe.
    const groups: number[][] = []
    for (let g = 0; g <= 9; g++) groups.push(Array.from({ length: K }, (_, i) => i + 1).filter((n) => n % 10 === g))
    // The three chosen cuts: each has been drawn once, and each is here because
    // that price was looked at and accepted.
    const decadeOf = (n: number) => Math.floor((n - 1) / 10)
    for (let d = 0; d <= decadeOf(K); d++) groups.push(Array.from({ length: K }, (_, i) => i + 1).filter((n) => decadeOf(n) === d))
    groups.push(Array.from({ length: K }, (_, i) => i + 1).filter((n) => n % 5 === 0))
    for (let m = 1; m + 7 <= K; m++) groups.push(Array.from({ length: 8 }, (_, i) => m + i))
    for (let r = 0; r < 14; r++) groups.push(Array.from({ length: K }, (_, i) => i + 1).filter((n) => (n - 1) % 14 === r))
    groups.push(Array.from({ length: K }, (_, i) => i + 1).filter((n) => Number.isInteger(Math.sqrt(n)) || Number.isInteger(Math.cbrt(n))))
    groups.push([1, 2, 3, 5, 8, 13, 21, 34, 55].filter((n) => n <= K))
    const digitSum = (n: number) => String(n).split('').reduce((a, c) => a + Number(c), 0)
    for (let v = 1; v <= 20; v++) groups.push(Array.from({ length: K }, (_, i) => i + 1).filter((n) => digitSum(n) === v))
    // The narrow-set families read from the same definition that priced them,
    // so the row can never deduct a different family than the table charged for.
    for (const n of narrowGroups(K)) for (const g of n.groups) groups.push(g)
    for (const g of groups) for (const combo of kSubsets(g, D)) addFamilyCombo([...combo])
    // Even progressions are the one cut family that is not "all D from a single
    // small set", so the group walk above cannot reach them. Enumerate each
    // step's members directly — a few hundred combinations, and dedup against
    // everything already collected keeps the ledger's arithmetic exact.
    for (let step = 1; step <= MAX_CUT_STEP; step++) {
      for (let a = 1; a + (D - 1) * step <= K; a++) {
        addFamilyCombo(Array.from({ length: D }, (_, i) => a + i * step))
      }
    }
    void walk
  }
  // Five in a row — the only clustered shape with no precedent. The wider
  // ≥3-touching-pairs family it sits inside has been drawn three times, so that
  // one is measured in the table above instead of deducted here.
  for (let m = 1; m + D - 1 <= K; m++) addFamilyCombo(Array.from({ length: D }, (_, i) => m + i))

  let familySurvivors = 0
  for (const combo of family.values()) {
    if (seen.has(combo.join('-'))) continue
    if (!passesMode(combo)) continue
    familySurvivors++
  }
  push('families', 'Never-drawn families — five in a row, one last digit, one slip row or diagonal, shared multiples, narrow grid columns, even progressions, every 1-2-3-4-x — plus one decade, all multiples of five and the eight-number span, cut by choice',
    familySurvivors * sk,
    familiesNote(lab), true)

  // Totals at or beyond the era's records, enumerated member by member. The
  // regions are small enough to walk exactly: the low side directly, the high
  // side through the mirror n → K+1−n, which turns "sum ≥ max" into "sum ≤
  // D·(K+1) − max".
  const rec = lab.sumRecord
  if (rec) {
    let sumSurvivors = 0
    let costLo = 0
    let costHi = 0
    const consider = (combo: number[]) => {
      const key = combo.join('-')
      if (seen.has(key) || family.has(key)) return
      if (!passesMode(combo)) return
      sumSurvivors++
    }
    for (const combo of sumBoundedCombos(K, D, rec.min)) consider(combo)
    const mirrorBound = D * (K + 1) - rec.max
    for (const combo of sumBoundedCombos(K, D, mirrorBound)) {
      consider(combo.map((n) => K + 1 - n).sort((a, b) => a - b))
    }
    // The records are era-scoped, so the cost is counted over era draws too —
    // old-pool draws with tiny totals are not this rule's bill.
    const eraStart = lab.eraTrim?.cutoffDate ?? ''
    for (const d of draws) {
      if (d.date < eraStart) continue
      const total = d.sorted.reduce((a, b) => a + b, 0)
      if (total <= rec.min) costLo++
      if (total >= rec.max) costHi++
    }
    push('sums', `Totals at or beyond the era records (≤ ${rec.min} and ≥ ${rec.max}) not already cut`,
      sumSurvivors * sk,
      `would have cost ${costLo + costHi} real winners — the record draws themselves`, true)
  }

  let bonusBackToBack = 0
  for (let i = 1; i < draws.length; i++) {
    if (draws[i].special !== undefined && draws[i].special === draws[i - 1].special) bonusBackToBack++
  }

  return {
    start,
    rows,
    remaining,
    remainingShare: remaining / start,
    winnersKept: !modeRuleCount ? 1 : mode.validation.draws > 0 ? mode.validation.survival : mode.survival,
    bonusBackToBack,
    mainRepeats,
    repeatExample,
  }
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
