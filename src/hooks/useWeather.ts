import { useEffect, useState } from 'react'

export interface Weather {
  tempF: number
  code: number
  isDay: boolean
  place: string
}

/** WMO weather codes, collapsed to the distinctions a one-line chip can carry. */
function describe(code: number, isDay: boolean): { icon: string; label: string } {
  if (code === 0) return { icon: isDay ? '☀' : '☾', label: isDay ? 'Clear' : 'Clear night' }
  if (code <= 2) return { icon: isDay ? '⛅' : '☁', label: 'Partly cloudy' }
  if (code === 3) return { icon: '☁', label: 'Cloudy' }
  if (code <= 48) return { icon: '≈', label: 'Fog' }
  if (code <= 57) return { icon: '☂', label: 'Drizzle' }
  if (code <= 67) return { icon: '☂', label: 'Rain' }
  if (code <= 77) return { icon: '❄', label: 'Snow' }
  if (code <= 82) return { icon: '☂', label: 'Showers' }
  if (code <= 86) return { icon: '❄', label: 'Snow showers' }
  return { icon: '⚡', label: 'Thunderstorm' }
}

export const weatherLook = describe

const CACHE_KEY = 'patternlab.weather.v1'
const FRESH_MS = 20 * 60 * 1000

interface Cached { at: number; lat: number; lon: number; w: Weather }

/**
 * Current conditions where the phone is, for the header chip.
 *
 * Coordinates come from the browser when permission is already granted and
 * from a coarse IP lookup otherwise, so the chip fills in without ever showing
 * a permission prompt on open — `permissions.query` is checked first precisely
 * so an un-granted state falls straight through to the silent path. Results are
 * cached for twenty minutes; every failure is swallowed, because a missing
 * chip is a non-event next to the numbers this app exists for.
 */
export function useWeather(): Weather | null {
  const [weather, setWeather] = useState<Weather | null>(() => {
    try {
      const raw = window.localStorage.getItem(CACHE_KEY)
      if (!raw) return null
      const c = JSON.parse(raw) as Cached
      return c?.w ?? null
    } catch { return null }
  })

  useEffect(() => {
    let live = true
    const cached = (() => {
      try { return JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? 'null') as Cached | null } catch { return null }
    })()
    if (cached && Date.now() - cached.at < FRESH_MS) return

    const fetchAt = async (lat: number, lon: number, place: string) => {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
        + '&current=temperature_2m,weather_code,is_day&temperature_unit=fahrenheit'
      const res = await fetch(url)
      if (!res.ok) return
      const j = await res.json() as { current?: { temperature_2m?: number; weather_code?: number; is_day?: number } }
      const cur = j.current
      if (!cur || typeof cur.temperature_2m !== 'number') return
      const w: Weather = {
        tempF: Math.round(cur.temperature_2m),
        code: cur.weather_code ?? 0,
        isDay: cur.is_day !== 0,
        place,
      }
      if (!live) return
      setWeather(w)
      try { window.localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), lat, lon, w } satisfies Cached)) } catch { /* storage full */ }
    }

    const byIp = async () => {
      try {
        const res = await fetch('https://get.geojs.io/v1/ip/geo.json')
        if (!res.ok) return
        const j = await res.json() as { latitude?: string; longitude?: string; city?: string; region?: string }
        const lat = Number(j.latitude)
        const lon = Number(j.longitude)
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
        await fetchAt(lat, lon, j.city || j.region || '')
      } catch { /* offline, blocked, or rate-limited — the chip just stays hidden */ }
    }

    const run = async () => {
      // Reuse a granted permission silently; never prompt from a header chip.
      try {
        const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName })
        if (status?.state === 'granted' && navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => { void fetchAt(pos.coords.latitude, pos.coords.longitude, cached?.w.place ?? '') },
            () => { void byIp() },
            { timeout: 8000, maximumAge: 15 * 60 * 1000 },
          )
          return
        }
      } catch { /* Safari without the Permissions API falls through */ }
      await byIp()
    }
    void run()
    return () => { live = false }
  }, [])

  return weather
}
