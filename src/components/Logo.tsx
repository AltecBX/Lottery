import brandLogo from '../assets/brand-logo.webp'

/**
 * The Jerry Pattern Lab brand artwork, used verbatim everywhere.
 * `src/assets/brand-logo.webp` is the owner's original file, byte-for-byte —
 * do not redraw, recreate or substitute it. The PWA icons in public/ are that
 * same image resampled, nothing else.
 */

/**
 * Compact brand mark for the header — the same artwork, shown whole.
 *
 * It was previously framed on the JP emblem so the detail would read at small
 * sizes, but the emblem's ring runs to the very top of the canvas and the crop
 * sliced through it. The file is already a square, icon-shaped composition on
 * the app's own black, so it is shown complete instead: the same image the
 * home-screen icon uses, uncut.
 */
export function JPMonogram() {
  return (
    <span className="brand-chip" aria-hidden="true">
      <img src={brandLogo} alt="" decoding="async" />
    </span>
  )
}

/** Full-size brand artwork for the welcome screen. */
export function JerryLockup() {
  return (
    <div className="jerry-lockup">
      <img className="lockup-img" src={brandLogo} alt="Jerry Pattern Lab" decoding="async" />
    </div>
  )
}
