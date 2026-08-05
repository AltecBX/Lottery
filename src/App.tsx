import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Draw, Settings } from './engine/types.ts'
import { DEFAULT_SETTINGS } from './engine/types.ts'
import { mergeDraws } from './engine/parse.ts'
import { generateSampleDraws } from './engine/sample.ts'
import { attachSales, fetchOfficialResults, fetchSalesByDay, type SyncKey } from './engine/sync.ts'
import {
  createGame, daysSinceLastDraw, migrateLegacy, OFFICIAL_GAMES,
  type GameData, type GamesState, type SavedTicket,
} from './engine/games.ts'
import { formatDate } from './engine/dates.ts'
import { detectEra, drawsForEra } from './engine/era.ts'
import { fetchJackpotFeed, type JackpotFeed } from './engine/feed.ts'
import { useEngine } from './hooks/useEngine.ts'
import { useLocalStorage, useTheme } from './hooks/useLocalStorage.ts'
import { useWeather, weatherLook } from './hooks/useWeather.ts'
import { useServiceWorker } from './hooks/useServiceWorker.ts'
import { usePullToRefresh } from './hooks/usePullToRefresh.ts'
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
import { RepeatsPanel } from './components/RepeatsPanel.tsx'
import { PositionsPanel } from './components/PositionsPanel.tsx'
import { JackpotPanel } from './components/JackpotPanel.tsx'
import { InspectorPanel } from './components/InspectorPanel.tsx'
import { TicketLab } from './components/TicketLab.tsx'
import { PortfolioPanel } from './components/PortfolioPanel.tsx'
import { ConstraintLabPanel } from './components/ConstraintLabPanel.tsx'
import { ValuePanel } from './components/ValuePanel.tsx'
import { RecapBanner } from './components/RecapBanner.tsx'
import { PlayView } from './components/PlayView.tsx'
import { AddResultDialog, ImportDialog, SettingsDialog } from './components/dialogs.tsx'
import { AddGameDialog } from './components/AddGameDialog.tsx'
import { BrandLockup, JerryLockup } from './components/Logo.tsx'

