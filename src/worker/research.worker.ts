import { runResearch, type ResearchJob } from '../engine/researchjob.ts'

self.onmessage = (e: MessageEvent<{ seq: number; job: ResearchJob }>) => {
  const { seq, job } = e.data
  try {
    self.postMessage({ seq, report: runResearch(job) })
  } catch (err) {
    self.postMessage({ seq, error: err instanceof Error ? err.message : String(err) })
  }
}
