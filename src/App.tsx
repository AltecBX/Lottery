import { useCallback, useMemo, useState } from 'react'
import type { Draw, Settings } from './engine/types.ts'
import { DEFAULT_SETTINGS } from './engine/types.ts'
import { mergeDraws } from './engine/parse.ts'
import { generateSampleDraws } from './engine/sample.ts'
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
import { AddResultDialog, ImportDialog, SettingsDialog } from './components/dialogs.tsx'

const NAV = [
  ['prediction', 'Prediction'],
  ['ranking', 'Ranking'],
  ['hotcold', 'Hot / Cold'],
  ['dow', 'Weekdays'],
  ['pairs', 'Pairs'],
  ['combos', 'Combos'],
  ['trends', 'Trends'],
  ['similar', 'Similar'],
  ['backtest', 'Backtest'],
  ['history', 'History'],
] as const

export default function App() {
  const [draws, setDraws] = useLocalStorage<Draw[]>('patternlab.draws.v1', [])
  const [settings, setSettings] = useLocalStorage<Settings>('patternlab.settings.v1', DEFAULT_SETTINGS)
  const [themeChoice, cycleTheme] = useTheme()
  const [dialog, setDialog] = useState<'' | 'import' | 'add' | 'settings'>('')
  const [flash, setFlash] = useState('')

  const { result, computing } = useEngine(draws, settings)

  const detectedPool = useMemo(() => {
    let m = 0
    for (const d of draws) for (const n of d.sorted) m = Math.max(m, n)
    return m
  }, [draws])

  const say = (msg: string) => {
    setFlash(msg)
    window.setTimeout(() => setFlash(''), 4200)
  }

  const handleImport = useCallback((incoming: Draw[], mode: 'replace' | 'append') => {
    setDraws((prev) => {
      if (mode === 'replace') return incoming
      const { merged, added, skipped } = mergeDraws(prev, incoming)
      window.setTimeout(() => say(`Appended ${added} draws${skipped ? ` (${skipped} duplicates skipped)` : ''}.`), 0)
      return merged
    })
    if (mode === 'replace') say(`Imported ${incoming.length.toLocaleString()} draws.`)
    setDialog('')
  }, [setDraws])

  const handleAdd = useCallback((draw: Draw) => {
    setDraws((prev) => mergeDraws(prev, [draw]).merged)
    setDialog('')
    say(`Added ${draw.date} — model retrained on ${draws.length + 1} draws.`)
  }, [setDraws, draws.length])

  const handleDelete = useCallback((draw: Draw) => {
    setDraws((prev) => prev.filter((d) => !(d.date === draw.date && d.sorted.join(',') === draw.sorted.join(','))))
  }, [setDraws])

  const loadSample = () => {
    setDraws(generateSampleDraws())
    say('Sample dataset loaded — 715 synthetic draws with planted patterns to explore.')
  }

  const existingDates = useMemo(() => new Set(draws.map((d) => d.date)), [draws])
  const hasData = draws.length > 0

  return (
    <div className="app">
      <header className="header">
        <div className="container">
          <div className="header-row">
            <div className="brand">
              <span className="brand-mark">5</span>
              <div>
                <h1>Pattern Lab</h1>
                <span className="sub">number prediction laboratory</span>
              </div>
            </div>
            <div className="header-actions">
              <button className="btn ghost" onClick={cycleTheme} title="Theme">
                {themeChoice === 'auto' ? '◐ Auto' : themeChoice === 'dark' ? '● Dark' : '○ Light'}
              </button>
              <button className="btn" onClick={() => setDialog('settings')}>Settings</button>
              <button className="btn" onClick={() => setDialog('import')}>Import</button>
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
          {!hasData && (
            <div className="empty-hero">
              <h2>Bring your draw history, get a transparent prediction engine.</h2>
              <p>
                Import a CSV or Excel file of past results (date, day of week, five numbers). Pattern Lab mines frequency,
                recency, gaps, pairs, follower and weekday patterns — then walk-forward backtests every signal and weights
                the ensemble by what has actually predicted well in <em>your</em> data.
              </p>
              <div className="empty-actions">
                <button className="btn primary" onClick={() => setDialog('import')}>Import CSV / Excel</button>
                <button className="btn" onClick={loadSample}>Explore with sample data</button>
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
              {draws.length > 0 && <HistoryTable draws={draws} onDelete={handleDelete} />}
            </div>
          )}

          {hasData && result?.ok && (
            <div className={`grid ${computing ? 'stale' : ''}`}>
              <PredictionPanel res={result} />
              <RankingTable res={result} />
              <HotColdOverdue res={result} />
              <DowPanel res={result} />
              <PairsPanel res={result} />
              <CombosPanel res={result} />
              <TrendsPanel
                res={result}
                settings={settings}
                onWindowChange={(w) => setSettings((s) => ({ ...s, exploreWindow: w }))}
              />
              <SimilarPanel res={result} />
              <BacktestPanel res={result} />
              <HistoryTable draws={draws} onDelete={handleDelete} />
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
            Pattern Lab finds and honestly weighs historical patterns — the backtest panel shows exactly how much (or how
            little) each signal beats chance in your data. Fair lottery draws are random by design: past results can't
            guarantee future ones, so treat predictions as analysis, not certainty. Data stays in your browser
            (localStorage); nothing is uploaded.
          </p>
        </div>
      </footer>

      {computing && hasData && (
        <div className="computing"><span className="spinner" /> Recalculating…</div>
      )}
      {flash && !computing && (
        <div className="computing">✓ {flash}</div>
      )}

      <ImportDialog
        open={dialog === 'import'}
        onClose={() => setDialog('')}
        hasExisting={hasData}
        onImport={handleImport}
      />
      <AddResultDialog
        open={dialog === 'add'}
        onClose={() => setDialog('')}
        defaultDate={result?.ok ? result.nextDate : ''}
        poolMax={settings.poolMax > 0 ? settings.poolMax : result?.ok ? result.K : 0}
        existingDates={existingDates}
        onAdd={handleAdd}
      />
      <SettingsDialog
        open={dialog === 'settings'}
        onClose={() => setDialog('')}
        settings={settings}
        detectedPool={detectedPool}
        onSave={(s) => { setSettings(s); setDialog('') }}
        onClearAll={() => { setDraws([]); setSettings(DEFAULT_SETTINGS); setDialog('') }}
      />
    </div>
  )
}
