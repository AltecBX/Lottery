import type { EngineResult } from './types.ts'

/**
 * What the app actually showed before a draw, kept as it was.
 *
 * The prediction log is otherwise a reproduction: every row is the current
 * model re-run on the draws before it, which is exact and leak-free but
 * answers "what would this model have said", not "what did the app say". The
 * two part company whenever the method changes. A snapshot is written once,
 * the first time a draw is predicted, and never rewritten — so a draw
 * predicted live can always be checked against what was really on screen,
 * and the draws since the method was frozen form a record nothing can tune.
 */
export interface PredictionSnapshot {
  /** Draw date the prediction was for */
  date: string
  version: string
  /** When it was first shown, ISO-8601 */
  savedAt: string
  top10: number[]
  combo: number[]
  bonus: number[]
  /** Share of all combinations the Deep cut pool held at the time */
  poolShare: number | null
}

export type SnapshotBook = Record<string, PredictionSnapshot[]>

export const SNAPSHOT_KEY = 'patternlab.snapshots.v1'
/** Per game; at two or three draws a week this is years of history */
export const SNAPSHOT_CAP = 600

export function snapshotOf(res: EngineResult, now: Date = new Date()): PredictionSnapshot | null {
  if (!res.ok || !res.nextDate || !res.top10.length) return null
  const deep = res.constraintLab?.modes.find((m) => m.key === 'deep')
  return {
    date: res.nextDate,
    version: res.modelVersion ?? '',
    savedAt: now.toISOString(),
    top10: res.top10.map((p) => p.number),
    combo: res.bestCombo?.numbers ?? [],
    bonus: res.special?.picks.slice(0, 3).map((p) => p.number) ?? [],
    poolShare: deep ? deep.currentShare : null,
  }
}

/** Add a snapshot unless one for that draw already exists — the first one shown stands. */
export function recordSnapshot(book: SnapshotBook, game: string, snap: PredictionSnapshot): SnapshotBook {
  const list = book[game] ?? []
  if (list.some((s) => s.date === snap.date)) return book
  const next = [...list, snap].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(-SNAPSHOT_CAP)
  return { ...book, [game]: next }
}
