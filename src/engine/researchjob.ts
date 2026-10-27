import type { Draw } from './types.ts'
import { bonusEraStart, mainsEraStart, rulesAt, verifyHistory, type RuleKey } from './rules.ts'
import { compareModels, type ModelComparison } from './research.ts'
import { studyTopPositions, type TailStudy } from './tailstudy.ts'
import { compareStrategies, type StrategyComparison } from './replay.ts'

/**
 * The research tools as one job runner, so the worker and the tests run the
 * same code. Each is seconds of work, run when asked for and never as part of
 * the ordinary engine pass the rest of the app waits on.
 */

export type ResearchJob =
  | { kind: 'models'; draws: Draw[]; ruleKey: RuleKey }
  | { kind: 'replay'; draws: Draw[]; ruleKey: RuleKey; start: string }

export interface ModelsReport {
  kind: 'models'
  /** First drawing under today's main-number rules */
  eraFrom: string
  models: ModelComparison | null
  tail: TailStudy | null
}

export interface ReplayReport {
  kind: 'replay'
  comparison: StrategyComparison
}

export type ResearchReport = ModelsReport | ReplayReport

/**
 * Today's era exactly as the engine scopes it: verified rows only, main
 * numbers from the white-ball era, bonus balls only from the bonus era.
 */
export function eraInputs(allDraws: Draw[], key: RuleKey, D = 5) {
  const check = verifyHistory(allDraws, key, D)
  const source = allDraws.filter((d) => !check.rejected.has(d.date))
  const last = source[source.length - 1]?.date ?? ''
  const rules = last ? rulesAt(key, last) : null
  if (!rules) return null
  const mainsFrom = mainsEraStart(key, last)!
  const bonusFrom = bonusEraStart(key, last)!
  const era = source
    .filter((d) => d.date >= mainsFrom)
    .map((d) => (d.special !== undefined && d.date < bonusFrom ? { ...d, special: undefined } : d))
  return { era, K: rules.K, specialK: rules.specialK, mainsFrom }
}

export function runResearch(job: ResearchJob): ResearchReport {
  if (job.kind === 'models') {
    const inputs = eraInputs(job.draws, job.ruleKey)
    if (!inputs) return { kind: 'models', eraFrom: '', models: null, tail: null }
    return {
      kind: 'models',
      eraFrom: inputs.mainsFrom,
      models: compareModels(inputs.era, inputs.K, 5, inputs.specialK),
      tail: studyTopPositions(inputs.era, inputs.K, 5),
    }
  }
  const comparison = compareStrategies(job.draws, job.ruleKey, job.start)
  // The per-draw predictions are for tests and the log; the panel needs the
  // scores, so the message across the worker boundary stays small.
  for (const r of comparison.results) r.steps = r.steps.map((s) => ({ ...s, predicted: [] }))
  return { kind: 'replay', comparison }
}
