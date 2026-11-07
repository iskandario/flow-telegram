import { mountDj } from './dj.js?v=20261108-recovery1'
import { localLibrary } from './local-library.js?v=20261108-recovery1'
import { createVkLibrary } from './vk-library.js?v=20261108-recovery1'
import { AutoMix, smartOrder } from './engine.js?v=20261108-recovery1'
import { LightShow, findLamps, loadSettings, saveSettings } from './lights.js?v=20261108-recovery1'

window.__flowBoot = true
const $ = (id) => document.getElementById(id)
const tg = window.Telegram?.WebApp
tg?.ready()
tg?.expand()
tg?.setHeaderColor?.('#0b0b0f')
tg?.setBackgroundColor?.('#0b0b0f')
try { tg?.disableVerticalSwipes?.() } catch {}
const initData = tg?.initData || ''
const haptic = (kind = 'light') => { try { tg?.HapticFeedback?.impactOccurred(kind) } catch {} }

const API = new URL('./api/app.php', location.href).href
let audioCache = null
let deviceLibrary = null
let libraryVisible = 100
let libraryLoading = false
let importingFiles = false
let libraryRequest = 0
const MAX_SECONDS = 12 * 60

const state = {
  tracks: [],
  source: 'all',
  search: '',
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

/** Only the selected mix tracks are decoded; VK audio is not saved for offline use. */
async function trackBlob(track) {
  if (track.source === 'local') {
    const blob = await deviceLibrary?.blob(track.id)
    if (!blob) throw new Error('Файл удалён с устройства. Добавь его снова.')
    return blob
  }
  if (track.source === 'vk') return (await api('file', { id: track.id })).blob()
  const key = new URL(API)
  key.searchParams.set('a', 'file')
  key.searchParams.set('id', track.id)
  let cache = null
  try { if (audioCache) cache = await caches.open(audioCache) } catch {}
  let hit = null
  try { hit = cache && await cache.match(key.href) } catch {}
  if (hit) return hit.blob()
  const res = await api('file', { id: track.id })
  const blob = await res.blob()
  if (cache) { try { await cache.put(key.href, new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg' } })) } catch {} }
  return blob
}

// Ordinary listening does not start analysis, stem models or an offline download.
const listenPanel = document.createElement('section')
listenPanel.className = 'listen-panel'; listenPanel.hidden = true
const listenTitle = document.createElement('p'), listenAudio = document.createElement('audio')
listenAudio.controls = true; listenAudio.preload = 'none'
listenPanel.append(listenTitle, listenAudio); $('library').before(listenPanel)
const libraryMore = document.createElement('button')
libraryMore.className = 'ghost'; libraryMore.id = 'libraryMore'; libraryMore.textContent = 'Показать ещё 100'
$('library').after(libraryMore)
libraryMore.onclick = () => { libraryVisible += 100; renderLibrary() }
let listenObjectUrl = null, listenGeneration = 0
function stopListening() {
  listenGeneration++; listenAudio.pause(); listenAudio.removeAttribute('src'); listenAudio.load()
  if (listenObjectUrl) URL.revokeObjectURL(listenObjectUrl)
  listenObjectUrl = null
}
async function listenTrack(track) {
  if (state.busy) return
  if (state.playing) stopSet()
  dj.stop(true)
  stopListening(); const generation = listenGeneration
  listenPanel.hidden = false; listenTitle.textContent = `${track.artist} — ${track.title}`
  try {
    if (track.source === 'local') {
      const blob = await deviceLibrary.blob(track.id)
      if (generation !== listenGeneration) return
      listenObjectUrl = URL.createObjectURL(blob); listenAudio.src = listenObjectUrl
    } else {
      await api('media-session', {}, { method: 'POST' })
      if (generation !== listenGeneration) return
      const url = new URL(API); url.searchParams.set('a', 'file'); url.searchParams.set('id', track.id)
      listenAudio.src = url.href
    }
    await listenAudio.play().catch(() => status('Нажми ▶ в плеере для воспроизведения'))
  } catch (error) { if (generation === listenGeneration) status(error.message) }
}
listenAudio.onerror = () => status('Не удалось воспроизвести трек. Выбери его ещё раз для обновления ссылки.')

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
    const worker = new Worker(new URL('./analysis.js?v=20261108-recovery1', import.meta.url), { type: 'module' })
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
  stems ||= await import('./stems/flow-mdx-stems.js?v=20261108-recovery1')
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

const dj = mountDj({ root: $('djView'), context: audio, load: decodeTrack, tracks: () => state.tracks, beforePlay: () => { stopListening(); if (state.playing) stopSet() }, message: text => status(text) })

// ---------- Set control ----------

async function startSet() {
  if (state.busy || importingFiles || libraryLoading || vkLibrary.busy) return
  const chosen = state.tracks.filter((t) => state.selected.has(t.id))
  const list = chosen.length ? chosen : state.tracks
  if (list.length < 1) { status('Добавь музыку из VK, с телефона или через бота'); return }
  stopListening()
  dj.stop(true)
  haptic('medium')
  state.busy = true
  render()
  try {
    await audio().resume()
    let queue = list.slice()
    if (state.smart && queue.length > 2) {
      // Never analyse/download a whole library before playback. The engine loads
      // the current and next deck on demand; reorder only already-known tempos.
      for (const t of queue) t.bpm = cachedGrid(t.id)?.bpm || t.bpm || 0
      if (queue.every(t => t.bpm)) queue = smartOrder(queue)
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
  $('nowArtist').textContent = now ? now.artist || ' ' : state.tracks.length ? `${state.tracks.length} ${plural(state.tracks.length, 'трек', 'трека', 'треков')} в библиотеке` : 'Добавь музыку и собери свой первый сет'
  $('nextTitle').textContent = next ? label(next) : '—'
  $('stage').classList.toggle('live', state.playing)
  $('playerState').textContent = state.playing ? 'СЕЙЧАС ИГРАЕТ' : 'ТВОЙ СЛЕДУЮЩИЙ СЕТ'
  $('dockTitle').textContent = now ? now.title : state.selected.size ? `Выбрано треков: ${state.selected.size}` : state.tracks.length ? 'Готов к запуску' : 'Собери свой сет'
  $('dockSubtitle').textContent = now ? now.artist || 'FLOW' : state.mode === 'mash' ? 'Мэшап · вокал + инструментал' : 'Автомикс · плавные переходы'
  $('mashPair').hidden = state.mode !== 'mash'
  $('modeDescription').textContent = state.mode === 'mash' ? 'На переходах вокал одного трека звучит поверх инструментала следующего. Подготовка на телефоне может занять время.' : 'FLOW подбирает переходы, совмещает темп и плавно сводит треки.'
  const chosen = state.tracks.filter(t => state.selected.has(t.id))
  const queue = state.playing ? state.queue : chosen.length ? chosen : state.tracks
  $('mashVocal').textContent = queue[0]?.title || 'Выбери первый трек'
  $('mashBeat').textContent = queue[1]?.title || 'Добавь второй трек'
  $('queueSummary').textContent = queue.length ? `${queue.length} ${plural(queue.length, 'трек', 'трека', 'треков')} · ${fmt(queue.reduce((sum, t) => sum + (t.duration || 0), 0))}` : 'Добавь музыку в библиотеку'
  $('queuePreview').replaceChildren(...queue.slice(0, 5).map((track, index) => {
    const row = document.createElement('li'), number = document.createElement('span'), title = document.createElement('b')
    number.textContent = String(index + 1).padStart(2, '0'); title.textContent = label(track); row.append(number, title); return row
  }))
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
  play.setAttribute('aria-label', state.playing ? 'Остановить сет' : 'Запустить сет')
  play.classList.toggle('stop', state.playing)
  play.disabled = state.busy || importingFiles || libraryLoading || vkLibrary.busy || (!state.playing && !state.tracks.length)
  for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode))
  $('smart').checked = state.smart
  $('refresh').disabled = state.playing || state.busy || libraryLoading || importingFiles || vkLibrary.busy
  for (const button of document.querySelectorAll('[data-source]')) button.setAttribute('aria-pressed', String(button.dataset.source === state.source))
  for (const el of document.querySelectorAll('[data-lock]')) el.disabled = state.playing || state.busy || importingFiles || vkLibrary.busy
}

function renderLibrary() {
  dj.refresh()
  const list = $('library')
  const n = state.tracks.length
  $('count').textContent = n ? `${state.selected.size || n} из ${n} в сете` : ''
  $('empty').hidden = n > 0
  $('selectAll').hidden = n < 2
  $('selectAll').textContent = state.selected.size && state.selected.size === n ? 'Снять все' : 'Выбрать все'
  const search = state.search.toLocaleLowerCase('ru')
  const visible = state.tracks.filter((t) => (state.source === 'all' || (t.source || 'telegram') === state.source) && `${t.title} ${t.artist}`.toLocaleLowerCase('ru').includes(search))
  $('noResults').hidden = !n || visible.length > 0
  libraryMore.hidden = visible.length <= libraryVisible
  list.replaceChildren(...visible.slice(0, libraryVisible).map((t) => {
    const li = document.createElement('li')
    const qi = state.queue.indexOf(t)
    li.className = 'track' + (state.selected.has(t.id) ? ' on' : '') + (state.playing && qi === state.nowIndex ? ' now' : '') + (state.playing && qi === state.nextIndex ? ' next' : '')
    const bpm = t.bpm || cachedGrid(t.id)?.bpm
    li.innerHTML = `<button class="track-select"><span class="tick" aria-hidden="true"></span><span class="meta"><b></b><small></small></span><span class="bpm"></span></button><button class="listen" aria-label="Слушать трек">▶</button><button class="del" aria-label="Удалить">✕</button>`
    li.querySelector('.listen').onclick = () => listenTrack(t)
    const select = li.querySelector('.track-select')
    select.disabled = state.playing || state.busy
    select.setAttribute('aria-pressed', String(state.selected.has(t.id)))
    li.querySelector('b').textContent = t.title
    li.querySelector('small').textContent = [t.artist, t.duration ? fmt(t.duration) : '', t.source === 'vk' ? 'VK' : t.source === 'local' ? 'На телефоне' : 'Telegram'].filter(Boolean).join(' · ')
    li.querySelector('.bpm').textContent = bpm ? Math.round(bpm) + ' BPM' : ''
    select.onclick = () => {
      if (state.playing || state.busy) return
      haptic('light')
      state.selected.has(t.id) ? state.selected.delete(t.id) : state.selected.add(t.id)
      renderLibrary()
      renderStage()
    }
    const del = li.querySelector('.del')
    del.disabled = state.playing || state.busy
    del.setAttribute('aria-label', 'Удалить «' + t.title + '»')
    del.onclick = () => removeTrack(t)
    return li
  }))
}

async function removeTrack(t) {
  if (state.playing || state.busy) return
  const ok = await new Promise((resolve) => (tg?.showConfirm ? tg.showConfirm(`Удалить «${t.title}» из библиотеки?`, resolve) : resolve(confirm('Удалить трек?'))))
  if (!ok || state.playing || state.busy) return
  try {
    if (t.source === 'local') await deviceLibrary.remove(t.id)
    else await api('delete', { id: t.id }, { method: 'POST' })
    try {
      if (audioCache) {
        const key = new URL(API); key.searchParams.set('a', 'file'); key.searchParams.set('id', t.id)
        await (await caches.open(audioCache)).delete(key.href)
      }
      localStorage.removeItem(gridKey(t.id))
    } catch {}
    state.tracks = state.tracks.filter((x) => x.id !== t.id)
    state.selected.delete(t.id)
    render()
  } catch (error) { status(error.message) }
}

async function loadLibrary() {
  if (libraryLoading || state.playing || state.busy || importingFiles || vkLibrary.busy) return
  libraryLoading = true
  const ticket = ++libraryRequest
  render()
  try {
    const data = initData ? await (await api('list')).json() : { tracks: [], user: { id: 'guest' } }
    if (ticket !== libraryRequest || state.playing || state.busy) return
    deviceLibrary = localLibrary(String(data.user.id))
    audioCache = 'flow-audio-v2-' + data.user.id
    let local = []
    try { local = await deviceLibrary.list() } catch (e) { $('importStatus').textContent = e.message }
    // Preserve object identity so queue highlighting stays stable.
    const previous = new Map(state.tracks.map((t) => [t.id, t]))
    state.tracks = [...data.tracks, ...local].map((t) => Object.assign(previous.get(t.id) || {}, t, { bpm: cachedGrid(t.id)?.bpm || 0 }))
    for (const id of [...state.selected]) if (!state.tracks.some((t) => t.id === id)) state.selected.delete(id)
    if (data.user?.name) $('hello').textContent = data.user.name
    status(state.tracks.length ? 'Выбери треки для сета или запусти всю библиотеку' : initData ? '' : 'Файлы с телефона доступны здесь. Для VK и библиотеки бота открой FLOW из Telegram.')
  } catch (error) { status(error.message) }
  finally { libraryLoading = false; render() }
}

const vkLibrary = createVkLibrary({
  api,
  onChange: render,
  canImport: () => !state.playing && !state.busy && !importingFiles && !libraryLoading,
  existingIds: () => new Set(state.tracks.map((t) => t.id)),
  onAdded: async (track) => {
    if (!state.tracks.some((t) => t.id === track.id)) state.tracks.push(track)
    state.selected.add(track.id)
    render()
  },
  onLogout: async () => {
    state.tracks = state.tracks.filter((t) => t.source !== 'vk')
    for (const id of [...state.selected]) if (id.startsWith('vk:')) state.selected.delete(id)
    try { if (audioCache) await caches.delete(audioCache) } catch {}
    render()
  }
})
$('importVk').onclick = () => {
  if (!initData) { status('Открой FLOW из Telegram, чтобы подключить VK'); return }
  vkLibrary.open()
}
$('importFiles').onclick = () => {
  if (!deviceLibrary) { status('Сначала дождись загрузки библиотеки'); return }
  $('audioFiles').click()
}
$('audioFiles').onchange = async () => {
  const files = [...$('audioFiles').files]
  $('audioFiles').value = ''
  if (!deviceLibrary || state.playing || state.busy || importingFiles || vkLibrary.busy) return
  importingFiles = true; render()
  let added = 0
  const errors = []
  for (const file of files) {
    $('importStatus').textContent = `Добавляю ${file.name}…`
    try {
      const track = await deviceLibrary.add(file)
      if (!state.tracks.some((t) => t.id === track.id)) { state.tracks.push(track); added++ }
      state.selected.add(track.id)
    } catch (e) { errors.push(`${file.name}: ${e.message}`) }
  }
  importingFiles = false; render()
  $('importStatus').textContent = `Добавлено: ${added}.${added ? ' Файлы сохранены на этом устройстве.' : !errors.length && files.length ? ' Эти файлы уже есть в библиотеке.' : ''}${errors.length ? ' ' + errors.join(' · ') : ''}`
}
for (const button of document.querySelectorAll('[data-source]')) button.onclick = () => { state.source = button.dataset.source; render() }
$('search').oninput = () => { libraryVisible = 100; state.search = $('search').value.trim(); renderLibrary() }
$('settings').addEventListener('toggle', () => { if ($('settings').open) $('settings').scrollIntoView({ block: 'start' }) })
function showView(name) {
  if (!['music', 'stage', 'settings', 'dj'].includes(name)) name = 'music'
  document.body.dataset.activeView = name
  for (const section of document.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== name
  for (const link of document.querySelectorAll('.bottom-nav a')) {
    if (link.hash === '#' + name) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  window.scrollTo(0, 0)
}
document.addEventListener('click', event => {
  const link = event.target.closest('a[href^="#"]')
  if (!link || !['#stage', '#music', '#settings', '#dj'].includes(link.hash)) return
  event.preventDefault(); history.replaceState(null, '', link.hash); showView(link.hash.slice(1))
})
window.addEventListener('hashchange', () => showView(location.hash.slice(1)))

// ---------- Light settings UI ----------

// Hardware output remains off until the direct Sber connection is implemented.
let settings = { ...loadSettings(), on: false }
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
  renderStage()
}
$('refresh').onclick = () => { haptic(); loadLibrary() }
$('toChat').onclick = () => (tg ? tg.close() : null)
document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.playing) loadLibrary() })

renderLights()
showView(location.hash.slice(1))
loadLibrary()
