import { useEffect, useRef, useState } from 'react'
import type { Draw, EngineResult, Settings } from '../engine/types.ts'
import { runEngine } from '../engine/engine.ts'

/**
 * Runs the engine in a Web Worker so big imports never freeze the UI.
 * The previous result is kept (and shown dimmed) while recomputing.
 */
export function useEngine(draws: Draw[], settings: Settings): { result: EngineResult | null; computing: boolean } {
  const [result, setResult] = useState<EngineResult | null>(null)
  const [computing, setComputing] = useState(false)
  const workerRef = useRef<Worker | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    const seq = ++seqRef.current
    setComputing(true)

    if (!workerRef.current) {
      try {
        workerRef.current = new Worker(new URL('../worker/engine.worker.ts', import.meta.url), { type: 'module' })
      } catch {
        workerRef.current = null
      }
    }

    const worker = workerRef.current
    if (worker) {
      const onMessage = (e: MessageEvent<{ seq: number; result: EngineResult }>) => {
        if (e.data.seq !== seqRef.current) return
        setResult(e.data.result)
        setComputing(false)
      }
      // If the worker script can't load (e.g. the app is opened from file:// or a
      // restrictive host), fall back to computing on the main thread.
      const onError = () => {
        worker.removeEventListener('message', onMessage)
        worker.terminate()
        workerRef.current = null
        if (seq !== seqRef.current) return
        setResult(runEngine(draws, settings))
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
      setResult(runEngine(draws, settings))
      setComputing(false)
    }, 30)
    return () => window.clearTimeout(id)
  }, [draws, settings])

  useEffect(() => () => workerRef.current?.terminate(), [])

  return { result, computing }
}
