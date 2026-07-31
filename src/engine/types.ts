/** A single historical draw. */
export interface Draw {
  /** ISO date key, e.g. "2026-03-30" */
  date: string
  /** 0 = Sunday … 6 = Saturday (derived from date) */
  dow: number
  /** The main drawn numbers in the order they appear in the source data */
  numbers: number[]
  /** The main drawn numbers sorted ascending */
  sorted: number[]
  /** Bonus/special ball (Powerball-style), drawn from its own pool */
  special?: number
  /** Advertised jackpot for this draw, in dollars (optional — imported or typed) */
  jackpot?: number
  /** Where a jackpot ticket was sold, when this draw had a winner (optional) */
  winnerLocation?: string
  /** Statewide NY ticket sales in dollars for this draw day (synced, optional) */
  sales?: number
}

export interface Settings {
  /** Highest number in the main pool. 0 = auto-detect from data. */
  poolMax: number
  /** Optional override for the next draw date (ISO). Empty = auto from schedule. */
  nextDate: string
  /** Window size for the selectable-window frequency explorer (UI only). */
  exploreWindow: number
  /** Main numbers per draw. 0 = auto-detect from data. */
  drawSize: number
  /** Bonus-ball column handling: auto-detect, force last column, or none. */
  bonus: 'auto' | 'yes' | 'no'
  /** Highest number in the bonus-ball pool. 0 = auto-detect. */
  specialMax: number
}

export const DEFAULT_SETTINGS: Settings = {
  poolMax: 0,
  nextDate: '',
  exploreWindow: 20,
  drawSize: 0,
  bonus: 'auto',
  specialMax: 0,
}

/** One prediction signal's normalized scores plus bookkeeping. */
export interface SignalResult {
  key: string
  /** z-normalized score per number (index 1..K; index 0 unused) */
  z: Float64Array
}

export interface SignalMeta {
  key: string
  label: string
  short: string
  description: string
}

export interface NumberPrediction {
  number: number
  rank: number
  /** Ensemble score (weighted sum of signal z-scores) */
  score: number
  /** Calibrated probability this number appears in the next draw (0..1) */
  probability: number
  /** Signal contributions, sorted by |contribution| descending */
  contributions: { key: string; label: string; contribution: number; reason: string }[]
  /** Human-readable supporting stats */
  stats: NumberStats
  confidence: 'High' | 'Medium' | 'Low'
}

export interface NumberStats {
  number: number
  count: number
  overallRate: number
  expectedRate: number
  last20: number
  drawsSinceSeen: number
  meanGap: number
  gapSd: number
  dowCount: number
  dowRate: number
  dowDraws: number
  streak: number
  maxStreak: number
  repeatRate: number
  momentum: number
  hotZ: number
  overdueRatio: number
}

export interface ComboPrediction {
  numbers: number[]
  score: number
  /** Relative likelihood index, best combo = 100 */
  relative: number
  avgProbability: number
  pairLift: number
  sumZ: number
  notes: string[]
}

export interface SimilarSituation {
  /** Index of the draw that FOLLOWED the similar context */
  index: number
  date: string
  dow: number
  similarity: number
  /** The context draw (previous draw at that moment) */
  contextNumbers: number[]
  /** What actually came next */
  outcome: number[]
  /** Overlap between that outcome and the current top-10 prediction */
  matchesWithPrediction: number[]
}

export interface BacktestPoint {
  index: number
  date: string
  dow: number
  /** Hits inside the model's top-(drawSize) picks for this draw */
  hitsPick: number
  hits10: number
  baselineHitsPick: number
  baselineHits10: number
  /** What the model (using only earlier draws) ranked top-10 for this draw */
  predictedTop: number[]
  /** What was actually drawn */
  actual: number[]
  /** Bonus ball: model's top-3 before the draw (when the game has one) */
  specialTop?: number[]
  /** Bonus ball actually drawn */
  specialActual?: number
}

export interface SignalPerformance {
  key: string
  label: string
  short: string
  description: string
  /** Mean hits in that signal's top-10 across evaluated draws */
  avgHits10: number
  /** avgHits10 minus what pure chance yields */
  skill: number
  /** Learned ensemble weight (0..1, sums to 1) */
  weight: number
  evaluated: number
}

