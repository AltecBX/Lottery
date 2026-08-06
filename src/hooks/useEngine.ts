import { useEffect, useRef, useState } from 'react'
import type { Draw, EngineResult, Settings } from '../engine/types.ts'
import { runEngine } from '../engine/engine.ts'

interface WorkerReply {
  seq: number
  result?: EngineResult
  error?: string
}

/**
 * Runs the engine in a Web Worker so big imports never freeze the UI.
 * The previous result is kept (and shown dimmed) while recomputing.
 */
export function useEngine(draws: Draw[], settings: Settings): {
  result: EngineResult | null
  computing: boolean
  error: string
} {
  const [result, setResult] = useState<EngineResult | null>(null)
  const [computing, setComputing] = useState(false)
  const [error, setError] = useState('')
  const workerRef = useRef<Worker | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    const seq = ++seqRef.current
    setComputing(true)
    setError('')

    /*
     * Replace the worker rather than queue behind it. A worker handles one job
     * at a time, so switching games three times used to run three full
     * backtests end to end — measured at ~1.6s each on a desktop, several times
     * that on a phone — before the screen could update. The superseded result
     * was already being discarded; this stops paying for it.
     */
    if (workerRef.current && seq > 1) {
      workerRef.current.terminate()
      workerRef.current = null
    }
    if (!workerRef.current) {
      try {
        workerRef.current = new Worker(new URL('../worker/engine.worker.ts', import.meta.url), { type: 'module' })
      } catch {
        workerRef.current = null
      }
    }

    const worker = workerRef.current
    if (worker) {
      const onMessage = (e: MessageEvent<WorkerReply>) => {
        if (e.data.seq !== seqRef.current) return
        if (e.data.error !== undefined) {
          setError(e.data.error)
          setComputing(false)
          return
        }
        if (e.data.result) setResult(e.data.result)
        setComputing(false)
      }
      // If the worker script can't load (e.g. the app is opened from file:// or a
      // restrictive host), fall back to computing on the main thread.
      const onError = () => {
        worker.removeEventListener('message', onMessage)
        worker.terminate()
        workerRef.current = null
        if (seq !== seqRef.current) return
        // Guarded: an engine throw here would otherwise escape inside a
        // listener and leave `computing` true forever.
        try {
          setResult(runEngine(draws, settings))
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
        setComputing(false)
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.postMessage({ seq, draws, settings })
      return () => {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
      }
    }

    // Fallback: compute on the main thread (deferred a tick to let the UI paint)
    const id = window.setTimeout(() => {
      if (seq !== seqRef.current) return
      try {
        setResult(runEngine(draws, settings))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      setComputing(false)
    }, 30)
    return () => window.clearTimeout(id)
  }, [draws, settings])

  // Null the ref as well as terminating: React's StrictMode runs every cleanup
  // before re-running the setups, so a kept reference to a dead worker meant the
  // remount posted into a terminated worker and no result ever arrived.
  useEffect(() => () => { workerRef.current?.terminate(); workerRef.current = null }, [])

  return { result, computing, error }
}
