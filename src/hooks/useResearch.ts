import { useCallback, useEffect, useRef, useState } from 'react'
import { runResearch, type ResearchJob, type ResearchReport } from '../engine/researchjob.ts'

interface Reply { seq: number; report?: ResearchReport; error?: string }

/**
 * Runs one research job at a time in its own worker, so a replay never holds
 * up the main engine and the main engine never cancels a replay. A new job
 * replaces one still running.
 */
export function useResearch(): {
  run: (job: ResearchJob) => void
  running: boolean
  report: ResearchReport | null
  error: string
} {
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<ResearchReport | null>(null)
  const [error, setError] = useState('')
  const workerRef = useRef<Worker | null>(null)
  const seqRef = useRef(0)

  const run = useCallback((job: ResearchJob) => {
    const seq = ++seqRef.current
    setRunning(true)
    setError('')
    workerRef.current?.terminate()
    workerRef.current = null
    const finish = (r: Reply) => {
      if (r.seq !== seqRef.current) return
      if (r.error !== undefined) setError(r.error)
      else if (r.report) setReport(r.report)
      setRunning(false)
    }
    const inline = () => window.setTimeout(() => {
      try { finish({ seq, report: runResearch(job) }) } catch (err) { finish({ seq, error: err instanceof Error ? err.message : String(err) }) }
    }, 30)
    try {
      const worker = new Worker(new URL('../worker/research.worker.ts', import.meta.url), { type: 'module' })
      workerRef.current = worker
      worker.onmessage = (e: MessageEvent<Reply>) => finish(e.data)
      worker.onerror = () => { worker.terminate(); if (workerRef.current === worker) workerRef.current = null; inline() }
      worker.postMessage({ seq, job })
    } catch {
      inline()
    }
  }, [])

  useEffect(() => () => { workerRef.current?.terminate(); workerRef.current = null }, [])

  return { run, running, report, error }
}
