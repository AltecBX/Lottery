import type { Draw, Settings } from './types.ts'
import { DEFAULT_SETTINGS } from './types.ts'
import type { SyncKey } from './sync.ts'

/** One tracked game: its own history, settings, and (optionally) an official sync source. */
export interface GameData {
  id: string
  name: string
  /** Present when the game is linked to an official results source (one-tap sync). */
  syncKey?: SyncKey
  draws: Draw[]
  settings: Settings
}

export interface GamesState {
  games: GameData[]
  activeId: string
}

export const OFFICIAL_GAMES: { key: SyncKey; name: string }[] = [
  { key: 'powerball', name: 'Powerball' },
  { key: 'megamillions', name: 'Mega Millions' },
]

export function createGame(id: string, name: string, syncKey?: SyncKey): GameData {
  const game: GameData = { id, name, draws: [], settings: { ...DEFAULT_SETTINGS } }
  if (syncKey) game.syncKey = syncKey
  return game
}

/**
 * Wrap a legacy single-game history (pre-multi-game storage) into the games
 * model. Guesses the game identity from the data's shape so official sync
 * lights up when it obviously matches Powerball or Mega Millions.
 */
export function migrateLegacy(draws: Draw[] | null, settings: Settings | null): GamesState | null {
  if (!draws || draws.length === 0) return null
  let maxMain = 0
  let maxSpecial = 0
  let withSpecial = 0
  for (const d of draws) {
    for (const n of d.sorted) maxMain = Math.max(maxMain, n)
    if (d.special !== undefined) {
      withSpecial++
      maxSpecial = Math.max(maxSpecial, d.special)
    }
  }
  const drawSize = draws[0]?.sorted.length ?? 5
  let name = 'My game'
  let syncKey: SyncKey | undefined
  if (drawSize === 5 && withSpecial >= draws.length * 0.9) {
    if (maxMain <= 69 && maxSpecial <= 26) {
      name = 'Powerball'
      syncKey = 'powerball'
    } else if (maxMain <= 70 && maxSpecial <= 25) {
      name = 'Mega Millions'
      syncKey = 'megamillions'
    }
  }
  const game: GameData = {
    id: syncKey ?? 'legacy',
    name,
    draws,
    settings: { ...DEFAULT_SETTINGS, ...(settings ?? {}) },
  }
  if (syncKey) game.syncKey = syncKey
  return { games: [game], activeId: game.id }
}

/** Days since the newest saved draw (fractional); Infinity when empty. */
export function daysSinceLastDraw(game: GameData, nowMs: number): number {
  const last = game.draws[game.draws.length - 1]
  if (!last) return Infinity
  const [y, m, d] = last.date.split('-').map(Number)
  return (nowMs - new Date(y, m - 1, d).getTime()) / 86400000
}
