import { useEffect, useRef, useState } from 'react'
import type { Draw, Settings } from '../engine/types.ts'
import { parseDelimitedText, rowsToDraws, type ParseOutcome } from '../engine/parse.ts'
import { dowOf, DOW_NAMES, formatDate } from '../engine/dates.ts'

function Dialog({ open, onClose, title, children, footer }: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dlg = ref.current
    if (!dlg) return
    if (open && !dlg.open) dlg.showModal()
    if (!open && dlg.open) dlg.close()
  }, [open])
  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose}>
      <div className="dlg-head">
        <h2>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="dlg-body">{children}</div>
      {footer && <div className="dlg-foot">{footer}</div>}
    </dialog>
  )
}

/* ---------------- Import ---------------- */

export function ImportDialog({ open, onClose, hasExisting, onImport }: {
  open: boolean
  onClose: () => void
  hasExisting: boolean
  onImport: (draws: Draw[], mode: 'replace' | 'append') => void
}) {
  const [outcome, setOutcome] = useState<ParseOutcome | null>(null)
  const [fileName, setFileName] = useState('')
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) { setOutcome(null); setFileName(''); setPasted(''); setBusy(false) }
  }, [open])

  const handleFile = async (file: File) => {
    setBusy(true)
    setFileName(file.name)
    try {
      if (/\.(xlsx|xls|xlsm|ods)$/i.test(file.name)) {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
        const sheet = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, raw: true, defval: '' })
        setOutcome(rowsToDraws(rows as (string | number)[][]))
      } else {
        setOutcome(parseDelimitedText(await file.text()))
      }
    } catch (err) {
      setOutcome({ draws: [], errors: [`Could not read the file: ${err instanceof Error ? err.message : String(err)}`], warnings: [] })
    } finally {
      setBusy(false)
    }
  }

  const handlePaste = () => {
    setFileName('pasted text')
    setOutcome(parseDelimitedText(pasted))
  }

  const good = outcome && outcome.draws.length > 0

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import historical results"
      footer={
        <>
          {hasExisting && (
            <button className="btn" disabled={!good} onClick={() => good && onImport(outcome.draws, 'append')}>
              Append to history
            </button>
          )}
          <button className="btn primary" disabled={!good} onClick={() => good && onImport(outcome.draws, 'replace')}>
            {hasExisting ? 'Replace history' : 'Import'}
          </button>
        </>
      }
    >
      <div
        className={`drop-zone ${dragOver ? 'over' : ''}`}
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const f = e.dataTransfer.files?.[0]
          if (f) void handleFile(f)
        }}
      >
        <strong>Drop a CSV or Excel file</strong> — or click to browse.
        <div className="help" style={{ marginTop: 6 }}>
          Expected columns: Date, optional Day of Week, then the 5 numbers. Comma, tab, semicolon or “|” separated. Extra columns are ignored.
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm,.ods"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = '' }}
        />
      </div>

      <div className="field">
        <label>Or paste rows</label>
        <textarea
          rows={4}
          placeholder={'3/30/2026 | Monday | 9 | 13 | 28 | 45 | 51\n4/1/2026 | Wednesday | 2 | 9 | 17 | 33 | 40'}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
        />
        <div>
          <button className="btn sm" disabled={!pasted.trim()} onClick={handlePaste}>Parse pasted text</button>
        </div>
      </div>

      {busy && <p className="hint">Reading {fileName}…</p>}
      {outcome && !busy && (
        <div style={{ display: 'grid', gap: 8 }}>
          <p className="parse-ok">
            ✓ {outcome.draws.length.toLocaleString()} valid draw{outcome.draws.length === 1 ? '' : 's'} found
            {fileName ? ` in ${fileName}` : ''}
            {outcome.draws.length > 0 && ` (${outcome.draws[0].date} → ${outcome.draws[outcome.draws.length - 1].date})`}
          </p>
          {outcome.warnings.length > 0 && (
            <div className="warn-list">{outcome.warnings.slice(0, 5).map((w, i) => <span key={i}>⚠ {w}</span>)}</div>
          )}
          {outcome.errors.length > 0 && (
            <div className="err-list">
              {outcome.errors.slice(0, 8).map((e, i) => <span key={i}>✕ {e}</span>)}
              {outcome.errors.length > 8 && <span>…and {outcome.errors.length - 8} more.</span>}
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}

/* ---------------- Add result ---------------- */

export function AddResultDialog({ open, onClose, defaultDate, poolMax, existingDates, onAdd }: {
  open: boolean
  onClose: () => void
  defaultDate: string
  poolMax: number
  existingDates: Set<string>
  onAdd: (draw: Draw) => void
}) {
  const [date, setDate] = useState(defaultDate)
  const [nums, setNums] = useState<string[]>(['', '', '', '', ''])
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) { setDate(defaultDate); setNums(['', '', '', '', '']); setError('') }
  }, [open, defaultDate])

  const submit = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setError('Pick a valid date.'); return }
    const parsed = nums.map((s) => Number(s.trim()))
    if (parsed.some((n) => !Number.isInteger(n) || n < 1)) { setError('All five numbers must be whole numbers ≥ 1.'); return }
    if (poolMax > 0 && parsed.some((n) => n > poolMax)) { setError(`Numbers must be ≤ ${poolMax} (change "Highest number" in Settings if your game is bigger).`); return }
    if (new Set(parsed).size !== 5) { setError('The five numbers must be different.'); return }
    const draw: Draw = { date, dow: dowOf(date), numbers: parsed, sorted: [...parsed].sort((a, b) => a - b) }
    onAdd(draw)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a result"
      footer={<button className="btn primary" onClick={submit}>Add draw &amp; recalculate</button>}
    >
      <div className="field">
        <label>Draw date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <span className="help">
          {/^\d{4}-\d{2}-\d{2}$/.test(date) && `${DOW_NAMES[dowOf(date)]}, ${formatDate(date)}`}
          {existingDates.has(date) && ' — note: you already have a draw on this date.'}
        </span>
      </div>
      <div className="field">
        <label>The five numbers (any order)</label>
        <div className="num-inputs">
          {nums.map((v, i) => (
            <input
              key={i}
              inputMode="numeric"
              placeholder={`N${i + 1}`}
              value={v}
              onChange={(e) => {
                const next = [...nums]
                next[i] = e.target.value.replace(/[^0-9]/g, '')
                setNums(next)
              }}
            />
          ))}
        </div>
      </div>
      {error && <p style={{ color: 'var(--bad-text)', fontSize: 13 }}>{error}</p>}
    </Dialog>
  )
}

