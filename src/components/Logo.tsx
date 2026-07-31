/**
 * Jerry Pattern Lab identity, rebuilt from the brand artwork:
 * a chrome-and-gold JP monogram inside a glowing blue/gold analysis ring,
 * over a deep-space field, with the signature ball row.
 */

function BrandDefs({ id }: { id: string }) {
  return (
    <defs>
      <radialGradient id={`${id}-bg`} cx="0.5" cy="0.34" r="0.95">
        <stop offset="0" stopColor="#122343" />
        <stop offset="0.55" stopColor="#0a1226" />
        <stop offset="1" stopColor="#04070f" />
      </radialGradient>
      <linearGradient id={`${id}-gold`} x1="0.15" y1="0" x2="0.85" y2="1">
        <stop offset="0" stopColor="#fff0b8" />
        <stop offset="0.28" stopColor="#f3c74e" />
        <stop offset="0.6" stopColor="#d99a1d" />
        <stop offset="1" stopColor="#a86f08" />
      </linearGradient>
      <linearGradient id={`${id}-silver`} x1="0.2" y1="0" x2="0.8" y2="1">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.35" stopColor="#e4ebf5" />
        <stop offset="0.62" stopColor="#a9b6ca" />
        <stop offset="1" stopColor="#7c8aa1" />
      </linearGradient>
      <linearGradient id={`${id}-blue`} x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stopColor="#1f6fd8" />
        <stop offset="0.5" stopColor="#3f9bff" />
        <stop offset="1" stopColor="#7cc4ff" />
      </linearGradient>
      <linearGradient id={`${id}-ringgold`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#f6cf62" />
        <stop offset="1" stopColor="#d1901c" />
      </linearGradient>
      <filter id={`${id}-glow`} x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="3.2" />
      </filter>
    </defs>
  )
}

/** The JP monogram inside its ring — the app icon / header mark. */
export function JPMonogram({ size = 42, badge = true, idSuffix = 'm' }: { size?: number; badge?: boolean; idSuffix?: string }) {
  const id = `jpl-${idSuffix}`
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="none" aria-hidden="true">
      <BrandDefs id={id} />
      {badge && <circle cx="60" cy="60" r="59" fill={`url(#${id}-bg)`} />}

      {/* analysis ring: blue orbit with a gold data sweep */}
      <circle cx="60" cy="60" r="50" stroke={`url(#${id}-blue)`} strokeWidth="5" opacity="0.45" filter={`url(#${id}-glow)`} />
      <circle cx="60" cy="60" r="50" stroke={`url(#${id}-blue)`} strokeWidth="3.4" opacity="0.95" />
      <path d="M60 10 A 50 50 0 0 1 105.3 38.6" stroke={`url(#${id}-ringgold)`} strokeWidth="5" strokeLinecap="round" fill="none" />
      <path d="M14.7 38.6 A 50 50 0 0 0 24 91" stroke={`url(#${id}-blue)`} strokeWidth="5" strokeLinecap="round" fill="none" opacity="0.9" />
      <circle cx="105.3" cy="38.6" r="3.4" fill="#f6cf62" />
      <circle cx="24" cy="91" r="2.8" fill="#7cc4ff" />

      {/* JP monogram: gold J left, chrome P right, kissing at the stems.
          Drawn P-then-J so the gold hook reads in front. Group is centered. */}
      <g transform="translate(-13.5 0)">
        <path
          fillRule="evenodd"
          d="M74 30 H91.5 C103 30 110.5 37.6 110.5 48.8 C110.5 60 103 67.6 91.5 67.6 H85.8 V90 H74 Z M85.8 40.4 V57.2 H90.6 C95.9 57.2 99 54 99 48.8 C99 43.6 95.9 40.4 90.6 40.4 Z"
          fill={`url(#${id}-silver)`}
        />
        <path
          d="M63.5 30 H75.5 V72.5 C75.5 84.4 68 92 56.6 92 C46 92 38.4 85.6 37 74.6 L48.4 72.6 C49.2 78.2 52 81.2 56.4 81.2 C60.9 81.2 63.5 78 63.5 72.2 Z"
          fill={`url(#${id}-gold)`}
        />
      </g>
    </svg>
  )
}

/** Full brand lockup for the welcome screen: mark, wordmark, tagline, ball row. */
export function JerryLockup() {
  const id = 'jpl-lock'
  const balls = [9, 13, 28, 45, 51]
  return (
    <div className="jerry-lockup">
      <JPMonogram size={128} idSuffix="lock" />
      <svg viewBox="0 0 340 96" className="lockup-word" role="img" aria-label="Jerry Pattern Lab">
        <BrandDefs id={id} />
        <text
          x="170" y="40" textAnchor="middle"
          fontSize="42" fontWeight="700" letterSpacing="4"
          fontFamily="'Space Grotesk Variable','Space Grotesk',system-ui,sans-serif"
          fill={`url(#${id}-silver)`}
        >
          JERRY
        </text>
        <text
          x="170" y="66" textAnchor="middle"
          fontSize="17" fontWeight="620" letterSpacing="7.5"
          fontFamily="'Space Grotesk Variable','Space Grotesk',system-ui,sans-serif"
          fill={`url(#${id}-gold)`}
        >
          PATTERN LAB
        </text>
        <line x1="46" y1="60" x2="96" y2="60" stroke={`url(#${id}-ringgold)`} strokeWidth="1.6" />
        <line x1="244" y1="60" x2="294" y2="60" stroke={`url(#${id}-ringgold)`} strokeWidth="1.6" />
        <text
          x="170" y="88" textAnchor="middle"
          fontSize="11.5" fontWeight="560" letterSpacing="1.6"
          fontFamily="'Inter Variable','Inter',system-ui,sans-serif"
          fill="#93a3bd"
        >
          FIND THE PATTERNS. TEST THEM HONESTLY.
        </text>
      </svg>
      <div className="lockup-balls" aria-hidden="true">
        {balls.map((n) => <span className="ball sm" key={n}>{n}</span>)}
        <span className="ball sm special">18</span>
      </div>
    </div>
  )
}
