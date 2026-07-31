import brandLockup from '../assets/brand-lockup.webp'
import brandLogo from '../assets/brand-logo.webp'

/**
 * The Jerry Pattern Lab brand artwork, used verbatim.
 *
 * `brand-lockup-original.webp` is the owner's file exactly as supplied;
 * `brand-lockup.webp` is those same pixels with the empty transparent margin
 * cropped away so the mark fills its box. `brand-logo.webp` is the earlier
 * square icon composition, still the source of the PWA/home-screen icons.
 * Do not redraw, recreate or substitute any of them.
 */

/**
 * The horizontal lockup: the JP emblem and the wordmark together, as one
 * image. It carries its own type, so the header sets no text beside it. The
 * artwork is built on black with a soft glow, so light mode gives it the dark
 * plaque it was drawn for rather than bleaching it.
 */
export function BrandLockup({ className = '' }: { className?: string }) {
  return <img className={`brand-lockup ${className}`.trim()} src={brandLockup} alt="Jerry Pattern Lab" decoding="async" />
}

/** Full-size brand artwork for the welcome screen. */
export function JerryLockup() {
  return (
    <div className="jerry-lockup">
      <img className="lockup-img" src={brandLockup} alt="Jerry Pattern Lab" decoding="async" />
    </div>
  )
}

/** The square icon composition — same artwork as the installed app icon. */
export function JPMonogram() {
  return (
    <span className="brand-chip" aria-hidden="true">
      <img src={brandLogo} alt="" decoding="async" />
    </span>
  )
}
