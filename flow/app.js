import { AutoMix, smartOrder } from './engine.js'
import { LightShow, findLamps, loadSettings, saveSettings } from './lights.js'

window.__flowBoot = true
const $ = (id) => document.getElementById(id)
const tg = window.Telegram?.WebApp
tg?.ready()
tg?.expand()
tg?.setHeaderColor?.('#0e1016')
tg?.setBackgroundColor?.('#0e1016')
try { tg?.disableVerticalSwipes?.() } catch {}
const initData = tg?.initData || ''
const haptic = (kind = 'light') => { try { tg?.HapticFeedback?.impactOccurred(kind) } catch {} }

const API = new URL('./api/app.php', location.href).href
const AUDIO_CACHE = 'flow-audio-v1'
const MAX_SECONDS = 12 * 60

const state = {
  tracks: [],
  selected: new Set(),
  mode: 'mix',
  smart: true,
  playing: false,
  busy: false,
  nowIndex: -1,
  nextIndex: -1,
  queue: []
}

// ---------- API ----------

async function api(action, params = {}, init = {}) {
  const url = new URL(API)
  url.searchParams.set('a', action)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, { ...init, headers: { 'X-Telegram-Init-Data': initData, ...(init.headers || {}) } })
  if (!res.ok) {
    let message = 'Ошибка сервера ' + res.status
    try { message = (await res.json()).error || message } catch {}
    throw new Error(message)
  }
  return res
}

/** Track audio, cached on the device after the first download. */
async function trackBlob(track) {
  const key = new URL(API)
  key.searchParams.set('a', 'file')
  key.searchParams.set('id', track.id)
  let cache = null
  try { cache = await caches.open(AUDIO_CACHE) } catch {}
  const hit = cache && (await cache.match(key.href))
  if (hit) return hit.blob()
  const res = await api('file', { id: track.id })
  const blob = await res.blob()
  if (cache) { try { await cache.put(key.href, new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg' } })) } catch {} }
  return blob
}

// ---------- Audio graph ----------

let ctx, analyser, engine
function audio() {
  if (ctx) return ctx
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback', sampleRate: 44100 })
  const master = ctx.createGain()
  master.gain.value = 0.9
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -3
  limiter.knee.value = 0
  limiter.ratio.value = 12
  limiter.attack.value = 0.002
  limiter.release.value = 0.12
  analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.75
  master.connect(limiter).connect(analyser).connect(ctx.destination)
  engine = new AutoMix(ctx, master, { load: loadForEngine, separate, onEvent })
  return ctx
}

// ---------- Analysis ----------

const gridKey = (id) => 'flow.grid.' + id
function cachedGrid(id) {
  try { return JSON.parse(localStorage.getItem(gridKey(id)) || 'null') } catch { return null }
}
function storeGrid(id, grid) {
  try { localStorage.setItem(gridKey(id), JSON.stringify(grid)) } catch {}
}

function analyzeGrid(buffer) {
  const n = buffer.length
  const mono = new Float32Array(n)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c)
    for (let i = 0; i < n; i++) mono[i] += ch[i] / buffer.numberOfChannels
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analysis.js', import.meta.url), { type: 'module' })
    const done = (fn, v) => { worker.terminate(); fn(v) }
    worker.onmessage = ({ data }) => (data.error ? done(reject, new Error(data.error)) : done(resolve, data))
    worker.onerror = () => done(reject, new Error('Анализ темпа не запустился'))
    worker.postMessage({ mono, rate: buffer.sampleRate }, [mono.buffer])
  })
}

async function decodeTrack(track) {
  const blob = await trackBlob(track)
  const buffer = await audio().decodeAudioData(await blob.arrayBuffer())
  if (buffer.duration > MAX_SECONDS) throw new Error('Трек длиннее 12 минут — для телефона многовато')
  let grid = cachedGrid(track.id)
  if (!grid) {
    grid = await analyzeGrid(buffer)
    storeGrid(track.id, grid)
    track.bpm = grid.bpm
    renderLibrary()
  }
  return { buffer, grid }
}

async function loadForEngine(track) {
  const { buffer, grid } = await decodeTrack(track)
  if (!grid.bpm) return { buffer, bpm: 100, firstBeat: 0, free: true }
  return { buffer, bpm: grid.bpm, firstBeat: grid.firstBeat }
}