/* ---------------- Settings ---------------- */

export function SettingsDialog({ open, onClose, settings, detectedPool, onSave, onClearAll }: {
  open: boolean
  onClose: () => void
  settings: Settings
  detectedPool: number
  onSave: (s: Settings) => void
  onClearAll: () => void
}) {
  const [poolMax, setPoolMax] = useState('')
  const [nextDate, setNextDate] = useState('')

  useEffect(() => {
    if (open) {
      setPoolMax(settings.poolMax > 0 ? String(settings.poolMax) : '')
      setNextDate(settings.nextDate)
    }
  }, [open, settings])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Settings"
      footer={
        <button
          className="btn primary"
          onClick={() => {
            const pm = poolMax.trim() === '' ? 0 : Number(poolMax)
            onSave({ ...settings, poolMax: Number.isInteger(pm) && pm > 0 ? pm : 0, nextDate: nextDate || '' })
          }}
        >
          Save
        </button>
      }
    >
      <div className="field">
        <label>Highest number in the pool</label>
        <input
          inputMode="numeric"
          placeholder={`auto (detected: ${detectedPool || '—'})`}
          value={poolMax}
          onChange={(e) => setPoolMax(e.target.value.replace(/[^0-9]/g, ''))}
        />
        <span className="help">
          Leave blank to auto-detect from your data. Set it explicitly if the biggest number hasn't been drawn yet (e.g. a 1–56 game where 56 never hit).
        </span>
      </div>
      <div className="field">
        <label>Next draw date override</label>
        <input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
        <span className="help">Leave blank to infer from the game's weekday schedule. {nextDate && <button className="btn ghost sm" onClick={() => setNextDate('')}>clear</button>}</span>
      </div>
      <div className="field">
        <label>Danger zone</label>
        <div>
          <button
            className="btn danger"
            onClick={() => { if (window.confirm('Delete ALL stored draws and start over?')) onClearAll() }}
          >
            Clear all data
          </button>
        </div>
      </div>
    </Dialog>
  )
}
