// FLOW automix engine.
//
// Plays a queue of full-length tracks back to back the way a DJ would:
//  • only the playing and the next track are decoded (phones have little RAM);
//  • the transition starts on a 16-beat phrase, preferably where the outgoing
//    track's energy drops into its outro;
//  • tempos within ±8 % (or half/double) are beat-matched, then the new track
//    glides back to its own tempo over 16 beats;
//  • blends use an equal-power crossfade with a bass swap at the midpoint;
//    tempos that can't be matched get an echo-out instead;
//  • "mashup" lays the outgoing vocal over the incoming instrumental for the
//    whole transition. Only those two short windows go through the neural
//    separator, so it is feasible on a phone.
// Everything is scheduled on the AudioContext clock, so UI hiccups never
// shift the beat.

const PHRASE = 16
const MATCH_LIMIT = 0.08

/** Rate for the incoming track so its beats land on the outgoing grid, or null. */
export function matchRate(playingBpm, incomingBpm) {
  let best = null
  for (const f of [1, 2, 0.5]) {
    const r = (playingBpm * f) / incomingBpm
    if (Math.abs(r - 1) <= MATCH_LIMIT && (!best || Math.abs(r - 1) < Math.abs(best - 1))) best = r
  }
  return best
}

/** Distance between tempos, allowing half/double time (for smart ordering). */
export function tempoDistance(a, b) {
  if (!a || !b) return 1
  // Half/double time mixes fine but feels like a gear change: small penalty.
  return Math.min(...[1, 2, 0.5].map((f) => Math.abs(Math.log((a * f) / b)) + (f === 1 ? 0 : 0.06)))
}

/** Greedy chain: each next track is the closest in tempo to the previous one. */
export function smartOrder(tracks) {
  const rest = tracks.slice()
  if (rest.length < 3) return rest
  const out = [rest.shift()]
  while (rest.length) {
    const last = out[out.length - 1]
    let bi = 0
    rest.forEach((t, i) => { if (tempoDistance(last.bpm, t.bpm) < tempoDistance(last.bpm, rest[bi].bpm)) bi = i })
    out.push(rest.splice(bi, 1)[0])
  }
  return out
}

/** RMS of every bar (4 beats) of the track, from a decimated mono read. */
export function barEnergies(buffer, firstBeat, beat) {
  const data = buffer.getChannelData(0)
  const rate = buffer.sampleRate
  const bar = beat * 4
  const bars = Math.floor((buffer.duration - firstBeat) / bar)
  const out = new Float32Array(Math.max(0, bars))
  for (let b = 0; b < bars; b++) {
    const s = Math.floor((firstBeat + b * bar) * rate)
    const e = Math.min(data.length, Math.floor((firstBeat + (b + 1) * bar) * rate))
    let sum = 0, n = 0
    for (let i = s; i < e; i += 8) { sum += data[i] * data[i]; n++ }
    out[b] = n ? Math.sqrt(sum / n) : 0
  }
  return out
}

/**
 * Where (in buffer seconds) the outgoing transition should begin for a
 * transition of `beats` beats. Phrase-aligned; prefers the start of the outro.
 */
export function planOutro(energies, firstBeat, beat, beats) {
  const nb = energies.length
  const transBars = Math.ceil(beats / 4)
  const latest = nb - transBars - 1
  if (latest < 2) return null
  const phraseBars = PHRASE / 4
  const alignDown = (b) => Math.max(0, b - (b % phraseBars))
  let start = alignDown(latest)
  // Outro: from some point on, every bar stays well below the track's typical level.
  const sorted = Array.from(energies).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] || 0
  for (let k = Math.floor(nb * 0.55); k < latest; k++) {
    let quiet = true
    for (let j = k; j < nb; j++) if (energies[j] > median * 0.72) { quiet = false; break }
    if (quiet) { start = Math.max(alignDown(k), alignDown(Math.floor(nb * 0.5))); break }
  }
  return firstBeat + Math.min(start, alignDown(latest)) * 4 * beat
}

// ---------------------------------------------------------------------------
// Playback timeline of one deck: rate r from t0 until tE, then a linear glide
// to 1.0 over D seconds, then 1.0. posAt/timeAt convert between AudioContext
// time and buffer position (seconds).

