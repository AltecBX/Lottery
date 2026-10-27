#!/usr/bin/env node --experimental-strip-types
/**
 * Every research figure the app reports, recomputed from the published
 * histories in public/ and printed as one report. Deterministic: the same
 * files give the same numbers on any machine, so a claim made from them can
 * be checked rather than taken on trust.
 *
 *   npm run research            # both games
 *   npm run research powerball  # one
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeHistory } from '../src/engine/history.ts'
import { runEngine } from '../src/engine/engine.ts'
import { DEFAULT_SETTINGS } from '../src/engine/types.ts'
import { eraInputs } from '../src/engine/researchjob.ts'
import { compareModels, SPLIT_LABEL } from '../src/engine/research.ts'
import { studyTopPositions } from '../src/engine/tailstudy.ts'
import { compareStrategies, STRATEGY_LABEL } from '../src/engine/replay.ts'

const here = dirname(fileURLToPath(import.meta.url))
const games = process.argv[2] ? [process.argv[2]] : ['powerball', 'megamillions']
const STARTS = {
  powerball: ['2005-12-31', '2010-12-31', '2014-12-31', '2018-12-31', '2022-12-31'],
  megamillions: ['2010-12-31', '2014-12-31', '2018-12-31', '2022-12-31'],
}
const sig = (z) => `${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(2)}σ`
const pct = (v) => `${(v * 100).toFixed(2)}%`
const out = (s = '') => process.stdout.write(`${s}\n`)

for (const key of games) {
  const file = JSON.parse(await readFile(resolve(here, '..', 'public', `history-${key}.json`), 'utf8'))
  const draws = decodeHistory(file)
  out(`# ${key} — ${draws.length} drawings ${draws[0].date} to ${draws[draws.length - 1].date}`)

  const res = runEngine(draws, { ...DEFAULT_SETTINGS, ruleKey: key })
  out(`\nRules from the schedule: mains since ${res.rules.mainsFrom} (1–${res.rules.K}), bonus since ${res.rules.bonusFrom} (1–${res.rules.specialK}).`)
  out(`Data check: ${res.dataHealth.checked} rows, ${res.dataHealth.rejected.length} rejected, ${res.dataHealth.missing.length} scheduled drawings missing.`)

  const lab = res.constraintLab
  out(`\n## Constraint Lab (${lab.evaluated} walk-forward draws)`)
  out(`Rules called a real edge: ${lab.rules.filter((r) => r.provenEdge).length} of ${lab.rules.length} (bar ${lab.significance.ruleZ.toFixed(2)}σ).`)
  out('| Mode | Pool today | Replay draws | Winners kept | Random pool keeps | z | Verdict |')
  out('|---|---|---|---|---|---|---|')
  for (const m of lab.modes) {
    const v = m.validation
    out(`| ${m.label} | ${m.combinationsAfter.toLocaleString()} (${pct(m.currentShare)}) | ${v.draws} from ${v.from} | ${pct(v.survival)} | ${pct(v.share)} | ${sig(v.z)} | ${v.verdict} |`)
  }

  const inputs = eraInputs(draws, key)
  const cmp = compareModels(inputs.era, inputs.K, 5, inputs.specialK)
  out(`\n## Models (${cmp.from} to ${cmp.to})`)
  out(cmp.splits.map((s) => `${SPLIT_LABEL[s.key]} ${s.n} (${s.from}–${s.to})`).join(' · '))
  out('| Model | Validation vs existing | Final test top-10 | vs chance | Verdict |')
  out('|---|---|---|---|---|')
  for (const m of cmp.models) {
    out(`| ${m.label} | ${m.key === 'ensemble' ? '—' : sig(m.splits.validate?.pairedZ ?? 0)} | ${(m.splits.test?.top10 ?? 0).toFixed(3)} | ${sig(m.splits.test?.z10 ?? 0)} | ${m.verdict} |`)
  }
  out(`\n${cmp.decision.text}`)
  out(cmp.chance.text)
  out(`Calibration on unseen draws: predicted ${cmp.calibration.predicted10.toFixed(3)}, observed ${cmp.calibration.observed10.toFixed(3)}, chance ${cmp.calibration.chance10.toFixed(3)} (${sig(cmp.calibration.z)}).`)
  out(`Learned combiner, nats/draw above uniform: validation ${cmp.mlLogScore.validate.toFixed(4)}, test ${cmp.mlLogScore.test.toFixed(4)}.`)
  out(`Signals: ${cmp.redundancy.signals} carry about ${cmp.redundancy.effective.toFixed(1)} independent readings.`)
  if (cmp.bonus) {
    for (const [k, v] of Object.entries(cmp.bonus.splits)) if (v.n) out(`Bonus ${SPLIT_LABEL[k]}: top-3 ${pct(v.top3)} of ${v.n} vs ${pct(v.chance3)} (${sig(v.z3)}).`)
  }

  const tail = studyTopPositions(inputs.era, inputs.K, 5)
  out(`\n## The 4th and 5th numbers (${tail.n} draws; bar ${tail.zNeeded.toFixed(2)}σ either way)`)
  out('| Restriction | Space kept | Winners kept | Lost | z | Verdict |')
  out('|---|---|---|---|---|---|')
  for (const r of tail.restrictions) out(`| ${r.label} | ${pct(r.share)} | ${pct(r.survival)} | ${r.missed} | ${sig(r.z)} | ${r.verdict} |`)
  out(tail.joint.text)
  out(`Correlation ${tail.correlation.observed.toFixed(3)} vs exact ${tail.correlation.theory.toFixed(3)} (${sig(tail.correlation.z)}).`)

  out('\n## Replay from a date')
  out('| Start | Strategy | Draws | Top-10 | Chance | z |')
  out('|---|---|---|---|---|---|')
  for (const start of STARTS[key] ?? []) {
    const c = compareStrategies(draws, key, start)
    for (const r of c.results) out(`| ${start} | ${STRATEGY_LABEL[r.strategy]} | ${r.n} | ${r.top10.toFixed(4)} | ${r.chance10.toFixed(4)} | ${sig(r.z10)} |`)
    const worst = Math.max(...c.pairs.map((p) => Math.abs(p.z)))
    out(`| ${start} | *largest paired difference* | | | | ${worst.toFixed(2)}σ (bar ${c.zNeeded.toFixed(2)}σ) |`)
  }
  out()
}
