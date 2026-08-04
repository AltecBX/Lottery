#!/usr/bin/env node --experimental-strip-types
/**
 * Build `public/history-<game>.json` — the deepest draw history obtainable, by
 * merging every public source rather than trusting one.
 *
 * No source is best at both games. New York's open data starts in 2010 for
 * Powerball but 2002 for Mega Millions. Louisiana's CSV starts in 1995 for
 * Powerball but 2011 for Mega Millions, carries the jackpot and the winning
 * ticket's location, and sends no CORS header, so a browser cannot read it at
 * all. Merging both here — server-side, where the same-origin policy does not
 * apply — gives the union: every draw either source knows about, with the
 * extra detail attached wherever Louisiana has it.
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseDelimitedText } from '../src/engine/parse.ts'
import { mergeDraws } from '../src/engine/parse.ts'
import { parseSocrataRows, SYNC_SOURCES, CSV_SOURCES } from '../src/engine/sync.ts'
import { encodeHistory } from '../src/engine/history.ts'

const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(here, '..', 'public')
const TIMEOUT_MS = 60_000
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

async function get(url, accept) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const resp = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: accept } })
    if (!resp.ok) throw new Error(`${resp.status}`)
    return await resp.text()
  } finally {
    clearTimeout(timer)
  }
}

const summarize = (draws) => (draws.length ? `${draws.length} draws ${draws[0].date}→${draws[draws.length - 1].date}` : 'none')

for (const { key } of SYNC_SOURCES) {
  const outFile = resolve(OUT_DIR, `history-${key}.json`)
  const sources = []
  let merged = []

  // Louisiana first: it carries jackpots and winner locations, and merging
  // keeps the richer record when both sources describe the same draw.
  const csv = CSV_SOURCES.find((s) => s.key === key)
  try {
    const outcome = parseDelimitedText(await get(csv.url, 'text/csv'))
    if (outcome.draws.length === 0) throw new Error('no rows parsed')
    merged = outcome.draws
    sources.push(csv.url)
    console.log(`${key}: louisiana ${summarize(outcome.draws)}${outcome.errors.length ? ` (${outcome.errors.length} bad rows)` : ''}`)
  } catch (err) {
    console.warn(`${key}: louisiana unavailable (${err.message})`)
  }

  const ny = SYNC_SOURCES.find((s) => s.key === key)
  try {
    const rows = JSON.parse(await get(ny.url, 'application/json'))
    const outcome = parseSocrataRows(rows, key)
    if (outcome.draws.length === 0) throw new Error('no rows parsed')
    const before = merged.length
    merged = mergeDraws(merged, outcome.draws).merged
    sources.push(ny.url)
    console.log(`${key}: new york ${summarize(outcome.draws)} → +${merged.length - before} new`)
  } catch (err) {
    console.warn(`${key}: new york unavailable (${err.message})`)
  }

  if (merged.length === 0) {
    console.warn(`${key}: no source reachable — leaving any existing file in place`)
    continue
  }

  // Never publish a file thinner than the one already there: a source having a
  // bad day must not silently shorten the user's history.
  try {
    const prev = JSON.parse(await readFile(outFile, 'utf8'))
    if (prev.count > merged.length) {
      console.warn(`${key}: built ${merged.length} but ${prev.count} already published — keeping the longer file`)
      continue
    }
  } catch { /* nothing published yet */ }

  await mkdir(OUT_DIR, { recursive: true })
  const file = encodeHistory(key, merged, sources)
  await writeFile(outFile, `${JSON.stringify(file)}\n`)
  const kb = Math.round((await readFile(outFile)).length / 1024)
  console.log(`${key}: wrote ${file.count} draws ${file.first}→${file.last} (${kb}KB)\n`)
}
