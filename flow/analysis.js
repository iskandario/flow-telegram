// Tempo/beat-grid analysis off the main thread.
import { detectBpm, refineGrid } from './bpm.js?v=20261108-dj1'

self.onmessage = ({ data }) => {
  try {
    const coarse = detectBpm(data.mono, data.rate)
    const grid = coarse.bpm ? refineGrid(data.mono, data.rate, coarse) : coarse
    self.postMessage({ bpm: grid.bpm, firstBeat: grid.firstBeat })
  } catch (error) {
    self.postMessage({ error: String(error && error.message || error) })
  }
}
