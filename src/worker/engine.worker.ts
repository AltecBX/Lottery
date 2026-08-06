import { runEngine } from '../engine/engine.ts'
import type { Draw, Settings } from '../engine/types.ts'

interface Job {
  seq: number
  draws: Draw[]
  settings: Settings
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { seq, draws, settings } = e.data
  try {
    self.postMessage({ seq, result: runEngine(draws, settings) })
  } catch (err) {
    /*
     * Report the failure rather than letting it escape. An escaped throw fires
     * the host's `error` handler, which retried the same computation on the
     * main thread, threw again inside a listener, and left the app on its
     * loading skeleton with no way out.
     */
    self.postMessage({ seq, error: err instanceof Error ? err.message : String(err) })
  }
}
