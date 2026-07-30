import { useCallback, useMemo, useState } from 'react'
import type { Draw, Settings } from './engine/types.ts'
import { DEFAULT_SETTINGS } from './engine/types.ts'
import { mergeDraws } from './engine/parse.ts'
import { generateSampleDraws } from './engine/sample.ts'
import { fetchOfficialResults, type SyncKey } from './engine/sync.ts'
import {
  createGame, daysSinceLastDraw, migrateLegacy, OFFICIAL_GAMES,
  type GameData, type GamesState,
} from './engine/games.ts'
import { formatDate } from './engine/dates.ts'
import { useEngine } from './hooks/useEngine.ts'
import { useLocalStorage, useTheme } from './hooks/useLocalStorage.ts'
import { PredictionPanel } from './components/PredictionPanel.tsx'
import { RankingTable } from './components/RankingTable.tsx'
import { HotColdOverdue } from './components/HotColdOverdue.tsx'
import { DowPanel } from './components/DowPanel.tsx'
import { PairsPanel } from './components/PairsPanel.tsx'
import { CombosPanel } from './components/CombosPanel.tsx'
import { TrendsPanel } from './components/TrendsPanel.tsx'
import { SimilarPanel } from './components/SimilarPanel.tsx'
import { BacktestPanel } from './components/BacktestPanel.tsx'
import { HistoryTable } from './components/HistoryTable.tsx'
import { PredictionLog } from './components/PredictionLog.tsx'
import { RealityPanel } from './components/RealityPanel.tsx'
import { InspectorPanel } from './components/InspectorPanel.tsx'
import { TicketLab } from './components/TicketLab.tsx'
import { AddResultDialog, ImportDialog, SettingsDialog } from './components/dialogs.tsx'
import { AddGameDialog } from './components/AddGameDialog.tsx'

const NAV = [
  ['prediction', 'Prediction'],
  ['ranking', 'Ranking'],
  ['log', 'Prediction log'],
  ['reality', 'Reality check'],
  ['ticket', 'Ticket lab'],
  ['inspector', 'Inspector'],
  ['hotcold', 'Hot / Cold'],
  ['dow', 'Weekdays'],
  ['pairs', 'Pairs'],
  ['combos', 'Combos'],
  ['trends', 'Trends'],
  ['similar', 'Similar'],
  ['backtest', 'Backtest'],
  ['history', 'History'],
] as const

const EMPTY_DRAWS: Draw[] = []

/** Read the multi-game state, migrating pre-multi-game storage on first run. */
function loadInitialGames(): GamesState {
  try {
    const raw = window.localStorage.getItem('patternlab.games.v1')
    if (raw) return JSON.parse(raw) as GamesState
  } catch { /* fall through to migration */ }
  try {
    const oldDraws = window.localStorage.getItem('patternlab.draws.v1')
    const oldSettings = window.localStorage.getItem('patternlab.settings.v1')
    const migrated = migrateLegacy(
      oldDraws ? (JSON.parse(oldDraws) as Draw[]) : null,
      oldSettings ? (JSON.parse(oldSettings) as Settings) : null,
    )
    if (migrated) return migrated
  } catch { /* corrupted legacy data — start fresh */ }
  return { games: [], activeId: '' }
}

