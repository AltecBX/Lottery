# Jerry Pattern Lab

A premium, fully client-side quantitative-research app that analyzes a lottery-style draw history (date · day of week · the drawn
numbers — 5- and 6-number games are auto-detected, 4–10 supported, with or without a Powerball-style bonus ball),
discovers the patterns hiding in it, and ranks the most probable numbers for the **next** draw — with every
prediction explained, probability-calibrated, and honestly stress-tested by a walk-forward backtest.

**Track multiple games side by side.** Powerball and Mega Millions set up with one tap — the full official
history downloads automatically from New York State's open-data API, each game keeps its own history, settings,
and model, and a header **⟳ Sync** button (plus a stale-results nudge) pulls new draws whenever you visit.
Custom games (any 4–10 numbers, with or without a bonus ball) can be added from files alongside them.

**The model is always self-testing.** For every draw in your history it re-predicts that draw using only the draws
before it, scores itself against what actually hit, and re-fits its signal weights — so each new result you add
makes the next prediction a little better informed. The Prediction Log panel shows this draw-by-draw record.

Built with React + TypeScript + Vite. All computation runs in your browser (in a Web Worker); your data never
leaves the machine and persists in `localStorage`.

## Running the app

**Easiest — use it as a website (no install).** This repo ships a GitHub Actions workflow that publishes the
app to GitHub Pages on every push to `main`. One-time setup: in the GitHub repo go to **Settings → Pages** and
set **Source** to **GitHub Actions**. After the next push to `main`, the app is live at
`https://<your-username>.github.io/Lottery/` — bookmark it on any device. Your draw data is stored in that
browser's `localStorage`, so it's there every time you come back (per device/browser).

**On your iPhone (recommended).** Open the site in Safari → tap **Share** → **Add to Home Screen**. It installs
like an app with its own icon, launches full-screen, and keeps your games and saved tickets on the phone. The
mobile layout has a bottom action bar (Sync · Add result · Tickets · Menu), bottom-sheet dialogs, and it
auto-checks for new official results when you open the app after a draw day.