// ---------- Mashup separation (MDX neural net, on the device) ----------

let stems
function wavBlob(buffer) {
  const ch = Math.min(2, buffer.numberOfChannels)
  const n = buffer.length
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2))
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true)
  out.setUint32(24, buffer.sampleRate, true); out.setUint32(28, buffer.sampleRate * ch * 2, true)
  out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * ch * 2, true)
  const data = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c))
  let o = 44
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++, o += 2) {
    const v = Math.max(-1, Math.min(1, data[c][i]))
    out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true)
  }
  return new Blob([out], { type: 'audio/wav' })
}

async function separate(clip, onProgress) {
  stems ||= await import('./stems/flow-mdx-stems.js')
  const result = await stems.separateTwoStem(wavBlob(clip), (p) => onProgress(p?.percent || 0))
  const decode = async (name) => ctx.decodeAudioData(await result.stems.find((s) => s.name === name).blob.arrayBuffer())
  const [vocals, instrumental] = await Promise.all([decode('Vocals'), decode('Instrumental')])
  return { vocals, instrumental }
}

// ---------- Engine events ----------

const KIND = { mix: 'плавный переход', mash: 'мэшап', echo: 'эхо-переход' }
function onEvent(e) {
  if (e.type === 'status') status(e.text)
  if (e.type === 'now') {
    state.nowIndex = e.index
    state.nextIndex = e.index + 1 < state.queue.length ? e.index + 1 : -1
    haptic('soft')
    status('▶ ' + label(state.queue[e.index]))
  }
  if (e.type === 'next') {
    state.nextIndex = e.index
    const inSec = Math.max(0, Math.round(e.plan.at - ctx.currentTime))
    status(`Следующий: ${label(state.queue[e.index])} · ${KIND[e.plan.kind]} через ${fmt(inSec)}`)
  }
  if (e.type === 'skip') status('Пропускаю трек: ' + e.error)
  if (e.type === 'end') { stopSet(); status('Сет закончился 🎉 Собери ещё один!') }
  renderStage()
  renderLibrary()
}

// ---------- Set control ----------

async function startSet() {
  if (state.busy) return
  const chosen = state.tracks.filter((t) => state.selected.has(t.id))
  const list = chosen.length ? chosen : state.tracks
  if (list.length < 1) { status('Сначала пришли боту хотя бы пару треков'); return }
  haptic('medium')
  state.busy = true
  render()
  try {
    await audio().resume()
    let queue = list.slice()
    if (state.smart && queue.length > 2) {
      // Smart order needs every tempo: analyse what we haven't seen yet.
      let i = 0
      for (const t of queue) {
        i++
        const grid = cachedGrid(t.id)
        if (grid) { t.bpm = grid.bpm; continue }
        status(`Слушаю треки, чтобы выстроить сет · ${i}/${queue.length}`)
        const { grid: g } = await decodeTrack(t)
        t.bpm = g.bpm
      }
      const withBeat = queue.filter((t) => t.bpm)
      const free = queue.filter((t) => !t.bpm)
      queue = [...smartOrder(withBeat.sort((a, b) => a.bpm - b.bpm)), ...free]
    }
    state.queue = queue
    state.playing = true
    state.nowIndex = 0
    state.nextIndex = queue.length > 1 ? 1 : -1
    await engine.start(queue, state.mode)
    loop()
  } catch (error) {
    stopSet()
    status(error.message || String(error))
  } finally {
    state.busy = false
    render()
  }
}

function stopSet() {
  engine?.stop()
  state.playing = false
  state.nowIndex = state.nextIndex = -1
  cancelAnimationFrame(raf)
  clearInterval(lightTimer)
  render()
}

// ---------- Visuals & lights ----------

let raf = 0, lightTimer = 0
const freq = new Uint8Array(1024)
const lights = new LightShow(() => settings)
function energy() {
  if (!analyser) return 0
  analyser.getByteFrequencyData(freq)
  let sum = 0
  for (let i = 2; i < 200; i++) sum += freq[i]
  return sum / (198 * 255)
}

