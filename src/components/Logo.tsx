/**
 * The Jerry Pattern Lab monogram: gold J + silver P inside the glowing
 * blue/gold analysis ring. Pure inline SVG so it stays crisp at any size and
 * inherits no font dependencies.
 */
export function JPMonogram({ size = 42 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="jpl-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe08a" />
          <stop offset="0.55" stopColor="#e8a91f" />
          <stop offset="1" stopColor="#b87709" />
        </linearGradient>
        <linearGradient id="jpl-silver" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.6" stopColor="#c9d3e2" />
          <stop offset="1" stopColor="#8e9bb1" />
        </linearGradient>
        <linearGradient id="jpl-ring-blue" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2e7fe8" />
          <stop offset="1" stopColor="#55b0ff" />
        </linearGradient>
        <linearGradient id="jpl-ring-gold" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#d89522" />
          <stop offset="1" stopColor="#f2c155" />
        </linearGradient>
        <filter id="jpl-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
      </defs>
      <defs>
        <radialGradient id="jpl-badge" cx="0.5" cy="0.35" r="0.9">
          <stop offset="0" stopColor="#101d3c" />
          <stop offset="1" stopColor="#070c18" />
        </radialGradient>
      </defs>
      {/* dark badge disc so the mark reads on any surface */}
      <circle cx="50" cy="50" r="48" fill="url(#jpl-badge)" />
      {/* glowing analysis ring: blue base + gold sweep */}
      <circle cx="50" cy="50" r="44" stroke="url(#jpl-ring-blue)" strokeWidth="5" opacity="0.5" filter="url(#jpl-glow)" />
      <circle cx="50" cy="50" r="44" stroke="url(#jpl-ring-blue)" strokeWidth="4.5" />
      <path
        d="M 50 6 A 44 44 0 0 1 93.2 41.5"
        stroke="url(#jpl-ring-gold)"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <circle cx="16.9" cy="76.4" r="3" fill="#f2c155" />
      {/* J */}
      <path
        d="M38.5 26 H47 V59.5 C47 66.8 41.8 72 34.6 72 C28 72 22.9 67.6 22 60.9 L30 59.6 C30.5 62.9 32.3 64.6 34.8 64.6 C37.2 64.6 38.5 62.9 38.5 59.8 Z"
        fill="url(#jpl-gold)"
      />
      {/* P */}
      <path
        fillRule="evenodd"
        d="M53 26 H66.5 C74.5 26 80 31.4 80 39 C80 46.6 74.5 52 66.5 52 H61.5 V72 H53 Z M61.5 33.4 V44.6 H66 C69.8 44.6 72 42.4 72 39 C72 35.6 69.8 33.4 66 33.4 Z"
        fill="url(#jpl-silver)"
      />
    </svg>
  )
}
