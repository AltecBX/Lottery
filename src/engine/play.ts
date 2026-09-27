import type { EngineResult } from './types.ts'
import { buildPortfolio, type PortfolioShape, type PortfolioTicket } from './portfolio.ts'
import { reducedPoolAcceptor, type ConstraintMode } from './constraintlab.ts'
import { uncrowded } from './crowd.ts'

/**
 * The Play screen's five games, as a pure function of the engine's output.
 *
 * It lives here rather than in the component so the screen and the replay that
 * audits it deal from one definition — the replay is only worth anything if it
 * hands back exactly what the phone would have shown.
 */

export const PLAY_COUNT = 5
export const PLAY_SPREAD = 0.65

/**
 * A deal seed for one draw: stable for that draw, different for the next.
 *
 * The seed used to be a constant, and replaying the Play screen across the 23
 * Powerball draws after 3 August 2026 showed what that did — the same five
 * games, 7-20-27-50-66 and 7-14-35-50-51 among them, before every one of those
 * draws for seven weeks. The model's weights do move between draws, but by too
 * little to flip a single sample drawn from an identical random stream, so a
 * fixed seed pinned the deal. Keying it to the draw date keeps what was right
 * about the constant — reopen the app and the same draw shows the same five —
 * and gives every new draw a genuinely new deal. FNV-1a, because it is tiny
 * and spreads adjacent dates far apart.
 */
export function seedFor(date: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < date.length; i++) {
    h ^= date.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  // Keep it inside the LCG range "Another five" steps through.
  return (h % 2147483646) + 1
}

export interface PlaySetup {
  /** The pool the games are dealt from — the deepest the lab offers */
  mode: ConstraintMode | null
  accept: (sorted: number[]) => boolean
  scores: Float64Array
  shape: PortfolioShape | null
}

export function playSetup(res: EngineResult, pastWinners: ReadonlySet<string>): PlaySetup {
  const lab = res.constraintLab
  /*
   * The deepest pool, not a middling one. The Lab's ladder exists so the
   * trade-off can be inspected; the Play screen has already made the choice.
   * Two tests, both free: the pool decides which combinations look like draws
   * this game produces, and `uncrowded` drops the ones a lot of other people
   * also play. Neither changes any ticket's odds.
   */
  const mode = lab ? (lab.modes.find((m) => m.key === 'deep') ?? lab.modes[lab.modes.length - 1] ?? null) : null
  const crowdFree = uncrowded(res.K, pastWinners as Set<string>)
  let accept = crowdFree
  if (lab && mode) {
    const inPool = reducedPoolAcceptor(lab, mode, pastWinners)
    accept = (sorted: number[]) => inPool(sorted) && crowdFree(sorted)
  }

  const scores = new Float64Array(res.K + 1)
  for (const p of res.predictions) scores[p.number] = Math.max(1e-9, p.probability)

  let shape: PortfolioShape | null = null
  if (lab && lab.positionBands.length === res.drawSize) {
    const sumRule = lab.rules.find((r) => r.featureKey === 'sum' && r.alpha === 0.002)
    shape = {
      lo: lab.positionBands.map((b) => b.lo),
      hi: lab.positionBands.map((b) => b.hi),
      sumLo: sumRule?.lo ?? 0,
      sumHi: sumRule?.hi ?? Number.MAX_SAFE_INTEGER,
    }
  }
  return { mode, accept, scores, shape }
}

/** Deal the five, keeping any held tickets; held ones come back first. */
export function dealPlay(
  res: EngineResult,
  setup: PlaySetup,
  pastWinners: ReadonlySet<string>,
  seed: number,
  hold: PortfolioTicket[] = [],
): PortfolioTicket[] {
  return buildPortfolio({
    scores: setup.scores,
    K: res.K,
    D: res.drawSize,
    specialK: res.special?.K ?? 0,
    specialPicks: res.special?.picks.map((p) => p.number) ?? [],
    specialProbs: res.special?.picks.map((p) => p.probability) ?? [],
    count: PLAY_COUNT,
    spread: PLAY_SPREAD,
    shape: setup.shape,
    exclude: pastWinners as Set<string>,
    accept: setup.accept,
    hold,
    seed,
    // The Play screen reads its set-level figures from exactPortfolioStats, so
    // the comparison baselines buildPortfolio also measures go unused here.
    trials: 1,
  }).tickets
}