function loop() {
  cancelAnimationFrame(raf)
  clearInterval(lightTimer)
  lightTimer = setInterval(() => {
    if (!state.playing) return
    lights.tick(engine.clock(), ctx.currentTime, energy())
  }, 30)
  const canvas = $('viz')
  const g = canvas.getContext('2d')
  const draw = () => {
    if (!state.playing) return
    const dpr = Math.min(2, devicePixelRatio || 1)
    const w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    analyser.getByteFrequencyData(freq)
    g.clearRect(0, 0, w, h)
    const bars = 48
    const bw = w / bars
    const clock = engine.clock()
    const pulse = clock ? Math.max(0, 1 - (clock.nextBeatAt - ctx.currentTime) / clock.beatLen) : 0
    for (let i = 0; i < bars; i++) {
      const idx = Math.floor(Math.pow(i / bars, 1.7) * 400) + 2
      const v = freq[idx] / 255
      const bh = Math.max(2 * dpr, v * h * 0.92)
      const hue = 285 - (i / bars) * 200
      g.fillStyle = `hsla(${hue}, 90%, ${55 + pulse * 10}%, ${0.55 + v * 0.45})`
      const x = i * bw + bw * 0.18
      g.beginPath()
      g.roundRect ? g.roundRect(x, h - bh, bw * 0.64, bh, 3 * dpr) : g.rect(x, h - bh, bw * 0.64, bh)
      g.fill()
    }
    if (clock) {
      $('bpm').textContent = clock.bpm.toFixed(1)
      $('progress').style.width = Math.min(100, (clock.position / clock.duration) * 100) + '%'
      $('time').textContent = fmt(clock.position) + ' / ' + fmt(clock.duration)
      $('beat').dataset.beat = String(((clock.beat % 4) + 4) % 4)
    }
    raf = requestAnimationFrame(draw)
  }
  draw()
}

// ---------- Rendering ----------

const fmt = (s) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many
}
const label = (t) => (t ? (t.artist ? `${t.artist} — ${t.title}` : t.title) : '—')
const status = (text) => { $('status').textContent = text }

function renderStage() {
  const now = state.queue[state.nowIndex]
  const next = state.queue[state.nextIndex]
  $('nowTitle').textContent = now ? now.title : state.tracks.length ? 'Готов к сету' : 'Библиотека пуста'
  $('nowArtist').textContent = now ? now.artist || ' ' : state.tracks.length ? `${state.tracks.length} ${plural(state.tracks.length, 'трек', 'трека', 'треков')} в библиотеке` : 'Пришли треки боту в чат'
  $('nextTitle').textContent = next ? label(next) : '—'
  $('stage').classList.toggle('live', state.playing)
  if (!state.playing) {
    $('bpm').textContent = '—'
    $('progress').style.width = '0%'
    $('time').textContent = '0:00'
  }
}

function render() {
  renderStage()
  renderLibrary()
  const play = $('play')
  play.textContent = state.busy ? 'Готовлю сет…' : state.playing ? '■  Стоп' : '▶  Запустить сет'
  play.classList.toggle('stop', state.playing)
  play.disabled = state.busy
  for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode))
  $('smart').checked = state.smart
  for (const el of document.querySelectorAll('[data-lock]')) el.disabled = state.playing || state.busy
}

function renderLibrary() {
  const list = $('library')
  const n = state.tracks.length
  $('count').textContent = n ? `${state.selected.size || n} из ${n} в сете` : ''
  $('empty').hidden = n > 0
  $('selectAll').hidden = n < 2
  $('selectAll').textContent = state.selected.size && state.selected.size === n ? 'Снять все' : 'Выбрать все'
  list.replaceChildren(...state.tracks.map((t) => {
    const li = document.createElement('li')
    const qi = state.queue.indexOf(t)
    li.className = 'track' + (state.selected.has(t.id) ? ' on' : '') + (state.playing && qi === state.nowIndex ? ' now' : '') + (state.playing && qi === state.nextIndex ? ' next' : '')
    const bpm = t.bpm || cachedGrid(t.id)?.bpm
    li.innerHTML = `<span class="tick" aria-hidden="true"></span><div class="meta"><b></b><small></small></div><span class="bpm"></span><button class="del" aria-label="Удалить">✕</button>`
    li.querySelector('b').textContent = t.title
    li.querySelector('small').textContent = [t.artist, t.duration ? fmt(t.duration) : ''].filter(Boolean).join(' · ')
    li.querySelector('.bpm').textContent = bpm ? Math.round(bpm) + ' BPM' : ''
    li.onclick = (ev) => {
      if (ev.target.closest('.del') || state.playing) return
      haptic('light')
      state.selected.has(t.id) ? state.selected.delete(t.id) : state.selected.add(t.id)
      renderLibrary()
    }
    const del = li.querySelector('.del')
    del.disabled = state.playing
    del.onclick = () => removeTrack(t)
    return li
  }))
}

