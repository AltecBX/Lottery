import brandLogo from '../assets/brand-logo.webp'

/**
 * The Jerry Pattern Lab brand artwork, used verbatim everywhere.
 * `src/assets/brand-logo.webp` is the owner's original file, byte-for-byte —
 * do not redraw, recreate or substitute it. The PWA icons in public/ are that
 * same image resampled, nothing else.
 */

/**
 * Compact brand mark for the header. Same artwork file, framed on the JP
 * emblem — at 42px the full lockup's wordmark and sidebar icons are far below
 * legible size, so the chip shows that detail of the original rather than a
 * shrunken, muddy whole. Nothing is redrawn.
 */
export function JPMonogram() {
  // Framing is percentage-based so the chip fills whatever box it is given.
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
