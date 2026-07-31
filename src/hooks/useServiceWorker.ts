import { useEffect, useState } from 'react'

/**
 * Register the offline shell and report when a newer build is waiting.
 *
 * Nothing is swapped out underneath a session in progress — a backtest running
 * against thousands of draws should not be interrupted by a deploy. The new
 * worker sits in `waiting` until the update is accepted.
 */
export function useServiceWorker(): { updateReady: boolean; applyUpdate: () => void } {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return
    let cancelled = false

    const watch = (reg: ServiceWorkerRegistration) => {
      if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting)
      reg.addEventListener('updatefound', () => {
        const next = reg.installing
        if (!next) return
        next.addEventListener('statechange', () => {
          // A fresh install with no controller is the very first visit, not an update
          if (next.state === 'installed' && navigator.serviceWorker.controller && !cancelled) setWaiting(next)
        })
      })
    }

    navigator.serviceWorker.register('./sw.js').then(watch).catch(() => { /* offline or unsupported */ })
    return () => { cancelled = true }
  }, [])

  const applyUpdate = () => {
    waiting?.postMessage('skip-waiting')
    // controllerchange fires once the new worker takes over
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true })
  }

  return { updateReady: waiting !== null, applyUpdate }
}
