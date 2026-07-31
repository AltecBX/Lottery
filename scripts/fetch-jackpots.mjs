#!/usr/bin/env node --experimental-strip-types
/**
 * Build `public/jackpots.json` from the operators' own pages.
 *
 * Runs in CI, where there is no browser and therefore no same-origin policy to
 * fight. The app then reads the published file from its own origin, which is
 * the only way an iPhone can see the real advertised prize: neither
 * powerball.com nor megamillions.com sends CORS headers.
 *
 * Failure is never fatal. A source that times out or changes its markup leaves
 * the previous entry in place (when it still points at a future draw) and the
 * app falls back to projecting the jackpot from its own history.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FEED_URLS,
  isPlausibleEntry,
  parseMegaMillionsPayload,
  parsePowerballPage,
} from '../src/engine/feed.ts'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(here, '..', 'public', 'jackpots.json')
const TIMEOUT_MS = 20_000
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

async function withTimeout(run) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    return await run(ctl.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function fetchPowerball() {
  return withTimeout(async (signal) => {
    const resp = await fetch(FEED_URLS.powerball, {
      signal,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    })
    if (!resp.ok) throw new Error(`powerball.com responded ${resp.status}`)
    return parsePowerballPage(await resp.text())
  })
}

async function fetchMegaMillions() {
  return withTimeout(async (signal) => {
    const resp = await fetch(FEED_URLS.megamillions, {
      method: 'POST',
      signal,
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    })
    if (!resp.ok) throw new Error(`megamillions.com responded ${resp.status}`)
    return parseMegaMillionsPayload(await resp.text())
  })
}

async function readPrevious() {
  try {
    return JSON.parse(await readFile(OUT, 'utf8'))
  } catch {
    return { updated: '', games: {} }
  }
}

const today = new Date().toISOString().slice(0, 10)
const previous = await readPrevious()
const games = {}
let failures = 0

for (const [key, fetchOne] of [['powerball', fetchPowerball], ['megamillions', fetchMegaMillions]]) {
  try {
    const entry = await fetchOne()
    if (!isPlausibleEntry(entry)) throw new Error('no usable jackpot in the response')
    games[key] = entry
    console.log(`${key}: $${(entry.jackpot / 1e6).toFixed(1)}M for ${entry.drawDate}`)
  } catch (err) {
    failures++
    const kept = previous.games?.[key]
    // Only keep a stale entry while it still points at a draw that has not happened
    if (kept && kept.drawDate >= today) {
      games[key] = kept
      console.warn(`${key}: ${err.message} — keeping ${kept.drawDate} entry`)
    } else {
      console.warn(`${key}: ${err.message} — no entry published`)
    }
  }
}

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, `${JSON.stringify({ updated: new Date().toISOString(), games }, null, 2)}\n`)
console.log(`wrote ${OUT} (${Object.keys(games).length} game(s), ${failures} failure(s))`)
