import { useEffect, useRef } from 'react'
import { OFFICIAL_GAMES } from '../engine/games.ts'
import type { SyncKey } from '../engine/sync.ts'

export function AddGameDialog({ open, onClose, existingKeys, busy, onOfficial, onImportFile, onSample }: {
  open: boolean
  onClose: () => void
  /** Official sync keys already set up (clicking them just switches) */
  existingKeys: SyncKey[]
  busy: boolean
  onOfficial: (key: SyncKey) => void
  onImportFile: () => void
  onSample: () => void
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
        <h2>Add a game</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="dlg-body">
        <div className="field">
          <label>Official games — set up with one tap</label>
          <div style={{ display: 'grid', gap: 10 }}>
            {OFFICIAL_GAMES.map((g) => {
              const exists = existingKeys.includes(g.key)
              return (
                <button key={g.key} className="btn" disabled={busy} onClick={() => onOfficial(g.key)} style={{ justifyContent: 'flex-start', padding: '12px 16px' }}>
                  <span style={{ fontWeight: 650 }}>⟳ {g.name}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>
                    {exists ? 'already set up — switch to it' : 'downloads the full official history automatically'}
                  </span>
                </button>
              )
            })}
          </div>
          {busy && <span className="help">Downloading official history…</span>}
        </div>
        <div className="field">
          <label>Other</label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn" disabled={busy} onClick={onImportFile}>Import a CSV / Excel file</button>
            <button className="btn" disabled={busy} onClick={onSample}>Sample 6-of-49 game</button>
          </div>
          <span className="help">Any 4–10 number game works, with or without a bonus ball.</span>
        </div>
      </div>
    </dialog>
  )
}
