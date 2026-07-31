import { useMemo, useState } from 'react'
import type { Draw, EngineResult } from '../engine/types.ts'
import type { SavedTicket } from '../engine/games.ts'
import { formatDate } from '../engine/dates.ts'
import { formatOdds, jackpotOdds } from '../engine/odds.ts'
import { positionalFit, type PositionalFit } from '../engine/positions.ts'
import { SectionCard, Ball, fmtPct } from './shared.tsx'

interface Evaluation {
  numbers: number[]
  special: number | null
  perNumber: { number: number; rank: number; probability: number }[]
  sumVal: number
  sumPercentile: number
  oddCount: number
  oddShare: number
  pairTotal: number
  bestOverlap: number
  bestOverlapDates: string[]
  ge3Count: number
  specialCount: number | null
  posFit: PositionalFit | null
}

/** Score any ticket against the model and the full history. */
export function TicketLab({ res, draws, savedTickets, onSaveTicket, onRemoveTicket }: {
  res: EngineResult
  draws: Draw[]
  savedTickets: SavedTicket[]
  onSaveTicket: (t: SavedTicket) => void
  onRemoveTicket: (index: number) => void
}) {
  const D = res.drawSize
  const hasSpecial = res.special !== null
  const defaults = res.bestCombo?.numbers ?? res.topPick.map((p) => p.number)
  const [nums, setNums] = useState<string[]>(() => defaults.map(String).concat(Array(Math.max(0, D - defaults.length)).fill('')))
  const [special, setSpecial] = useState<string>(res.special ? String(res.special.picks[0]?.number ?? '') : '')
  const [error, setError] = useState('')
  const [evalResult, setEvalResult] = useState<Evaluation | null>(null)

  const rankOf = useMemo(() => new Map(res.predictions.map((p) => [p.number, p])), [res.predictions])
  const latest = draws.length > 0 ? draws[draws.length - 1] : null

  const parseInputs = (): SavedTicket | null => {
    const parsed = nums.map((s) => Number(s.trim()))
    if (parsed.some((n) => !Number.isInteger(n) || n < 1 || n > res.K)) return null
    if (new Set(parsed).size !== D) return null
    const t: SavedTicket = { numbers: [...parsed].sort((a, b) => a - b) }
    if (hasSpecial && special.trim() !== '') {
      const sp = Number(special.trim())
      if (Number.isInteger(sp) && sp >= 1) t.special = sp
    }
    return t
  }

  const saveCurrent = () => {
    const t = parseInputs()
    if (!t) {
      setError(`Enter ${D} valid, different numbers first.`)
      return
    }
    setError('')
    onSaveTicket(t)
  }

  const evaluate = () => {
    const parsed = nums.map((s) => Number(s.trim()))
    if (parsed.some((n) => !Number.isInteger(n) || n < 1 || n > res.K)) {
      setError(`Enter ${D} whole numbers between 1 and ${res.K}.`)
      setEvalResult(null)
      return
    }
    if (new Set(parsed).size !== D) {
      setError('Numbers must all be different.')
      setEvalResult(null)
      return
    }
    let sp: number | null = null
    if (hasSpecial && special.trim() !== '') {
      sp = Number(special.trim())
      if (!Number.isInteger(sp) || sp < 1 || sp > (res.special?.K ?? 99)) {
        setError(`The bonus ball must be between 1 and ${res.special?.K}.`)
        setEvalResult(null)
        return
      }
    }
    setError('')

    const set = new Set(parsed)
    const sumVal = parsed.reduce((a, b) => a + b, 0)
    let sumBelow = 0
    let pairTotal = 0
    let bestOverlap = 0
    let ge3 = 0
    let specialCount = 0
    const overlapDates: Map<number, string[]> = new Map()
    const pairKey = (a: number, b: number) => (a < b ? a * 1000 + b : b * 1000 + a)
    const wanted = new Set<number>()
    for (let i = 0; i < parsed.length; i++)
      for (let j = i + 1; j < parsed.length; j++) wanted.add(pairKey(parsed[i], parsed[j]))
    for (const d of draws) {
      const s = d.sorted.reduce((a, b) => a + b, 0)
      if (s < sumVal) sumBelow++
      let overlap = 0
      for (const n of d.sorted) if (set.has(n)) overlap++
      if (overlap >= 2) {
        for (let i = 0; i < d.sorted.length; i++)
          for (let j = i + 1; j < d.sorted.length; j++)
            if (wanted.has(pairKey(d.sorted[i], d.sorted[j]))) pairTotal++
      }
      if (overlap > bestOverlap) bestOverlap = overlap
      if (overlap >= 3) ge3++
      const list = overlapDates.get(overlap) ?? []
      if (list.length < 3) { list.push(d.date); overlapDates.set(overlap, list) }
      if (sp !== null && d.special === sp) specialCount++
    }
    const oddCount = parsed.filter((n) => n % 2 === 1).length
    const sameOdd = draws.filter((d) => d.sorted.filter((n) => n % 2 === 1).length === oddCount).length

    setEvalResult({
      numbers: [...parsed].sort((a, b) => a - b),
      special: sp,
      perNumber: parsed
        .map((n) => ({ number: n, rank: rankOf.get(n)?.rank ?? res.K, probability: rankOf.get(n)?.probability ?? 0 }))
        .sort((a, b) => a.rank - b.rank),
      sumVal,
      sumPercentile: draws.length ? sumBelow / draws.length : 0,
      oddCount,
      oddShare: draws.length ? sameOdd / draws.length : 0,
      pairTotal,
      bestOverlap,
      bestOverlapDates: overlapDates.get(bestOverlap) ?? [],
      ge3Count: ge3,
      specialCount: sp !== null ? specialCount : null,
      posFit: res.positionAnalysis ? positionalFit(res.positionAnalysis, parsed) : null,
    })
  }

  return (
    <SectionCard
      id="ticket"
      title="Ticket lab"
      className="half"
      sub="Type any ticket to see how it compares statistically — model ranks, shape, and how it would have fared against every draw in your history."
    >
      <div className="num-inputs" style={{ gridTemplateColumns: `repeat(${D}, minmax(0, 1fr))${hasSpecial ? ' 12px minmax(0, 1fr)' : ''}`, alignItems: 'center' }}>
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
        {hasSpecial && <span />}
        {hasSpecial && (
          <input
            inputMode="numeric"
            placeholder="PB"
            value={special}
            onChange={(e) => setSpecial(e.target.value.replace(/[^0-9]/g, ''))}
            style={{ borderColor: 'var(--hot)' }}
          />
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn primary sm" onClick={evaluate}>Evaluate ticket</button>
        <button
          className="btn sm"
          onClick={() => {
            const best = res.bestCombo?.numbers ?? res.topPick.map((p) => p.number)
            setNums(best.map(String))
            if (res.special) setSpecial(String(res.special.picks[0]?.number ?? ''))
          }}
        >
          Use model's pick
        </button>
        <button className="btn sm" onClick={saveCurrent}>☆ Save ticket</button>
      </div>
      {error && <p style={{ color: 'var(--bad-text)', fontSize: 13, marginTop: 8 }}>{error}</p>}

      {evalResult && (
        <div style={{ marginTop: 14, display: 'grid', gap: 12 }}>
          <div className="chip-row">
            {evalResult.perNumber.map((p) => (
              <span className="chip" key={p.number}>
                <Ball n={p.number} size="sm" variant={p.rank <= D ? 'pick' : ''} />
                <span className="meta">rank #{p.rank} · {fmtPct(p.probability)}</span>
              </span>
            ))}
            {evalResult.special !== null && (
              <span className="chip">
                <Ball n={evalResult.special} size="sm" variant="special" />
                <span className="meta">drawn {evalResult.specialCount}× in history</span>
              </span>
            )}
          </div>
          <table className="tbl">
            <tbody>
              <tr>
                <td>Sum {evalResult.sumVal}</td>
                <td className="num">higher than {fmtPct(evalResult.sumPercentile, 0)} of historical draws</td>
              </tr>
              <tr>
                <td>{evalResult.oddCount} odd · {D - evalResult.oddCount} even</td>
                <td className="num">{fmtPct(evalResult.oddShare, 0)} of draws share this split</td>
              </tr>
              <tr>
                <td>Its pairs drawn together</td>
                <td className="num">{evalResult.pairTotal}× total across history</td>
              </tr>
              <tr>
                <td>Closest historical call</td>
                <td className="num">
                  {evalResult.bestOverlap} of {D} matched
                  {evalResult.bestOverlapDates.length > 0 && ` (${formatDate(evalResult.bestOverlapDates[0])})`}
                </td>
              </tr>
              <tr>
                <td>Draws matching 3+ of these</td>
                <td className="num">{evalResult.ge3Count} of {draws.length}</td>
              </tr>
              {evalResult.posFit && (
                <tr>
                  <td>Column shape</td>
                  <td className="num">
                    {evalResult.posFit.impossibleColumns.length > 0 ? (
                      <span style={{ color: 'var(--bad-text)', fontWeight: 640 }}>
                        column {evalResult.posFit.impossibleColumns.join(', ')} outside anything ever drawn
                      </span>
                    ) : (
                      <>{Math.round(evalResult.posFit.plausibility * D)} of {D} columns in their typical range</>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {evalResult.posFit && (
            <div>
              <div className="mini-title">Each number vs that column's own history</div>
              <div className="col-fit-row">
                {evalResult.posFit.perColumn.map((c) => (
                  <div className={`col-fit${c.outOfRange ? ' bad' : ''}`} key={c.position}>
                    <Ball n={c.value} size="sm" variant={c.outOfRange ? 'faded' : ''} />
                    <span className="pct">{fmtPct(c.percentile, 0)}</span>
                    <span className="band">typ. {c.typicalLow}–{c.typicalHigh}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="hint">
            Honest note: every possible ticket has identical jackpot odds
            {res.special ? ` (${formatOdds(jackpotOdds(res.K, D, res.special.K))})` : ''} — this compares statistics, not destiny.
          </p>
        </div>
      )}

      {savedTickets.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="mini-title">
            My saved tickets — checked against the latest draw{latest ? ` (${formatDate(latest.date)})` : ''}
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {savedTickets.map((t, i) => {
              const actual = latest ? new Set(latest.sorted) : new Set<number>()
              const hits = t.numbers.filter((n) => actual.has(n)).length
              const spHit = latest && t.special !== undefined && latest.special === t.special
              return (
                <div className="saved-ticket" key={`${t.numbers.join('-')}|${t.special ?? ''}`}>
                  {t.numbers.map((n) => (
                    <Ball key={n} n={n} size="sm" variant={actual.has(n) ? 'match' : ''} />
                  ))}
                  {t.special !== undefined && (
                    <Ball n={t.special} size="sm" variant={spHit ? 'special' : 'faded'} title="bonus ball" />
                  )}
                  <span className="meta">
                    {latest ? `${hits}/${D} hit${spHit ? ' + bonus!' : ''}` : 'no draws yet'}
                  </span>
                  <button className="btn ghost sm danger" title="Remove ticket" onClick={() => onRemoveTicket(i)}>✕</button>
                </div>
              )
            })}
          </div>
          <p className="hint" style={{ display: 'block', marginTop: 8 }}>
            Saved tickets re-check themselves automatically every time new results sync in.
          </p>
        </div>
      )}
    </SectionCard>
  )
}