**Run locally (for development).** Install [Node.js LTS](https://nodejs.org), then:

```bash
npm install
npm run dev        # development server → http://localhost:5173
npm run build      # production build (output in dist/)
npm run preview    # serve the production build
npm test           # engine test suite (35 tests, incl. leakage guards)
```

The `dist/` folder produced by `npm run build` is plain static files — it can be hosted on any static host
(Netlify, Vercel, an S3 bucket, a shared drive with a web server) with zero configuration.

Once the app is open, either **Import** a CSV/Excel file of past results or click **Explore with sample data**
(715 synthetic draws with deliberately planted patterns, so you can watch the engine find them). After each real
draw, click **+ Add result** — the model retrains instantly.

## Data format

One row per draw — header optional, delimiter auto-detected (comma, tab, semicolon, or `|`):

```
Date       | Day of Week | Number 1 | Number 2 | Number 3 | Number 4 | Number 5 | Number 6
3/30/2026  | Monday      | 9        | 13       | 28       | 45       | 49       | 3
```

- Dates: `M/D/YYYY`, `D/M/YYYY` (auto-detected), `YYYY-MM-DD`, `Mar 30, 2026`, or Excel date cells.
- The Day-of-Week column is optional — it is always re-derived from the date (mismatches are flagged).
- Numbers per draw is auto-detected (the most common count across rows).
- **Powerball-style games**: a trailing bonus column (header like `Pball`/`Bonus`/`Mega Ball`, or values from a
  clearly smaller pool that break the mains' sort order) is detected automatically, analyzed in **its own pool**
  with its own learned model and backtest, and predicted as a separate red ball. Override in Settings if needed.
- Exact duplicate rows are skipped; minority rows with extra columns are trimmed with a warning.
- **Rule changes**: if the number pool visibly grew mid-history (e.g. Powerball's 59→69 change), the app flags it
  and offers a one-click trim to the current era — old-pool draws silently bias every frequency statistic.
- Excel files (`.xlsx`, `.xls`, `.ods`) read the first sheet; CSV/TSV/pasted text also work.
- New results can be added manually ("+ Add result") — the whole model retrains instantly on every change.

## The analysis engine

Twenty-one signals are computed for every number, strictly from data prior to the draw being predicted:

| Family | Signals |
|---|---|
| Frequency | overall frequency · day-of-week frequency · recent form on the target weekday · recency at three time scales (half-lives 8 / 20 / 45) · last 10 / 20 / 50 windows · number-line zones (kernel-smoothed) |
| Gap dynamics | draws since last seen vs own average gap (overdue) · pooled discrete-hazard rate (measured P(hit \| current gap), the statistically honest "overdue") · gap-rhythm/cycle fit |
| Momentum | hot-streak z-score · short-vs-long window momentum · consecutive-appearance streaks |
| Sequence | repeat-from-last-draw probability · follower transitions (P(i next \| j previous)) · day-of-week × previous-draw transitions |
| Structure | positional value distributions · pair co-occurrence lift (used in combos) |
| Analogy | k-nearest similar historical situations (previous draw overlap + weekday + draw shape) and what followed them |
| Machine-learned | an online multinomial-regression combiner (below) whose output joins the ensemble as a signal |

## The prediction engine

- Each signal is z-normalized and combined into a **Predictive Score** by a weighted ensemble.
- **Weights are learned, not assumed**: an online walk-forward pass measures every signal's hit rate above
  chance, and weights follow demonstrated skill (sharpened, floored at zero). A signal must beat chance both
  recently *and* over its lifetime to earn weight, and no concentration happens until the best signal's edge
  clears ~2 standard errors (max-of-many-signals noise ceiling) — on genuinely random data the weights stay
  flat and the app says so. (A per-weekday weight adaptation was evaluated and removed: it added no accuracy
  on structured data and amplified weekday noise streaks on random data; weekday structure lives in the
  per-number signals instead.)
- **A trained regression model sits inside the ensemble**: an online multinomial logistic model (softmax over
  the pool, the drawn numbers as positives) is re-trained after every draw by AdaGrad gradient descent on the
  walk-forward log-likelihood — a proper scoring rule. Unlike the z-score blend, it learns how signals interact
  and how much each one is worth *jointly*. Its logits enter the ensemble as the `mlModel` signal, subject to
  the same significance gate as everything else, and its probability quality is reported as walk-forward
  log-score vs uniform (positive = its probabilities genuinely beat chance on unseen draws; hyperparameters
  were chosen so that on fair random data the score stays ≈ 0 instead of going over-confident).
- **Probabilities are calibrated**: the "estimated probability" for rank *r* is the smoothed, isotonic-regressed
  historical hit rate of rank-*r* predictions in the backtest — not a softmax guess.
- Output: top-5 with confidence levels, top-10 candidates, expandable per-number explanations (signal
  contributions + supporting stats), a best 5-number combination, and ranked alternatives (member strength +
  pair affinity + draw-shape plausibility).

## Backtesting (no future leakage — by construction)

The backtest replays history: to predict draw *t* it uses an incrementally built state containing only draws
`0..t-1` (the test suite mutates the final draw and asserts every earlier prediction is byte-identical).
Tracked: hits in top-5/top-10 per draw, accuracy over time (vs a plain-frequency baseline and the analytic
chance level), accuracy by weekday, per-signal skill, and rank-level calibration. Ensemble weights shown in the
UI are exactly the ones the learning loop produced.

## Honesty note

Fair lottery draws are random by design. Pattern Lab's job is to find whatever structure exists in *your*
data and to report — via the backtest — how much (or how little) each pattern actually predicts. When a signal
shows no edge, its weight is cut to zero and the UI tells you. Treat every prediction as analysis, not certainty.

## Project structure

```
src/
  engine/          pure TypeScript, UI-free, fully testable
    parse.ts       CSV/Excel/pasted-text parsing, validation, merging
    state.ts       incremental history state (counts, gaps, pairs, transitions, …)
    signals.ts     the 16 signals + similarity search
    backtest.ts    walk-forward evaluation, online weight learning, calibration
    predict.ts     live prediction, explanations, confidence
    combos.ts      5-number combination builder
    analytics.ts   descriptive dashboards (hot/cold, pairs, weekdays, trends, …)
    engine.ts      orchestrator
    sample.ts      deterministic sample dataset with planted patterns
  worker/          Web Worker wrapper so recomputes never block the UI
  components/      dashboard panels, charts (hand-rolled SVG), dialogs
  tests/           vitest suite
```
