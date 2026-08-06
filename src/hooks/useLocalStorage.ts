import { useCallback, useEffect, useRef, useState } from 'react'

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw !== null) return JSON.parse(raw) as T
    } catch { /* corrupted or unavailable storage falls back to initial */ }
    return initial
  })
  const keyRef = useRef(key)
  keyRef.current = key

  useEffect(() => {
    try {
      window.localStorage.setItem(keyRef.current, JSON.stringify(value))
    } catch { /* storage full/unavailable — keep working in memory */ }
  }, [value])

  /*
   * Adopt writes from other tabs. Every game, draw and saved ticket lives under
   * one key, and the effect above writes the whole snapshot — so without this,
   * a second tab holding an older copy would overwrite a sync done in the first
   * one the moment anything at all changed there, even just switching game tab.
   */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== keyRef.current || e.newValue === null) return
      try { setValue(JSON.parse(e.newValue) as T) } catch { /* ignore a bad write */ }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const set = useCallback((v: T | ((prev: T) => T)) => setValue(v), [])
  return [value, set]
}

export type ThemeChoice = 'auto' | 'light' | 'dark'

export function useTheme(): [ThemeChoice, () => void] {
  const [choice, setChoice] = useLocalStorage<ThemeChoice>('patternlab.theme', 'dark')

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = choice === 'dark' || (choice === 'auto' && mq.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [choice])

  const cycle = useCallback(() => {
    setChoice((c) => (c === 'auto' ? 'dark' : c === 'dark' ? 'light' : 'auto'))
  }, [setChoice])

  return [choice, cycle]
}

/** Measure an element's content width (for pixel-true SVG charts). */
export function useMeasure<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.round(e.contentRect.width))
    })
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}
