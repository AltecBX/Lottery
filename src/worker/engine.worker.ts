import { runEngine } from '../engine/engine.ts'
import type { Draw, Settings } from '../engine/types.ts'

interface Job {
  seq: number
  draws: Draw[]
  settings: Settings
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { seq, draws, settings } = e.data
  const result = runEngine(draws, settings)
  self.postMessage({ seq, result })
}
