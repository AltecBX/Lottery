import type { Draw } from './types.ts'
import type { SavedTicket } from './games.ts'
import { POWERBALL, maxMultiplier, minMultiplier, type GamePricing } from './pricing.ts'

export interface PrizeTier {
  match: number
  withSpecial: boolean
  prize: number
}

/** How one ticket did against one draw. */
export interface TicketGrade {
  mains: number
  specialHit: boolean
  /** Dollars won. The jackpot uses the draw's advertised amount when recorded. */
  prize: number
  /** True when the ticket took the top tier */
  jackpot: boolean
  /** "4 + bonus", "3", "no match" */
  label: string
  /** The ticket's own multiplier, when the game has one and it was recorded */
  multiplier?: number
  /**
   * True when the game multiplies every prize and this ticket's multiplier is
   * not recorded: `prize` is then the smallest it can be, and `prizeMax` the
   * most the same match pays.
   */
  prizeIsFloor?: boolean
  prizeMax?: number
}

const tierLabel = (mains: number, specialHit: boolean, drawSize: number): string => {
  if (mains === 0 && !specialHit) return 'no match'
  const parts: string[] = []
  if (mains > 0) parts.push(`${mains} of ${drawSize}`)
  if (specialHit) parts.push('bonus')
  return parts.join(' + ')
}

/**
 * Score a ticket against a draw using the game's published prize table —
 * Powerball's unless told otherwise. Games without a bonus ball simply score no
 * lower tiers, so the grade still reports how many numbers matched.
 */
export function gradeTicket(
  ticket: SavedTicket,
  draw: Draw,
  drawSize: number,
  pricing: GamePricing = POWERBALL,
): TicketGrade {
  const drawn = new Set(draw.sorted)
  let mains = 0
  for (const n of ticket.numbers) if (drawn.has(n)) mains++
  const hasSpecial = draw.special !== undefined && ticket.special !== undefined
  const specialHit = hasSpecial && draw.special === ticket.special

  // A ticket saved without its bonus ball in a bonus-ball game cannot be shown
  // to have won the jackpot, so it grades at the all-mains tier instead — the
  // floor of what is provable, not the ceiling of what is possible.
  const jackpot = mains === drawSize && (draw.special === undefined || specialHit)
  if (jackpot) {
    return {
      mains, specialHit, jackpot: true,
      prize: draw.jackpot ?? 0,
      label: hasSpecial ? `${drawSize} + bonus — jackpot` : `${drawSize} of ${drawSize} — jackpot`,
    }
  }
  const tier = pricing.tiers.find((t) => t.match === mains && t.withSpecial === specialHit)
  const base = tier?.prize ?? 0
  const grade: TicketGrade = { mains, specialHit, jackpot: false, prize: base, label: tierLabel(mains, specialHit, drawSize) }
  if (base === 0 || !pricing.multiplier) return grade
  /*
   * Every prize below the jackpot is multiplied, and the multiplier is the
   * ticket's own — printed at the counter, invisible to a ticket saved before
   * buying. Recorded, the prize is exact. Unrecorded, it is the floor: the
   * same rule this function already applies to a ticket saved without its
   * bonus ball, counting what is provable rather than what is likely.
   */
  const own = ticket.multiplier
  if (own !== undefined && pricing.multiplier.some((m) => m.value === own)) {
    grade.prize = base * own
    grade.multiplier = own
    return grade
  }
  grade.prize = base * minMultiplier(pricing)
  grade.prizeMax = base * maxMultiplier(pricing)
  grade.prizeIsFloor = true
  return grade
}

export interface LedgerRow {
  ticket: SavedTicket
  index: number
  /** The draw this ticket was played for, once it has happened */
  draw: Draw | null
  grade: TicketGrade | null
  /** 'settled' = its draw has happened; 'pending' = still ahead; 'open' = no date attached */
  status: 'settled' | 'pending' | 'open'
  cost: number
}

export interface Ledger {
  rows: LedgerRow[]
  spent: number
  won: number
  net: number
  settled: number
  pending: number
  /** Best result across every settled ticket */
  best: { row: LedgerRow; grade: TicketGrade } | null
  /** Settled winners counted at their floor because their multiplier is not recorded */
  floors: number
}

/**
 * Turn saved tickets into a running account: what each one cost, which draw it
 * was for, what it actually won, and where that leaves you overall.
 *
 * Tickets saved before dates were tracked have no draw attached — they show as
 * `open` and are graded against the most recent draw so they still say
 * something useful, but they never touch the money totals.
 */
export function buildLedger(
  tickets: SavedTicket[],
  draws: Draw[],
  drawSize: number,
  pricing: GamePricing = POWERBALL,
): Ledger {
  const ticketPrice = pricing.price
  const byDate = new Map<string, Draw>()
  for (const d of draws) byDate.set(d.date, d)
  const latest = draws.length > 0 ? draws[draws.length - 1] : null

  const rows: LedgerRow[] = tickets.map((ticket, index) => {
    const cost = ticket.cost ?? ticketPrice
    if (!ticket.forDate) {
      return {
        ticket, index, cost, status: 'open' as const,
        draw: latest,
        grade: latest ? gradeTicket(ticket, latest, drawSize, pricing) : null,
      }
    }
    const draw = byDate.get(ticket.forDate) ?? null
    if (!draw) return { ticket, index, cost, status: 'pending' as const, draw: null, grade: null }
    return { ticket, index, cost, status: 'settled' as const, draw, grade: gradeTicket(ticket, draw, drawSize, pricing) }
  })

  let spent = 0
  let won = 0
  let settled = 0
  let pending = 0
  let best: Ledger['best'] = null
  let floors = 0
  for (const row of rows) {
    if (row.status === 'open') continue
    spent += row.cost
    if (row.status === 'pending') { pending++; continue }
    settled++
    won += row.grade?.prize ?? 0
    if (row.grade?.prizeIsFloor) floors++
    const g = row.grade
    if (g && (!best || g.mains + (g.specialHit ? 0.5 : 0) > best.grade.mains + (best.grade.specialHit ? 0.5 : 0))) {
      best = { row, grade: g }
    }
  }
  return { rows, spent, won, net: won - spent, settled, pending, best, floors }
}