async function removeTrack(t) {
  const ok = await new Promise((resolve) => (tg?.showConfirm ? tg.showConfirm(`Удалить «${t.title}» из библиотеки?`, resolve) : resolve(confirm('Удалить трек?'))))
  if (!ok) return
  try {
    await api('delete', { id: t.id }, { method: 'POST' })
    state.tracks = state.tracks.filter((x) => x.id !== t.id)
    state.selected.delete(t.id)
    render()
  } catch (error) { status(error.message) }
}

async function loadLibrary() {
  try {
    const data = await (await api('list')).json()
    state.tracks = data.tracks.map((t) => ({ ...t, bpm: cachedGrid(t.id)?.bpm || 0 }))
    for (const id of [...state.selected]) if (!state.tracks.some((t) => t.id === id)) state.selected.delete(id)
    if (data.user?.name) $('hello').textContent = data.user.name
    status(state.tracks.length ? 'Выбери треки или жми «Запустить сет» — сведу всю библиотеку' : '')
  } catch (error) {
    status(error.message)
  }
  render()
}

// ---------- Light settings UI ----------

let settings = loadSettings()
function renderLights(lamps) {
  $('haUrl').value = settings.url
  $('haToken').value = settings.token
  $('lightOn').checked = settings.on
  $('lightMode').value = settings.mode
  if (lamps) {
    $('lamps').replaceChildren(...lamps.map((l) => {
      const row = document.createElement('label')
      row.className = 'lamp'
      row.innerHTML = '<input type="checkbox"><span></span>'
      const box = row.querySelector('input')
      box.checked = settings.lamps.includes(l.id)
      box.onchange = () => {
        settings.lamps = box.checked ? [...new Set([...settings.lamps, l.id])] : settings.lamps.filter((x) => x !== l.id)
        saveSettings(settings)
        $('lightOn').disabled = !settings.lamps.length
      }
      row.querySelector('span').textContent = l.name + (l.color ? '' : ' (без цвета)')
      return row
    }))
  }
  $('lightOn').disabled = !settings.lamps.length
}

$('findLamps').onclick = async () => {
  settings.url = $('haUrl').value.trim()
  settings.token = $('haToken').value.trim()
  saveSettings(settings)
  $('lightStatus').textContent = 'Ищу лампы…'
  try {
    const lamps = await findLamps(settings)
    renderLights(lamps)
    $('lightStatus').textContent = lamps.length ? `Нашёл ${lamps.length}. Отметь, какие качать.` : 'Ламп не найдено'
  } catch (error) {
    $('lightStatus').textContent = error.message
  }
}
$('testLamps').onclick = async () => {
  try { await lights.test(); $('lightStatus').textContent = 'Мигнули? Значит всё ок ✨' } catch (e) { $('lightStatus').textContent = e.message }
}
$('lightOn').onchange = () => { settings.on = $('lightOn').checked; saveSettings(settings) }
$('lightMode').onchange = () => { settings.mode = $('lightMode').value; saveSettings(settings) }
$('origin').textContent = location.origin

// ---------- Wire up ----------

$('play').onclick = () => (state.playing ? (stopSet(), status('Сет остановлен')) : startSet())
for (const b of document.querySelectorAll('[data-mode]')) b.onclick = () => { state.mode = b.dataset.mode; haptic(); render() }
$('smart').onchange = () => { state.smart = $('smart').checked }
$('selectAll').onclick = () => {
  if (state.selected.size === state.tracks.length) state.selected.clear()
  else state.tracks.forEach((t) => state.selected.add(t.id))
  renderLibrary()
}
$('refresh').onclick = () => { haptic(); loadLibrary() }
$('toChat').onclick = () => (tg ? tg.close() : null)
document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.playing) loadLibrary() })

renderLights()
if (!initData) {
  $('stage').classList.add('offline')
  status('Открой FLOW через кнопку в Telegram-боте — там твоя библиотека.')
  render()
} else {
  loadLibrary()
}
