import { useEffect, useState } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import { isRuleKey, rulesAt } from '../engine/rules.ts'
import { recordSnapshot, SNAPSHOT_KEY, snapshotOf, type PredictionSnapshot, type SnapshotBook } from '../engine/snapshots.ts'

const read = (): SnapshotBook => {
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY)
    return raw ? (JSON.parse(raw) as SnapshotBook) : {}
  } catch {
    return {}
  }
}

/**
 * Keep the live prediction for the next draw of an official game, once, and
 * return every snapshot kept for that game. Storage failures cost the record,
 * never the screen.
 *
 * Only a result that belongs to this game's current history is kept: for one
 * render after a game switch the engine's result is still the previous game's,
 * and filing it under the new one would put a stranger's prediction on record.
 */
export function useSnapshots(
  game: string | undefined, syncKey: string | undefined, draws: Draw[], result: EngineResult | null, computing: boolean,
): PredictionSnapshot[] {
  const [book, setBook] = useState<SnapshotBook>(read)
  useEffect(() => {
    if (!game || !isRuleKey(syncKey) || !result?.ok || computing || !draws.length) return
    const last = draws[draws.length - 1].date
    if (result.lastDate !== last || result.rules?.K !== rulesAt(syncKey, last)?.K) return
    const snap = snapshotOf(result, new Date(), syncKey)
    if (!snap) return
    const current = read()
    const next = recordSnapshot(current, game, snap)
    if (next === current) return
    try { window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(next)) } catch { /* full or blocked */ }
    setBook(next)
  }, [game, syncKey, draws, result, computing])
  return game ? book[game] ?? [] : []
}