function makeTimeline(t0, p0, r, glideStart = null, glide = 0) {
  return { t0, p0, r, tE: glideStart, D: glide }
}

export function posAt(tl, t) {
  if (t <= tl.t0) return tl.p0
  if (tl.tE === null || t <= tl.tE) return tl.p0 + (t - tl.t0) * tl.r
  const pE = tl.p0 + (tl.tE - tl.t0) * tl.r
  const dt = Math.min(t - tl.tE, tl.D)
  const pG = pE + tl.r * dt + ((1 - tl.r) * dt * dt) / (2 * tl.D)
  return t - tl.tE <= tl.D ? pG : pG + (t - tl.tE - tl.D)
}

export function timeAt(tl, p) {
  if (p <= tl.p0) return tl.t0
  if (tl.tE === null) return tl.t0 + (p - tl.p0) / tl.r
  const pE = tl.p0 + (tl.tE - tl.t0) * tl.r
  if (p <= pE) return tl.t0 + (p - tl.p0) / tl.r
  const pR = pE + (tl.D * (tl.r + 1)) / 2
  if (p >= pR) return tl.tE + tl.D + (p - pR)
  // Solve a/2·x² + r·x − (p − pE) = 0 for the glide.
  const a = (1 - tl.r) / tl.D
  const c = p - pE
  if (Math.abs(a) < 1e-9) return tl.tE + c / tl.r
  return tl.tE + (-tl.r + Math.sqrt(tl.r * tl.r + 2 * a * c)) / a
}

/** Playback rate at time t (for the beat clock). */
function rateAt(tl, t) {
  if (tl.tE === null || t <= tl.tE) return tl.r
  if (t >= tl.tE + tl.D) return 1
  return tl.r + ((1 - tl.r) * (t - tl.tE)) / tl.D
}

// ---------------------------------------------------------------------------

/** Copy [from, from+dur) of a buffer into a 44.1 kHz stereo clip for the separator. */
async function clip44(buffer, from, dur) {
  const rate = 44100
  const frames = Math.max(1, Math.ceil(dur * rate))
  const off = new OfflineAudioContext(2, frames, rate)
  const src = off.createBufferSource()
  src.buffer = buffer
  src.connect(off.destination)
  src.start(0, Math.max(0, from), dur)
  return off.startRendering()
}

const curve = (n, fn) => Float32Array.from({ length: n }, (_, i) => fn(i / (n - 1)))
const FADE_OUT = curve(64, (x) => Math.cos((x * Math.PI) / 2))
const FADE_IN = curve(64, (x) => Math.sin((x * Math.PI) / 2))