export interface BacktestSummary {
  evaluated: number
  minHistory: number
  /** Chance expectation for hits in a random top-(drawSize) / top-10 */
  chancePick: number
  chance10: number
  ensemblePick: number
  ensemble10: number
  baselinePick: number
  baseline10: number
  /** Percent of evaluated draws where ensemble top-10 caught >= 2 winners */
  ens10AtLeast2: number
  points: BacktestPoint[]
  byDow: { dow: number; draws: number; ensemble10: number; baseline10: number }[]
  signals: SignalPerformance[]
  /** Empirical hit-rate by predicted rank (calibrated, monotone) */
  rankHitRate: number[]
  /**
   * Walk-forward log-likelihood of the learned combiner's probabilities minus
   * pure chance, in nats per draw. Positive = its probabilities genuinely beat
   * uniform on unseen draws; ~0 = no measurable probability skill.
   */
  mlSkillNats?: number
  /** Bonus-ball backtest (present when the game has one) */
  special?: {
    evaluated: number
    /** Rate the actual bonus ball was the model's #1 pick */
    top1: number
    /** Rate the actual bonus ball was in the model's top-3 */
    top3: number
    chance1: number
    chance3: number
  }
}

export interface HotColdEntry {
  number: number
  count20: number
  expected20: number
  z: number
}

export interface OverdueEntry {
  number: number
  drawsSinceSeen: number
  meanGap: number
  ratio: number
}

export interface PairEntry {
  a: number
  b: number
  count: number
  expected: number
  lift: number
}

export interface FollowerEntry {
  from: number
  to: number
  count: number
  opportunities: number
  rate: number
  lift: number
}

export interface DowProfile {
  dow: number
  draws: number
  top: { number: number; count: number; rate: number; lift: number }[]
}

export interface TrendEntry {
  number: number
  rate10: number
  rate50: number
  momentum: number
}

export interface StreakEntry {
  number: number
  streak: number
}

export interface PositionProfile {
  position: number
  min: number
  p25: number
  median: number
  p75: number
  max: number
  histogram: number[]
}

/** The bonus-ball prediction (Powerball-style games). */
export interface SpecialResult {
  /** Highest number in the bonus pool */
  K: number
  /** Ranked candidates with calibrated probabilities */
  picks: { number: number; probability: number; count: number; drawsSinceSeen: number }[]
}

/** A signal actively driving the next prediction. */
export interface DriverEntry {
  key: string
  label: string
  description: string
  weight: number
}

export interface EngineResult {
  ok: boolean
  message?: string
  K: number
  /** Numbers per draw in this dataset */
  drawSize: number
  drawCount: number
  firstDate: string
  lastDate: string
  scheduleDows: number[]
  nextDate: string
  nextDow: number
  /** Whether source rows appear pre-sorted (positions are ranks, not draw order) */
  inputSorted: boolean

  predictions: NumberPrediction[]
  /** The model's actual pick set: top drawSize numbers */
  topPick: NumberPrediction[]
  top10: NumberPrediction[]
  bestCombo: ComboPrediction | null
  altCombos: ComboPrediction[]
  /** Signals driving the next prediction, weekday-adapted, strongest first */
  drivers: DriverEntry[]
  /** True when learned weights differ meaningfully from a uniform blend */
  weightsLearned: boolean
  /** Bonus-ball prediction, when the dataset has one */
  special: SpecialResult | null
  /** Set when the number pool appears to have changed over the history (rule change) */
  eraNotice: { earlyMax: number; currentMax: number; cutoffDate: string; affected: number } | null
  /** Full-history repeat scan (exact + near repeats of winning combinations) */
  repeats: import('./repeats.ts').RepeatAnalysis | null
  /** True when the model's best combination has never been drawn in this history */
  bestComboIsNew: boolean | null
  /** Chi-square verdict on whether each draw weekday has its own number bias */
  weekdayTest: { dow: number; draws: number; chi2: number; dof: number; z: number }[]
  /** Per-column (order-statistic) analysis: each draw column vs its own history */
  positionAnalysis: import('./positions.ts').PositionAnalysis | null
  /** How the best combination's column shape compares to that history */
  bestComboFit: import('./positions.ts').PositionalFit | null

  hot: HotColdEntry[]
  cold: HotColdEntry[]
  overdue: OverdueEntry[]
  pairs: PairEntry[]
  followers: FollowerEntry[]
  dowProfiles: DowProfile[]
  rising: TrendEntry[]
  falling: TrendEntry[]
  streaks: StreakEntry[]
  positions: PositionProfile[]
  similar: SimilarSituation[]

  frequency: { number: number; count: number }[]
  /** frequency inside the user-selected explore window */
  windowFrequency: { number: number; count: number }[]

  backtest: BacktestSummary
  computeMs: number
}