const NAV = [
  ['prediction', 'Prediction'],
  ['value', 'Is it worth it'],
  ['portfolio', 'Play together'],
  ['constraints', 'Constraint Lab'],
  ['ranking', 'Ranking'],
  ['log', 'Prediction log'],
  ['columns', 'Columns'],
  ['repeats', 'Repeats'],
  ['jackpot', 'Jackpot'],
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
const EMPTY_TICKETS: SavedTicket[] = []

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
  const weather = useWeather()
  const [dialog, setDialog] = useState<'' | 'import' | 'add' | 'settings' | 'addgame' | 'menu'>('')
  /*
   * Two faces of one app. "Play" is the phone-first answer to the only daily
   * question — five games for the next draw — and "Lab" is every panel that
   * justifies them. The engine runs identically under both; the split is
   * purely about what greets you.
   */
  const [view, setView] = useLocalStorage<'play' | 'lab'>('patternlab.view.v1', 'play')
  const [pendingJump, setPendingJump] = useState('')
  const jumpToRef = useRef<((id: string) => void) | null>(null)
  const [flash, setFlash] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [activeSection, setActiveSection] = useState('')
  const scrollAreaRef = useRef<HTMLDivElement>(null)

  /**
   * Which element actually scrolls. On a phone the app is a fixed-height shell
   * with one interior scroller, so the bottom bar sits in normal flow beneath
   * it and cannot be moved by Safari's disappearing URL bar. On a desktop the
   * window scrolls as usual and this returns null.
   */
  const getScroller = useCallback((): HTMLElement | null => {
    const el = scrollAreaRef.current
    if (!el) return null
    const oy = window.getComputedStyle(el).overflowY
    return oy === 'auto' || oy === 'scroll' ? el : null
  }, [])

  useEffect(() => {
    if (view !== 'lab' || !pendingJump) return
    const id = pendingJump
    setPendingJump('')
    // Two frames so the lab grid has laid out before the scroll converges
    requestAnimationFrame(() => requestAnimationFrame(() => jumpToRef.current?.(id)))
  }, [view, pendingJump])

  const games = gamesState.games
  const activeGame: GameData | undefined = games.find((g) => g.id === gamesState.activeId) ?? games[0]
  const allDraws = activeGame?.draws ?? EMPTY_DRAWS
  const settings = useMemo(
    () => ({ ...DEFAULT_SETTINGS, ...(activeGame?.settings ?? {}) }),
    [activeGame?.settings],
  )

  // Draws from a superseded rule matrix inflate the pool, and with it the
  // jackpot odds and every frequency stat, so by default only the current era
  // is analyzed. This is a filter, never a delete — the full history stays in
  // storage and Settings switches back to it at any time.
  const era = useMemo(() => detectEra(allDraws), [allDraws])
  const draws = useMemo(() => drawsForEra(allDraws, settings.era, era), [allDraws, settings.era, era])

  const { result, computing } = useEngine(draws, settings)
  // Read inside callbacks that must not re-create themselves on every recompute
  const resultRef = useRef(result)
  resultRef.current = result

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

  /**
   * Ticket sales come from a server-side aggregate that can take ~10s, so it
   * never blocks a results sync — results land first, sales fill in after.
   * Skipped when the newest draw already carries a figure.
   */
  const hydrateSales = useCallback(async (gameId: string, key: SyncKey) => {
    try {
      const sales = await fetchSalesByDay(key)
      if (sales.size === 0) return
      setGamesState((s) => ({
        ...s,
        games: s.games.map((g) => (g.id === gameId ? { ...g, draws: attachSales(g.draws, sales).draws } : g)),
      }))
    } catch { /* sales are optional context — never surface a failure */ }
  }, [setGamesState])

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
      void hydrateSales(gameId, game.syncKey)
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
      void hydrateSales(game.id, key)
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

  const saveTicket = useCallback((ticket: SavedTicket) => {
    setGamesState((s) => {
      const active = s.games.find((x) => x.id === s.activeId) ?? s.games[0]
      if (!active) return s
      const existing = active.savedTickets ?? []
      // Stamp the draw it is played for so the ledger can settle it later
      const stamped: SavedTicket = {
        ...ticket,
        forDate: ticket.forDate ?? resultRef.current?.nextDate,
        savedAt: ticket.savedAt ?? new Date().toISOString(),
      }
      const key = (t: SavedTicket) => `${[...t.numbers].sort((a, b) => a - b).join(',')}|${t.special ?? ''}|${t.forDate ?? ''}`
      if (existing.some((t) => key(t) === key(stamped))) return s
      return {
        ...s,
        games: s.games.map((g) => (g.id === active.id ? { ...g, savedTickets: [...existing, stamped] } : g)),
      }
    })
    say('Ticket saved — it will be checked against every new draw.')
  }, [setGamesState])

  const removeTicket = useCallback((index: number) => {
    setGamesState((s) => {
      const active = s.games.find((x) => x.id === s.activeId) ?? s.games[0]
      if (!active) return s
      return {
        ...s,
        games: s.games.map((g) => (g.id === active.id ? { ...g, savedTickets: (g.savedTickets ?? []).filter((_, i) => i !== index) } : g)),
      }
    })
  }, [setGamesState])

  /** Drag down from the top to sync — the gesture every iOS app answers to. */
  const pull = usePullToRefresh(
    scrollAreaRef,
    async () => { if (activeGame?.syncKey) await syncGame(activeGame.id) },
    !!activeGame?.syncKey && hasData,
  )

  // The advertised jackpots, published next to the app by a scheduled job.
  // Same-origin, so it works on a phone; failure is silent because every panel
  // falls back to projecting the prize from the history it already has.
  const { updateReady, applyUpdate } = useServiceWorker()

  const [feed, setFeed] = useState<JackpotFeed | null>(null)
  useEffect(() => {
    const ctl = new AbortController()
    void fetchJackpotFeed(ctl.signal).then((f) => { if (f) setFeed(f) })
    return () => ctl.abort()
  }, [])

  // Seamless mode: when official games look stale, fetch new results on open
  // (throttled to once per hour; toasts only when something new arrived).
  const syncGameRef = useRef(syncGame)
  syncGameRef.current = syncGame
  useEffect(() => {
    const KEY = 'patternlab.autosync'
    try {
      const last = Number(window.localStorage.getItem(KEY) ?? 0)
      if (Date.now() - last < 60 * 60 * 1000) return
      const stale = gamesState.games.filter((g) => g.syncKey && g.draws.length > 0 && daysSinceLastDraw(g, Date.now()) > 1.2)
      if (stale.length === 0) return
      window.localStorage.setItem(KEY, String(Date.now()))
      void (async () => {
        for (const g of stale) await syncGameRef.current(g.id, true)
      })()
    } catch { /* storage unavailable — skip auto-sync */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setNextJackpot = useCallback((amount: number | null, forDate: string) => {
    if (!activeGame) return
    updateGame(activeGame.id, (g) => {
      const next = { ...g }
      if (amount === null) { delete next.nextJackpot; delete next.nextJackpotFor }
      else { next.nextJackpot = amount; next.nextJackpotFor = forDate }
      return next
    })
  }, [activeGame, updateGame])

  const staleDays = activeGame?.syncKey && hasData ? daysSinceLastDraw(activeGame, Date.now()) : 0
  const showStaleNudge = !!activeGame?.syncKey && hasData && staleDays > 4

  /**
   * Jump to a section, then correct.
   *
   * Offscreen panels are skipped by `content-visibility` and stand in at an
   * estimated height, so a single scroll lands wherever those estimates happen
   * to add up — one jump measured 1,065px short. Each pass renders the panels
   * it brings near the viewport, which replaces estimates with real heights, so
   * repeating until the target sits under the nav converges in two or three
   * frames and reads as one instant move.
   */
  // Keep the latest jumpTo reachable from the view-switch effect above it
  useEffect(() => { jumpToRef.current = jumpTo })

  const goLab = useCallback((section?: string) => {
    setView('lab')
    if (section) setPendingJump(section)
  }, [setView])

  const jumpTo = useCallback((id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    const scroller = getScroller()
    const navBottom = document.querySelector('.nav')?.getBoundingClientRect().bottom ?? 0
    const want = navBottom + 10
    let passes = 0
    let stable = 0
    let cancelled = false
    // A swipe mid-correction must win — never fight the user's thumb
    const abort = () => { cancelled = true }
    window.addEventListener('touchstart', abort, { once: true, passive: true })
    window.addEventListener('wheel', abort, { once: true, passive: true })

    const align = () => {
      if (cancelled) return
      const delta = el.getBoundingClientRect().top - want
      if (Math.abs(delta) > 2) {
        const opts = { top: delta, behavior: 'instant' as ScrollBehavior }
        if (scroller) scroller.scrollBy(opts)
        else window.scrollBy(opts)
        stable = 0
      } else {
        // One good frame proves nothing: panels resolve their real height a
        // frame or two after the scroll that brought them into range.
        stable++
      }
      if (stable < 6 && ++passes < 30) requestAnimationFrame(align)
      else {
        window.removeEventListener('touchstart', abort)
        window.removeEventListener('wheel', abort)
      }
    }
    align()
    setActiveSection(id)
  }, [getScroller])

  // Scrollspy: highlight the section currently in view in the section nav
  useEffect(() => {
    if (!hasData || !result?.ok) return
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) { setActiveSection(e.target.id); break }
        }
      },
      { root: getScroller(), rootMargin: '-18% 0px -72% 0px' },
    )
    for (const [id] of NAV) {
      const el = document.getElementById(id)
      if (el) obs.observe(el)
    }
    return () => obs.disconnect()
  }, [hasData, result, getScroller])

  return (
    <div className="app">
      {/* One scroller under the bar, so the bar is in normal flow and can never drift */}
      <div className="scroll-area" ref={scrollAreaRef}>
      {(pull.distance > 0 || pull.refreshing) && (
        <div
          className={`ptr${pull.armed ? ' armed' : ''}${pull.refreshing ? ' spinning' : ''}`}
          style={{ height: pull.refreshing ? 46 : pull.distance }}
          aria-hidden="true"
        >
          <span className="ptr-mark">{pull.refreshing ? <span className="spinner" /> : '⟳'}</span>
        </div>
      )}
      <header className="header">
        <div className="container">
          <div className="header-row">
            <h1 className="brand">
              <BrandLockup />
            </h1>
            {weather && (
              <div className="wx" title={`${weatherLook(weather.code, weather.isDay).label}${weather.place ? ` in ${weather.place}` : ''}`}>
                <span className="wx-ico" aria-hidden="true">{weatherLook(weather.code, weather.isDay).icon}</span>
                <span className="wx-temp">{weather.tempF}°</span>
                {weather.place && <span className="wx-place">{weather.place}</span>}
              </div>
            )}
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
            {hasData && (
              <div className="view-toggle" role="tablist" aria-label="View">
                <button role="tab" aria-selected={view === 'play'} className={view === 'play' ? 'on' : ''} onClick={() => setView('play')}>Play</button>
                <button role="tab" aria-selected={view === 'lab'} className={view === 'lab' ? 'on' : ''} onClick={() => setView('lab')}>Lab</button>
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
          {hasData && view === 'lab' && (
            <nav className="nav">
              {NAV.map(([id, label]) => (
                <a
                  key={id}
                  href={`#${id}`}
                  className={activeSection === id ? 'active' : ''}
                  onClick={(e) => { e.preventDefault(); jumpTo(id) }}
                >
                  {label}
                </a>
              ))}
            </nav>
          )}
        </div>
      </header>

      <main className="main">
        <div className="container">
          {games.length === 0 && (
            <div className="empty-hero">
              <JerryLockup />
              <p>
                Set up Powerball and Mega Millions with one tap — Jerry Pattern Lab downloads the full official history,
                keeps it synced, and runs a transparent, self-testing statistical engine over each game separately:
                rankings, calibrated probabilities, machine-learned signal weights, backtests, and a reality check that
                tells you exactly how much (or little) any pattern is worth.
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

          {hasData && result?.ok && view === 'play' && (
            <div className={`grid play-grid ${computing ? 'stale' : ''}`}>
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
              <RecapBanner
                res={result}
                draws={draws}
                gameId={activeGame?.id ?? ''}
                savedTickets={activeGame?.savedTickets ?? EMPTY_TICKETS}
              />
              <PlayView
                key={`play-${activeGame?.id}-${result.lastDate}`}
                res={result}
                game={activeGame}
                draws={draws}
                drawTime={settings.drawTime}
                feed={feed}
                onSetJackpot={setNextJackpot}
                onSaveTicket={saveTicket}
                onOpenLab={() => goLab()}
              />
            </div>
          )}

          {hasData && result?.ok && view === 'lab' && (
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
              <RecapBanner
                res={result}
                draws={draws}
                gameId={activeGame?.id ?? ''}
                savedTickets={activeGame?.savedTickets ?? EMPTY_TICKETS}
              />
              <PredictionPanel
                res={result}
                gameName={activeGame?.name ?? ''}
                game={activeGame}
                draws={draws}
                drawTime={settings.drawTime}
                feed={feed}
                onSetJackpot={setNextJackpot}
              />
              <ValuePanel res={result} game={activeGame} draws={draws} feed={feed} drawTime={settings.drawTime} />
              <PortfolioPanel
                key={`p-${activeGame?.id}-${result.lastDate}`}
                res={result}
                draws={draws}
                onSaveTicket={saveTicket}
              />
              <ConstraintLabPanel res={result} draws={draws} />
              <RealityPanel res={result} />
              <RankingTable res={result} />
              <PredictionLog res={result} />
              <PositionsPanel res={result} />
              <RepeatsPanel res={result} />
              <JackpotPanel res={result} draws={draws} />
              <TicketLab
                key={`t-${activeGame?.id}-${result.lastDate}-${result.drawCount}`}
                res={result}
                draws={draws}
                savedTickets={activeGame?.savedTickets ?? EMPTY_TICKETS}
                onSaveTicket={saveTicket}
                onRemoveTicket={removeTicket}
              />
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
            <div className="skeleton-grid">
              <div className="skel hero" />
              <div className="skel row" />
              <div className="skel row" />
              <p className="skel-note">Backtesting {draws.length.toLocaleString()} draws — every one re-predicted from scratch…</p>
            </div>
          )}
        </div>
      </main>

      <footer className="footer">
        <div className="container">
          <p>
            Jerry Pattern Lab finds and honestly weighs historical patterns — the Reality check and Backtest panels show
            exactly how much (or how little) any signal beats chance in your data. Fair lottery draws are random by
            design: treat every prediction as statistics, not certainty, and play only with money you can comfortably
            lose. Your data stays in your browser; nothing about you is uploaded.
          </p>
        </div>
      </footer>
      </div>

      {(computing || syncing) && hasData && (
        <div className="computing"><span className="spinner" /> {syncing ? 'Syncing official results…' : 'Recalculating…'}</div>
      )}
      {flash && !computing && !syncing && (
        <div className="computing">✓ {flash}</div>
      )}
      {updateReady && (
        <div className="computing update-toast">
          A new version is ready
          <button className="btn primary sm" onClick={applyUpdate}>Refresh</button>
        </div>
      )}

      <nav className="mobile-bar" aria-label="Quick actions">
        {activeGame?.syncKey ? (
          <button onClick={() => void syncGame(activeGame.id)} disabled={syncing}>
            <span className="ico">⟳</span> Sync
          </button>
        ) : (
          <button onClick={() => setDialog('import')} disabled={!activeGame}>
            <span className="ico">⤒</span> Import
          </button>
        )}
        <button className="primary" onClick={() => setDialog('add')} disabled={!hasData}>
          <span className="ico">＋</span> Add result
        </button>
        <button onClick={() => (view === 'play' ? setView('lab') : setView('play'))} disabled={!hasData}>
          <span className="ico">{view === 'play' ? '🔬' : '▶'}</span> {view === 'play' ? 'Lab' : 'Play'}
        </button>
        <button onClick={() => setDialog('menu')}>
          <span className="ico">☰</span> Menu
        </button>
      </nav>

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
        era={era}
        onSave={(s) => { updateActiveSettings(s); setDialog('') }}
        onClearAll={() => { updateActiveDraws(() => []); setDialog('') }}
        onRemoveGame={removeActiveGame}
      />
      {dialog === 'menu' && (
        <MenuSheet
          onClose={() => setDialog('')}
          themeChoice={themeChoice}
          onTheme={cycleTheme}
          onImport={() => setDialog('import')}
          onAddGame={() => setDialog('addgame')}
          onSettings={() => setDialog('settings')}
          onTickets={() => { setDialog(''); if (view === 'lab') jumpTo('ticket'); else goLab('ticket') }}
          canAct={!!activeGame}
        />
      )}

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


function MenuSheet({ onClose, themeChoice, onTheme, onImport, onAddGame, onSettings, onTickets, canAct }: {
  onClose: () => void
  themeChoice: string
  onTheme: () => void
  onImport: () => void
  onAddGame: () => void
  onSettings: () => void
  onTickets: () => void
  canAct: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dlg = ref.current
    if (dlg && !dlg.open) dlg.showModal()
  }, [])
  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose}>
      <div className="dlg-head">
        <h2>Menu</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="dlg-body menu-sheet">
        <button onClick={onTickets} disabled={!canAct}><span className="ico">🎟</span> Saved tickets</button>
        <button onClick={onImport} disabled={!canAct}><span className="ico">⤒</span> Import results</button>
        <button onClick={onAddGame}><span className="ico">🎲</span> Add a game</button>
        <button onClick={onSettings} disabled={!canAct}><span className="ico">⚙</span> Settings</button>
        <button onClick={onTheme}>
          <span className="ico">◐</span> Theme: {themeChoice === 'auto' ? 'Auto' : themeChoice === 'dark' ? 'Dark' : 'Light'}
        </button>
      </div>
    </dialog>
  )
}
