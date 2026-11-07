// Light show through Home Assistant's REST API, straight from the phone.
// Works with any lamp HA knows: Sber (SberDevices integration), Yandex,
// Xiaomi/Yeelight, Hue, Tuya…
//
// Cloud lamps answer in ~0.2–1 s, so FLOW doesn't chase detected onsets.
// It knows the beat grid of the set in advance and fires each command early
// by the measured round-trip time, so the change lands on the downbeat.

const KEY = 'flow.lights.v1'
const PALETTE = [285, 330, 200, 150, 40, 0, 260, 180]

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null') || { url: '', token: '', lamps: [], mode: 'bar', on: false } }
  catch { return { url: '', token: '', lamps: [], mode: 'bar', on: false } }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch {}
}

function cleanUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

async function ha(settings, path, body, timeout = 6000) {
  const base = cleanUrl(settings.url)
  if (!/^https:\/\//.test(base)) throw new Error('Нужен адрес Home Assistant по https (например, через Nabu Casa)')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const res = await fetch(base + '/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + settings.token.trim(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal
    })
    if (res.status === 401) throw new Error('Home Assistant не принял токен')
    if (!res.ok) throw new Error('Home Assistant: ошибка ' + res.status)
    return res.json()
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Home Assistant не ответил')
    if (error instanceof TypeError) throw new Error('Нет доступа к Home Assistant. Проверь адрес и разреши этот сайт в cors_allowed_origins')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** All lamps HA can colour. */
export async function findLamps(settings) {
  const states = await ha(settings, 'states')
  return states
    .filter((s) => s.entity_id.startsWith('light.') && !['unavailable', 'unknown'].includes(s.state))
    .map((s) => ({
      id: s.entity_id,
      name: s.attributes.friendly_name || s.entity_id,
      color: (s.attributes.supported_color_modes || []).some((m) => /hs|rgb|xy/.test(m))
    }))
}

export class LightShow {
  constructor(getSettings) {
    this.getSettings = getSettings
    this.latency = 0.35 // seconds, refined from real round trips
    this.inflight = false
    this.lastSent = 0
    this.firedBeat = null
    this.lastPhrase = -1
    this.hue = PALETTE[0]
  }

  get active() {
    const s = this.getSettings()
    return s.on && s.url && s.token && s.lamps.length > 0
  }

  async send(hue, brightness, transition) {
    const s = this.getSettings()
    if (this.inflight) return
    this.inflight = true
    const t0 = performance.now()
    try {
      await ha(s, 'services/light/turn_on', {
        entity_id: s.lamps,
        hs_color: [hue, 90],
        brightness: Math.round(Math.max(30, Math.min(255, brightness))),
        transition
      }, 4000)
      const rtt = (performance.now() - t0) / 1000
      this.latency = this.latency * 0.7 + Math.min(1.5, rtt * 0.6) * 0.3
    } catch (error) {
      console.warn('lights', error)
    } finally {
      this.inflight = false
      this.lastSent = performance.now()
    }
  }

  /**
   * Call often (≈30 ms) with the engine clock, the AudioContext time and the
   * current loudness 0..1.
   */
  tick(clock, now, energy) {
    if (!clock || !this.active) return
    const s = this.getSettings()
    const upcoming = clock.beat + 1
    const leadTime = this.latency
    if (clock.nextBeatAt - leadTime > now || this.firedBeat === upcoming) return
    const perBeat = s.mode === 'beat'
    const downbeat = upcoming % 4 === 0
    if (!perBeat && !downbeat) return
    // Never flood the lamps: cloud lamps drop or delay bursts.
    if (performance.now() - this.lastSent < (perBeat ? 380 : 900)) return
    this.firedBeat = upcoming
    const phrase = Math.floor(upcoming / 16)
    if (phrase !== this.lastPhrase) {
      this.lastPhrase = phrase
      this.hue = PALETTE[((phrase % PALETTE.length) + PALETTE.length) % PALETTE.length]
    }
    const accent = downbeat ? 1 : 0.6
    const brightness = 60 + 195 * Math.min(1, energy * 1.3) * accent
    const transition = perBeat ? 0 : Math.min(0.4, clock.beatLen / 2)
    void this.send(this.hue + (downbeat ? 0 : 20), brightness, transition)
  }

  async test() {
    const s = this.getSettings()
    for (const hue of [285, 150, 40]) {
      await ha(s, 'services/light/turn_on', { entity_id: s.lamps, hs_color: [hue, 90], brightness: 220, transition: 0 })
      await new Promise((r) => setTimeout(r, 700))
    }
  }
}