export default function App() {
  const initial = useMemo(loadInitialGames, [])
  const [gamesState, setGamesState] = useLocalStorage<GamesState>('patternlab.games.v1', initial)
  const [themeChoice, cycleTheme] = useTheme()
  const [dialog, setDialog] = useState<'' | 'import' | 'add' | 'settings' | 'addgame'>('')
  const [flash, setFlash] = useState('')
  const [syncing, setSyncing] = useState(false)

  const games = gamesState.games
  const activeGame: GameData | undefined = games.find((g) => g.id === gamesState.activeId) ?? games[0]
  const draws = activeGame?.draws ?? EMPTY_DRAWS
  const settings = useMemo(
    () => ({ ...DEFAULT_SETTINGS, ...(activeGame?.settings ?? {}) }),
    [activeGame?.settings],
  )

  const { result, computing } = useEngine(draws, settings)

  const say = (msg: string) => {
    setFlash(msg)
    window.setTimeout(() => setFlash(''), 4600)
  }

  const setActiveId = useCallback((id: string) => {
    setGamesState((s) => ({ ...s, activeId: id }))
  }, [setGamesState])

  const updateGame = useCallback((id: string, fn: (g: GameData) => GameData) => {
    setGamesState((s) => ({ ...s, games: s.games.map((g) => (g.id === id ? fn(g) : g)) }))
  }, [setGamesState])

  const updateActiveDraws = useCallback((fn: (prev: Draw[]) => Draw[]) => {
    setGamesState((s) => {
      const active = s.games.find((x) => x.id === s.activeId) ?? s.games[0]
      if (!active) return s
      return { ...s, games: s.games.map((g) => (g.id === active.id ? { ...g, draws: fn(g.draws) } : g)) }
    })
  }, [setGamesState])

  const updateActiveSettings = useCallback((patch: Partial<Settings>) => {
    setGamesState((s) => {
      const active = s.games.find((x) => x.id === s.activeId) ?? s.games[0]
      if (!active) return s
      return {
        ...s,
        games: s.games.map((g) => (g.id === active.id ? { ...g, settings: { ...DEFAULT_SETTINGS, ...g.settings, ...patch } } : g)),
      }
    })
  }, [setGamesState])

  const detectedPool = useMemo(() => {
    let m = 0
    for (const d of draws) for (const n of d.sorted) m = Math.max(m, n)
    return m
  }, [draws])

  const detectedSize = useMemo(() => (draws.length > 0 ? draws[draws.length - 1].sorted.length : 0), [draws])

  const detectedSpecialMax = useMemo(() => {
    let m = 0
    for (const d of draws) if (d.special !== undefined) m = Math.max(m, d.special)
    return m
  }, [draws])

  const existingDates = useMemo(() => new Set(draws.map((d) => d.date)), [draws])
  const hasData = draws.length > 0

  /** Fetch a game's official history and merge any new draws in. */
  const syncGame = useCallback(async (gameId: string, silentWhenCurrent = false) => {
    const game = gamesState.games.find((g) => g.id === gameId)
    if (!game?.syncKey) return
    setSyncing(true)
    try {
      const outcome = await fetchOfficialResults(game.syncKey)
      if (outcome.draws.length === 0) {
        say('The official source returned no rows — try again later.')
        return
      }
      // Merge outside the state updater: updaters run at commit time, so a
      // count captured inside one is not readable here.
      const merged = mergeDraws(game.draws, outcome.draws)
      updateGame(gameId, (g) => ({ ...g, draws: merged.merged }))
      if (merged.added > 0) say(`${game.name}: ${merged.added} new draw${merged.added === 1 ? '' : 's'} added — model retrained.`)
      else if (!silentWhenCurrent) say(`${game.name} is already up to date.`)
    } catch (err) {
      say(`Sync failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSyncing(false)
    }
  }, [gamesState.games, updateGame])

  /** One-tap official game setup (or switch + refresh, if it already exists). */
  const setupOfficial = useCallback(async (key: SyncKey) => {
    const existing = gamesState.games.find((g) => g.syncKey === key)
    if (existing) {
      setActiveId(existing.id)
      setDialog('')
      void syncGame(existing.id, true)
      return
    }
    const meta = OFFICIAL_GAMES.find((g) => g.key === key)!
    setSyncing(true)
    try {
      const outcome = await fetchOfficialResults(key)
      if (outcome.draws.length === 0) throw new Error('no rows returned')
      const game: GameData = { ...createGame(key, meta.name, key), draws: outcome.draws }
      setGamesState((s) => ({ games: [...s.games, game], activeId: game.id }))
      setDialog('')
      say(`${meta.name} set up — ${outcome.draws.length.toLocaleString()} official draws loaded.`)
    } catch (err) {
      say(`Could not set up ${meta.name}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSyncing(false)
    }
  }, [gamesState.games, setActiveId, setGamesState, syncGame])

  const addCustomGame = useCallback((openImport: boolean) => {
    const id = `custom-${Date.now()}`
    const game = createGame(id, 'My game')
    setGamesState((s) => ({ games: [...s.games, game], activeId: id }))
    setDialog(openImport ? 'import' : '')
  }, [setGamesState])

  const addSampleGame = useCallback(() => {
    const sample = generateSampleDraws()
    const id = 'sample'
    setGamesState((s) => {
      const without = s.games.filter((g) => g.id !== id)
      return { games: [...without, { ...createGame(id, 'Sample 6/49'), draws: sample }], activeId: id }
    })
    setDialog('')
    say(`Sample game loaded — ${sample.length} synthetic draws with planted patterns.`)
  }, [setGamesState])

  const removeActiveGame = useCallback(() => {
    if (!activeGame) return
    setGamesState((s) => {
      const games2 = s.games.filter((g) => g.id !== activeGame.id)
      return { games: games2, activeId: games2[0]?.id ?? '' }
    })
    setDialog('')
    say(`${activeGame.name} removed.`)
  }, [activeGame, setGamesState])

  const handleImport = useCallback((incoming: Draw[], mode: 'replace' | 'append') => {
    updateActiveDraws((prev) => {
      if (mode === 'replace') return incoming
      const { merged, added, skipped } = mergeDraws(prev, incoming)
      window.setTimeout(() => say(`Appended ${added} draws${skipped ? ` (${skipped} duplicates skipped)` : ''}.`), 0)
      return merged
    })
    if (mode === 'replace') say(`Imported ${incoming.length.toLocaleString()} draws.`)
    setDialog('')
  }, [updateActiveDraws])

  const handleAdd = useCallback((draw: Draw) => {
    updateActiveDraws((prev) => mergeDraws(prev, [draw]).merged)
    setDialog('')
    say(`Added ${draw.date} — model retrained.`)
  }, [updateActiveDraws])

  const handleDelete = useCallback((draw: Draw) => {
    updateActiveDraws((prev) => prev.filter((d) => !(d.date === draw.date && d.sorted.join(',') === draw.sorted.join(','))))
  }, [updateActiveDraws])

  const trimToCurrentEra = useCallback((cutoffDate: string, affected: number) => {
    if (!window.confirm(`Remove the ${affected.toLocaleString()} draws from before ${cutoffDate} (the old number pool)? Export a CSV first if you want a backup.`)) return
    updateActiveDraws((prev) => prev.filter((d) => d.date >= cutoffDate))
    say('Trimmed to the current era — model retrained on the modern pool only.')
  }, [updateActiveDraws])

  const staleDays = activeGame?.syncKey && hasData ? daysSinceLastDraw(activeGame, Date.now()) : 0
  const showStaleNudge = !!activeGame?.syncKey && hasData && staleDays > 4

  return (
    <div className="app">
      <header className="header">
        <div className="container">
          <div className="header-row">
            <div className="brand">
              <span className="brand-mark" aria-hidden="true">
                <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                  <circle cx="15" cy="15" r="13" fill="var(--accent)" />
                  <circle cx="10.5" cy="10.5" r="4.5" fill="rgba(255,255,255,0.28)" />
                  <circle cx="26" cy="25.5" r="8.5" fill="var(--hot)" stroke="var(--page)" strokeWidth="2.5" />
                </svg>
              </span>
              <div>
                <h1>Pattern Lab</h1>
                <span className="sub">number prediction laboratory</span>
              </div>
            </div>
            {games.length > 0 && (
              <div className="game-tabs" role="tablist" aria-label="Games">
                {games.map((g) => (
                  <button
                    key={g.id}
                    role="tab"
                    aria-selected={g.id === activeGame?.id}
                    className={g.id === activeGame?.id ? 'on' : ''}
                    onClick={() => setActiveId(g.id)}
                  >
                    {g.name}
                  </button>
                ))}
                <button className="add" title="Add game" onClick={() => setDialog('addgame')}>+</button>
              </div>
            )}
            <div className="header-actions">
              {activeGame?.syncKey && (
                <button className="btn" onClick={() => void syncGame(activeGame.id)} disabled={syncing} title="Fetch the latest official results">
                  ⟳ Sync
                </button>
              )}
              <button className="btn ghost" onClick={cycleTheme} title="Theme">
                {themeChoice === 'auto' ? '◐ Auto' : themeChoice === 'dark' ? '● Dark' : '○ Light'}
              </button>
              <button className="btn" onClick={() => setDialog('settings')} disabled={!activeGame}>Settings</button>
              <button className="btn" onClick={() => setDialog('import')} disabled={!activeGame}>Import</button>
              <button className="btn primary" onClick={() => setDialog('add')} disabled={!hasData}>+ Add result</button>
            </div>
          </div>
          {hasData && (
            <nav className="nav">
              {NAV.map(([id, label]) => (
                <a key={id} href={`#${id}`}>{label}</a>
              ))}
            </nav>
          )}
        </div>
      </header>

      <main className="main">
        <div className="container">
          {games.length === 0 && (
            <div className="empty-hero">
              <h2>Track your games. Understand every number. Stay honest about the odds.</h2>
              <p>
                Set up Powerball and Mega Millions with one tap — Pattern Lab downloads the full official history, keeps it
                synced, and runs a transparent, self-testing statistical engine over each game separately: rankings,
                calibrated probabilities, backtests, and a reality check that tells you exactly how much (or little) any
                pattern is worth.
              </p>
              <div className="empty-actions">
                {OFFICIAL_GAMES.map((g) => (
                  <button key={g.key} className="btn primary" disabled={syncing} onClick={() => void setupOfficial(g.key)}>
                    ⟳ Set up {g.name}
                  </button>
                ))}
                <button className="btn" onClick={() => addCustomGame(true)}>Import a file</button>
                <button className="btn" onClick={addSampleGame}>Explore with sample data</button>
              </div>
              {syncing && <p style={{ marginTop: 16 }} className="hint">Downloading official history…</p>}
            </div>
          )}

          {games.length > 0 && !hasData && (
            <div className="empty-hero">
              <h2>{activeGame?.name}: no draws yet.</h2>
              <p>Import a file or paste results to start analyzing this game.</p>
              <div className="empty-actions">
                <button className="btn primary" onClick={() => setDialog('import')}>Import results</button>
                <button className="btn danger" onClick={removeActiveGame}>Remove this game</button>
              </div>
            </div>
          )}

          {hasData && result && !result.ok && (
            <div className="grid">
              <div className="card">
                <div className="notice warn">{result.message}</div>
                <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
                  <button className="btn primary" onClick={() => setDialog('import')}>Import more data</button>
                  <button className="btn" onClick={() => setDialog('settings')}>Open settings</button>
                </div>
              </div>
              {draws.length > 0 && <HistoryTable draws={draws} exportName={activeGame?.name ?? 'draws'} onDelete={handleDelete} />}
            </div>
          )}

          {hasData && result?.ok && (
            <div className={`grid ${computing ? 'stale' : ''}`}>
              {showStaleNudge && (
                <div className="notice era-banner">
                  <div className="grow">
                    <strong>New {activeGame!.name} results may be available</strong> — your newest saved draw is{' '}
                    {formatDate(draws[draws.length - 1].date)}.
                  </div>
                  <button className="btn primary" onClick={() => void syncGame(activeGame!.id)} disabled={syncing}>
                    ⟳ Sync now
                  </button>
                </div>
              )}
              {result.eraNotice && (
                <div className="notice warn era-banner">
                  <div className="grow">
                    <strong>Rule change detected:</strong> early draws only reach {result.eraNotice.earlyMax}, but recent ones reach{' '}
                    {result.eraNotice.currentMax} — the game's number pool changed over your history. The{' '}
                    {result.eraNotice.affected.toLocaleString()} old-pool draws bias every frequency stat (that's usually what an
                    inflated "model edge" is). Recommended: keep only draws from {result.eraNotice.cutoffDate} on.
                  </div>
                  <button className="btn primary" onClick={() => trimToCurrentEra(result.eraNotice!.cutoffDate, result.eraNotice!.affected)}>
                    Trim to current era
                  </button>
                </div>
              )}
              <PredictionPanel res={result} />
              <RealityPanel res={result} />
              <RankingTable res={result} />
              <PredictionLog res={result} />
              <TicketLab key={`t-${activeGame?.id}-${result.lastDate}-${result.drawCount}`} res={result} draws={draws} />
              <InspectorPanel key={`i-${activeGame?.id}`} res={result} draws={draws} />
              <HotColdOverdue res={result} />
              <DowPanel res={result} />
              <PairsPanel res={result} />
              <CombosPanel res={result} />
              <TrendsPanel
                res={result}
                settings={settings}
                onWindowChange={(w) => updateActiveSettings({ exploreWindow: w })}
              />
              <SimilarPanel res={result} />
              <BacktestPanel res={result} />
              <HistoryTable draws={draws} exportName={activeGame?.name ?? 'draws'} onDelete={handleDelete} />
            </div>
          )}

          {hasData && !result && (
            <div className="empty-hero">
              <div className="spinner" style={{ margin: '0 auto 14px', width: 26, height: 26 }} />
              <p>Crunching {draws.length.toLocaleString()} draws…</p>
            </div>
          )}
        </div>
      </main>

      <footer className="footer">
        <div className="container">
          <p>
            Pattern Lab finds and honestly weighs historical patterns — the Reality check and Backtest panels show exactly
            how much (or how little) any signal beats chance in your data. Fair lottery draws are random by design: no
            analysis can predict them, and every prediction here is entertainment and statistics, never something to rely
            on. Play only with money you can comfortably lose. If gambling stops feeling like fun, free confidential help
            is available: call or text 1-800-GAMBLER (US). Your data stays in your browser; nothing about you is uploaded.
          </p>
        </div>
      </footer>

      {(computing || syncing) && hasData && (
        <div className="computing"><span className="spinner" /> {syncing ? 'Syncing official results…' : 'Recalculating…'}</div>
      )}
      {flash && !computing && !syncing && (
        <div className="computing">✓ {flash}</div>
      )}

      <ImportDialog
        open={dialog === 'import'}
        onClose={() => setDialog('')}
        hasExisting={hasData}
        expectedSize={settings.drawSize}
        bonusMode={settings.bonus}
        onImport={handleImport}
      />
      <AddResultDialog
        open={dialog === 'add'}
        onClose={() => setDialog('')}
        defaultDate={result?.ok ? result.nextDate : ''}
        poolMax={settings.poolMax > 0 ? settings.poolMax : result?.ok ? result.K : 0}
        drawSize={result?.ok ? result.drawSize : detectedSize}
        hasSpecial={result?.ok ? result.special !== null : detectedSpecialMax > 0}
        specialMax={settings.specialMax > 0 ? settings.specialMax : detectedSpecialMax}
        existingDates={existingDates}
        onAdd={handleAdd}
      />
      <SettingsDialog
        open={dialog === 'settings'}
        onClose={() => setDialog('')}
        settings={settings}
        gameName={activeGame?.name ?? ''}
        detectedPool={detectedPool}
        detectedSize={detectedSize}
        detectedSpecialMax={detectedSpecialMax}
        onSave={(s) => { updateActiveSettings(s); setDialog('') }}
        onClearAll={() => { updateActiveDraws(() => []); setDialog('') }}
        onRemoveGame={removeActiveGame}
      />
      <AddGameDialog
        open={dialog === 'addgame'}
        onClose={() => setDialog('')}
        existingKeys={games.map((g) => g.syncKey).filter((k): k is SyncKey => !!k)}
        busy={syncing}
        onOfficial={(key) => void setupOfficial(key)}
        onImportFile={() => addCustomGame(true)}
        onSample={addSampleGame}
      />
    </div>
  )
}
