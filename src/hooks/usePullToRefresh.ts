import { useEffect, useRef, useState } from 'react'

/** How far the finger must travel before the release counts as a refresh. */
const TRIGGER = 68
/** Past the trigger the pull keeps giving, but grudgingly — the usual rubber band. */
const MAX = 110

export interface PullState {
  /** Current pull distance in px, already damped */
  distance: number
  /** True once the pull is far enough that releasing will refresh */
  armed: boolean
  /** True while the refresh itself is running */
  refreshing: boolean
}

/**
 * Pull-to-refresh on the app shell's scroller.
 *
 * The browser's own version only exists on the document scroller and is
 * suppressed by `overscroll-behavior: contain`, which the shell needs, so the
 * gesture is rebuilt here: drag from the very top, feel the resistance, release
 * past the threshold to sync. Vertical intent is required before anything is
 * captured, so a sideways swipe across a table or the nav is never stolen.
 */
export function usePullToRefresh(
  ref: React.RefObject<HTMLElement | null>,
  onRefresh: () => Promise<unknown> | void,
  enabled = true,
): PullState {
  const [state, setState] = useState<PullState>({ distance: 0, armed: false, refreshing: false })
  const cb = useRef(onRefresh)
  cb.current = onRefresh

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    // Only where the shell scroller is live; the desktop window scroller keeps
    // its own behaviour.
    if (getComputedStyle(el).overflowY !== 'auto') return

    let startY = 0
    let startX = 0
    let pulling = false
    let decided = false
    let distance = 0
    let busy = false

    const reset = () => {
      pulling = false
      decided = false
      distance = 0
      setState((s) => (s.distance === 0 && !s.armed ? s : { ...s, distance: 0, armed: false }))
    }

    const onStart = (e: TouchEvent) => {
      if (busy || e.touches.length !== 1 || el.scrollTop > 0) return
      startY = e.touches[0].clientY
      startX = e.touches[0].clientX
      pulling = true
      decided = false
    }

    const onMove = (e: TouchEvent) => {
      if (!pulling || busy) return
      const dy = e.touches[0].clientY - startY
      const dx = e.touches[0].clientX - startX

      if (!decided) {
        // Wait for a clear vertical intent before claiming the gesture
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) { pulling = false; return }
        decided = true
      }
      if (el.scrollTop > 0) { reset(); return }

      // Square-root damping: the first pixels move freely, the last barely
      distance = Math.min(MAX, Math.sqrt(Math.max(0, dy)) * 7)
      if (e.cancelable) e.preventDefault()
      setState((s) => ({ ...s, distance, armed: distance >= TRIGGER }))
    }

    const onEnd = () => {
      if (!pulling) return
      const fire = distance >= TRIGGER
      pulling = false
      decided = false
      if (!fire) { reset(); return }
      busy = true
      setState({ distance: 0, armed: false, refreshing: true })
      const done = () => {
        busy = false
        distance = 0
        setState({ distance: 0, armed: false, refreshing: false })
      }
      // A refresh that never settles must not strand the spinner
      const watchdog = window.setTimeout(done, 20000)
      void Promise.resolve(cb.current())
        .catch(() => { /* the caller reports its own failures */ })
        .finally(() => { window.clearTimeout(watchdog); done() })
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', reset, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', reset)
    }
  }, [ref, enabled])

  return state
}