export class AutoMix {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} out
   * @param {{ load(meta): Promise<{buffer: AudioBuffer, bpm: number, firstBeat: number}>,
   *           separate?(clip: AudioBuffer, onProgress: (p:number)=>void): Promise<{vocals: AudioBuffer, instrumental: AudioBuffer}>,
   *           onEvent(e: object): void }} io
   */
  constructor(ctx, out, io) {
    this.ctx = ctx
    this.out = out
    this.io = io
    this.decks = []
    this.timers = new Set()
    this.running = false
  }

  emit(e) { try { this.io.onEvent(e) } catch (err) { console.error(err) } }

  later(at, fn) {
    const ms = Math.max(0, (at - this.ctx.currentTime) * 1000)
    const id = setTimeout(() => { this.timers.delete(id); if (this.running) fn() }, ms)
    this.timers.add(id)
  }

  /** Start a set. `queue` is a list of track metas; mode is 'mix' | 'mash'. */
  async start(queue, mode) {
    this.stop()
    this.queue = queue
    this.mode = mode
    this.index = 0
    this.running = true
    this.emit({ type: 'status', text: 'Загружаю первый трек…' })
    const first = await this.prepare(0)
    if (!this.running) return
    const t0 = this.ctx.currentTime + 0.15
    const deck = this.play(first, t0, first.firstBeat, makeTimeline(t0, first.firstBeat, 1))
    deck.gain.gain.setValueAtTime(1, t0)
    this.current = deck
    this.emit({ type: 'now', index: 0, deck })
    this.scheduleEnd(deck)
    void this.pipeline()
  }

  stop() {
    this.running = false
    for (const id of this.timers) clearTimeout(id)
    this.timers.clear()
    for (const d of this.decks) this.kill(d)
    this.decks = []
    this.current = null
    this.pendingNext = null
  }

  kill(deck) {
    for (const s of deck.sources) { try { s.stop() } catch {} ; try { s.disconnect() } catch {} }
    for (const n of deck.nodes) { try { n.disconnect() } catch {} }
    deck.sources = []
    deck.buffer = null
  }

  async prepare(index) {
    const meta = this.queue[index]
    const loaded = await this.io.load(meta)
    const beat = 60 / loaded.bpm
    return { index, meta, ...loaded, beat, energies: barEnergies(loaded.buffer, loaded.firstBeat, beat) }
  }

  /** Create a deck: source → low shelf (bass swap) → gain → out. */
  play(track, when, offset, timeline, buffer = track.buffer) {
    const ctx = this.ctx
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.setValueAtTime(timeline.r, when)
    const shelf = ctx.createBiquadFilter()
    shelf.type = 'lowshelf'
    shelf.frequency.value = 220
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, ctx.currentTime)
    source.connect(shelf).connect(gain).connect(this.out)
    source.start(when, Math.max(0, offset))
    const deck = { track, source, shelf, gain, timeline, sources: [source], nodes: [shelf, gain], startedAt: when }
    this.decks.push(deck)
    return deck
  }

  /** If nothing follows, end the set when the track ends. */
  scheduleEnd(deck) {
    const end = timeAt(deck.timeline, deck.track.buffer.duration)
    deck.endsAt = end
    this.later(end + 0.2, () => {
      if (this.current === deck && !this.pendingNext) {
        this.emit({ type: 'end' })
        this.stop()
      }
    })
  }

  /** Load the next track and schedule the transition into it. */
  async pipeline() {
    while (this.running && this.index + 1 < this.queue.length) {
      const from = this.current
      const nextIndex = this.index + 1
      this.emit({ type: 'status', text: 'Готовлю следующий трек…' })
      let next
      try {
        next = await this.prepare(nextIndex)
      } catch (error) {
        this.emit({ type: 'skip', index: nextIndex, error: String(error.message || error) })
        this.queue.splice(nextIndex, 1)
        continue
      }
      if (!this.running || this.current !== from) return
      this.pendingNext = next
      const plan = await this.planTransition(from, next)
      if (!this.running || this.current !== from) return
      const deck = this.transition(from, next, plan)
      this.emit({ type: 'next', index: nextIndex, plan: { kind: plan.kind, at: plan.tA } })
      // Hand over once the blend is finished.
      await new Promise((resolve) => this.later(plan.tE, resolve))
      if (!this.running) return
      this.later(from.releaseAt, () => {
        this.kill(from)
        this.decks = this.decks.filter((d) => d !== from)
      })
      this.current = deck
      this.pendingNext = null
      this.index = nextIndex
      this.emit({ type: 'now', index: nextIndex, deck })
      this.scheduleEnd(deck)
    }
    if (this.running) this.emit({ type: 'status', text: 'Последний трек в сете' })
  }

  async planTransition(from, next) {
    const ctx = this.ctx
    const tl = from.timeline
    // Rate the outgoing deck will be at by its outro (after any glide).
    const fromRate = tl.tE === null ? tl.r : 1
    const playedBpm = from.track.bpm * fromRate
    // Tracks without a steady beat can't be beat-matched: echo out instead.
    const rate = from.track.free || next.free ? null : matchRate(playedBpm, next.bpm)
    const mash = this.mode === 'mash' && rate !== null && !!this.io.separate
    let kind = rate === null ? 'echo' : mash ? 'mash' : 'mix'
    const beats = kind === 'mash' ? 32 : kind === 'mix' ? 16 : 8
    const beatWall = from.track.beat / fromRate
    const outPos = planOutro(from.track.energies, from.track.firstBeat, from.track.beat, beats)
    const margin = 0.6
    let tA = outPos === null ? null : timeAt(tl, outPos)
    let D = beats * beatWall

    // Too late for the planned phrase (slow network) → echo out on the next bar.
    if (tA === null || tA < ctx.currentTime + margin) {
      kind = 'echo'
      D = 8 * beatWall
      const bar = from.track.beat * 4
      const pos = posAt(tl, ctx.currentTime + margin)
      const nextBar = from.track.firstBeat + Math.ceil((pos - from.track.firstBeat) / bar) * bar
      tA = timeAt(tl, nextBar)
      if (tA + D > from.endsAt) {
        tA = Math.max(ctx.currentTime + 0.2, from.endsAt - D)
        D = Math.max(0.4, from.endsAt - tA)
      }
    }
    const r = kind === 'echo' ? 1 : rate
    const plan = { kind, tA, tE: tA + D, D, r, fromRate, outPos: posAt(tl, tA) }

    if (kind === 'mash') {
      // The neural net runs against a deadline: if it can't finish before the
      // phrase, the same moment gets a regular blend instead — never silence.
      const fallback = { ...plan, kind: 'mix' }
      const deadline = tA - 1
      const job = (async () => {
        const progress = (p) => this.emit({ type: 'status', text: `Мэшап: отделяю вокал и бит · ${Math.round(p)}%` })
        const vox = await this.io.separate(await clip44(from.track.buffer, plan.outPos, D * fromRate + 1), (p) => progress(p / 2))
        const ins = await this.io.separate(await clip44(next.buffer, next.firstBeat, D * r + 1), (p) => progress(50 + p / 2))
        return { vocals: vox.vocals, instrumental: ins.instrumental }
      })()
      job.catch((error) => console.warn('separation failed:', error))
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), Math.max(0, (deadline - ctx.currentTime) * 1000)))
      const stems = await Promise.race([job.catch(() => null), timeout])
      if (!this.running) return plan
      if (stems && ctx.currentTime < tA - 0.3) {
        plan.vocals = stems.vocals
        plan.instrumental = stems.instrumental
        return plan
      }
      this.emit({ type: 'status', text: 'Нейросеть не успела к фразе — свожу плавным переходом' })
      return fallback
    }
    return plan
  }

  transition(from, next, plan) {
    const { tA, tE, D, r, kind, fromRate } = plan
    const ctx = this.ctx
    const g = from.gain.gain
    const wallBeat = next.beat / r
    // Glide back to the track's own tempo after the blend — unless the track is
    // so short that its own transition would start mid-glide.
    let glide = r !== 1 ? 16 * wallBeat : 0
    if (glide) {
      const glideEndPos = next.firstBeat + D * r + (glide * (r + 1)) / 2
      const nextOut = planOutro(next.energies, next.firstBeat, next.beat, 32)
      if (nextOut === null || nextOut < glideEndPos + 2 * next.beat) glide = 0
    }
    const timeline = glide ? makeTimeline(tA, next.firstBeat, r, tE, glide) : makeTimeline(tA, next.firstBeat, r)
    const deck = this.play(next, tA, next.firstBeat, timeline)
    if (glide) {
      deck.source.playbackRate.setValueAtTime(r, tE)
      deck.source.playbackRate.linearRampToValueAtTime(1, tE + glide)
    }
    const ng = deck.gain.gain
    from.releaseAt = tE + 0.1

    if (kind === 'echo') {
      // Feedback delay on the outgoing deck; the new track fades in under the echoes.
      const delay = ctx.createDelay(2)
      delay.delayTime.value = Math.min(1.9, (from.track.beat / fromRate) * 0.75)
      const fb = ctx.createGain()
      fb.gain.value = 0.48
      const wet = ctx.createGain()
      wet.gain.setValueAtTime(0, ctx.currentTime) // silent until the transition (default gain is 1)
      wet.gain.setValueAtTime(0, tA)
      wet.gain.linearRampToValueAtTime(0.75, tA + D / 2)
      wet.gain.setValueAtTime(0.75, tE)
      wet.gain.linearRampToValueAtTime(0, tE + 5)
      from.shelf.connect(delay)
      delay.connect(fb).connect(delay)
      delay.connect(wet).connect(this.out)
      from.nodes.push(delay, fb, wet)
      g.setValueAtTime(1, tA + D / 2)
      g.linearRampToValueAtTime(0, tE)
      ng.setValueCurveAtTime(FADE_IN, tA + D / 2, D / 2)
      from.source.stop(tE + 0.05)
      from.releaseAt = tE + 5.2 // let the echo tail ring out
      return deck
    }

    const swap = Math.min(wallBeat, D / 8)

    if (kind === 'mix' || !plan.vocals) {
      // Equal-power blend with a bass swap at the midpoint: one kick at a time.
      const mid = tA + D / 2
      deck.shelf.gain.setValueAtTime(-26, tA)
      deck.shelf.gain.setValueAtTime(-26, mid - swap)
      deck.shelf.gain.linearRampToValueAtTime(0, mid)
      from.shelf.gain.setValueAtTime(0, mid - swap)
      from.shelf.gain.linearRampToValueAtTime(-26, mid)
      g.setValueCurveAtTime(FADE_OUT, tA, D)
      ng.setValueCurveAtTime(FADE_IN, tA, D)
      from.source.stop(tE + 0.05)
      return deck
    }

    // Mashup: the outgoing vocal rides on the incoming instrumental.
    const q = (f) => tA + D * f
    const vox = ctx.createBufferSource()
    vox.buffer = plan.vocals
    vox.playbackRate.value = fromRate
    const voxGain = ctx.createGain()
    voxGain.gain.setValueAtTime(0, ctx.currentTime)
    vox.connect(voxGain).connect(this.out)
    vox.start(tA, 0)
    vox.stop(tE + 0.05)

    const ins = ctx.createBufferSource()
    ins.buffer = plan.instrumental
    ins.playbackRate.value = r
    const insShelf = ctx.createBiquadFilter()
    insShelf.type = 'lowshelf'
    insShelf.frequency.value = 220
    insShelf.gain.setValueAtTime(-26, tA)
    insShelf.gain.setValueAtTime(-26, q(0.4) - swap)
    insShelf.gain.linearRampToValueAtTime(0, q(0.4))
    const insGain = ctx.createGain()
    insGain.gain.setValueAtTime(0, ctx.currentTime)
    ins.connect(insShelf).connect(insGain).connect(this.out)
    ins.start(tA, 0)
    ins.stop(tE + 0.05)
    from.sources.push(vox, ins)
    from.nodes.push(voxGain, insShelf, insGain)

    // 0–25 %: full outgoing track, the new beat creeps in underneath (no bass).
    insGain.gain.setValueCurveAtTime(FADE_IN, tA, D * 0.25)
    // 25–40 %: the outgoing mix hands over to its isolated vocal; new bass enters.
    g.setValueAtTime(1, q(0.25))
    g.linearRampToValueAtTime(0, q(0.4))
    voxGain.gain.setValueAtTime(0, q(0.25))
    voxGain.gain.linearRampToValueAtTime(1, q(0.4))
    // 40–85 %: the mashup. 85–100 %: vocal bows out, instrumental becomes the real track.
    voxGain.gain.setValueAtTime(1, q(0.85))
    voxGain.gain.linearRampToValueAtTime(0, tE)
    insGain.gain.setValueAtTime(1, q(0.85))
    insGain.gain.linearRampToValueAtTime(0, tE)
    ng.setValueAtTime(0, q(0.85))
    ng.linearRampToValueAtTime(1, tE)
    from.source.stop(q(0.4) + 0.05)
    return deck
  }

  /** Beat clock of whatever is audible: {beat, bar, phrase, nextBeatAt, beatLen}. */
  clock() {
    const deck = this.current
    if (!deck || !this.running) return null
    const t = this.ctx.currentTime
    if (t < deck.startedAt) return null
    const tl = deck.timeline
    const { firstBeat, beat } = deck.track
    const pos = posAt(tl, t)
    const n = Math.floor((pos - firstBeat) / beat)
    const nextBeatAt = timeAt(tl, firstBeat + (n + 1) * beat)
    return {
      beat: n,
      bar: Math.floor(n / 4),
      phrase: Math.floor(n / PHRASE),
      nextBeatAt,
      beatLen: beat / rateAt(tl, t),
      position: pos,
      duration: deck.track.buffer.duration,
      bpm: deck.track.bpm * rateAt(tl, t)
    }
  }
}
