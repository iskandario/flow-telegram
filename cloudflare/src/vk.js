import { connectorConfigured, connectorAction } from './vk-connector.js'
// VK uses the same phone-facing API as PHP. Secrets and expiring stream URLs stay server-side.
const enc = new TextEncoder()
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
const hex = (bytes) => [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('')
const hash = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)))
const configured = (env) => !!(env.VK_CLIENT_ID && env.VK_CLIENT_SECRET && env.VK_REDIRECT_URI)
const sessionKey = (uid) => `vk:session:${uid}`
const pendingKey = (uid) => `vk:pending:${uid}`
const errors = { 5: 'Сессия VK истекла. Подключи VK заново.', 6: 'Слишком много запросов к VK. Подожди немного.', 14: 'Пройди проверку на сайте VK и повтори.', 17: 'Подтверди вход на сайте VK и подключи аккаунт заново.', 7: 'VK не разрешил доступ к музыке этому приложению.', 15: 'VK не разрешил доступ к музыке этому приложению.', 20: 'Тип приложения VK не поддерживает доступ к музыке.', 23: 'VK отключил этот метод.', 201: 'VK не разрешил доступ к этой музыке.' }
async function request(url, params) {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(params), redirect: 'error', signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error('VK недоступен. Попробуй ещё раз.')
  return res.json()
}
async function key(env) {
  const bytes = await crypto.subtle.digest('SHA-256', enc.encode('flow-vk|' + env.BOT_TOKEN))
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
async function seal(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), enc.encode(value)))
  return btoa(String.fromCharCode(...iv, ...cipher))
}
async function unseal(env, value) {
  const bytes = Uint8Array.from(atob(value), (x) => x.charCodeAt(0))
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await key(env), bytes.slice(12)))
}
async function api(token, method, params = {}) {
  const data = await request('https://api.vk.com/method/' + method, { ...params, access_token: token, v: '5.199' })
  if (data.error) throw new Error(errors[data.error.error_code] || 'Ошибка VK. Попробуй позже.')
  if (!data.response || typeof data.response !== 'object') throw new Error('VK вернул неожиданный ответ')
  return data.response
}
export function normalizeTrack(raw) {
  const id = Number(raw.id), ownerId = Number(raw.owner_id)
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(ownerId) || !ownerId || !raw.title) return null
  return { id: `vk:${ownerId}_${id}`, source: 'vk', title: String(raw.title).slice(0, 200), artist: String(raw.artist || '').slice(0, 200), duration: Math.max(0, Number(raw.duration) || 0), size: 0,
    identity: { id, ownerId, accessKey: String(raw.access_key || '').slice(0, 200) }, restricted: !raw.url || !!raw.content_restricted }
}
async function getSession(env, uid) {
  const s = await env.LIB.get(sessionKey(uid), 'json')
  if (!s || (s.expires && s.expires <= Date.now())) throw new Error('Подключи VK заново')
  return { ...s, token: await unseal(env, s.token) }
}
async function getAudio(token, identity) {
  const id = Number(identity?.id), owner = Number(identity?.ownerId), access = String(identity?.accessKey || '')
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(owner) || !owner || !/^[a-zA-Z0-9_-]{0,200}$/.test(access)) throw new Error('Некорректный трек VK')
  const response = await api(token, 'audio.getById', { audios: `${owner}_${id}${access ? '_' + access : ''}` })
  const raw = (response.items || response)[0]
  if (Number(raw?.id) !== id || Number(raw?.owner_id) !== owner) throw new Error('Трек удалён или недоступен в VK')
  return raw
}
export function mediaUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !/(^|\.)(userapi\.com|vkuseraudio\.(net|com|ru)|vk-cdn\.net|vkcdn\.ru|vk\.com|vk\.ru|mycdn\.me|okcdn\.ru)$/.test(url.hostname)) throw new Error('VK вернул неподдерживаемый адрес аудио')
  return url
}
export async function vkFile(env, uid, track) {
  try {
    const s = await getSession(env, uid)
    if (track.vk_user !== s.id) throw new Error('Подключи тот аккаунт VK, из которого добавлен трек')
    const raw = await getAudio(s.token, track.identity)
    if (!raw.url || raw.content_restricted) throw new Error('VK не разрешает воспроизвести этот трек')
    let url = mediaUrl(raw.url), res
    for (let i = 0; i < 4; i++) {
      if (/\.m3u8(?:[?#]|$)/i.test(url.href)) throw new Error('Этот трек передаётся в HLS. Для него нужен PHP-сервер FLOW с ffmpeg; Cloudflare поддерживает прямые аудиофайлы.')
      res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60000) })
      if (res.status >= 300 && res.status < 400 && res.headers.has('location')) { await res.body?.cancel(); url = mediaUrl(new URL(res.headers.get('location'), url)); continue }
      break
    }
    if (!res.ok || !res.body) throw new Error('VK не отдал аудио. Повтори загрузку.')
    if (/mpegurl|text\/html/.test(res.headers.get('Content-Type') || '')) { await res.body.cancel(); throw new Error('Этот формат аудио не поддерживается на Cloudflare. Используй PHP-сервер FLOW с ffmpeg.') }
    const limit = 20 * 1024 * 1024
    if (Number(res.headers.get('Content-Length')) > limit) { await res.body.cancel(); return json(413, { error: 'Трек больше 20 МБ' }) }
    const reader = res.body.getReader(), parts = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) { await reader.cancel(); return json(413, { error: 'Трек больше 20 МБ' }) }
      parts.push(value)
    }
    const blob = new Blob(parts, { type: 'audio/mpeg' })
    if ((await blob.slice(0, 32).text()).trimStart().startsWith('#EXTM3U')) throw new Error('Для HLS-трека нужен PHP-сервер FLOW с ffmpeg.')
    return new Response(blob, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
  } catch (e) { return json(422, { error: e.message }) }
}
export async function vkAction(request_, env, uid, action, url, storage) {
  if (connectorConfigured(env)) return connectorAction(request_, env, uid, action, url, storage)
  if (['vk-login', 'vk-logout', 'vk-add'].includes(action) && request_.method !== 'POST') return json(405, { error: 'POST only' })
  try {
    if (action === 'vk-status') {
      const s = await env.LIB.get(sessionKey(uid), 'json')
      return json(200, { configured: configured(env), connected: !!(s && (!s.expires || s.expires > Date.now())), profile: s ? { id: s.id, name: s.name } : null })
    }
    if (action === 'vk-login') {
      if (!configured(env)) return json(503, { error: 'Подключение VK ещё не настроено владельцем FLOW.' })
      const nonce = hex(crypto.getRandomValues(new Uint8Array(32)))
      await env.LIB.put(pendingKey(uid), await hash(nonce), { expirationTtl: 600 })
      return json(200, { url: 'https://oauth.vk.com/authorize?' + new URLSearchParams({ client_id: env.VK_CLIENT_ID, redirect_uri: env.VK_REDIRECT_URI, display: 'mobile', scope: 'audio,offline', response_type: 'code', v: '5.199', state: `${uid}.${nonce}` }) })
    }
    if (action === 'vk-logout') {
      await env.LIB.delete(sessionKey(uid)); await env.LIB.delete(pendingKey(uid))
      for (const t of await storage.list()) if (t.source === 'vk') await storage.remove(t.id)
      return json(200, { ok: true })
    }
    const s = await getSession(env, uid)
    const offset = Math.max(0, Math.min(10000, Number(url.searchParams.get('offset')) || 0))
    if (action === 'vk-playlists') {
      const data = await api(s.token, 'audio.getPlaylists', { offset, count: 50 })
      const raw = data.items || [], next = offset + raw.length
      return json(200, { items: raw.map((p) => ({ id: p.id, ownerId: p.owner_id, accessKey: p.access_key || '', title: p.title || 'Плейлист', count: p.count || 0 })), nextOffset: raw.length && next < data.count ? next : null })
    }
    if (action === 'vk-list') {
      const kind = url.searchParams.get('kind') || 'my'
      const params = { offset, count: 50 }
      let method = 'audio.get'
      if (kind === 'search') {
        method = 'audio.search'; params.q = (url.searchParams.get('q') || '').trim().slice(0, 200); params.auto_complete = 1
        if (!params.q) return json(200, { items: [], count: 0, nextOffset: null })
      } else if (kind === 'playlist') {
        params.owner_id = Number(url.searchParams.get('ownerId')); params.album_id = Number(url.searchParams.get('playlistId'))
        if (!Number.isSafeInteger(params.owner_id) || !params.owner_id || !Number.isSafeInteger(params.album_id) || params.album_id < 0) throw new Error('Некорректный плейлист')
        params.access_key = (url.searchParams.get('accessKey') || '').slice(0, 200)
      } else if (kind !== 'my') throw new Error('Неизвестный раздел VK')
      const data = await api(s.token, method, params), raw = data.items || [], next = offset + raw.length
      const items = [...new Map(raw.map(normalizeTrack).filter(Boolean).map((t) => [t.id, t])).values()]
      return json(200, { items, count: data.count || 0, nextOffset: raw.length && next < data.count ? next : null })
    }
    if (action === 'vk-add') {
      if (Number(request_.headers.get('Content-Length')) > 4096) return json(413, { error: 'Слишком большой запрос' })
      const text = await request_.text()
      if (text.length > 4096) return json(413, { error: 'Слишком большой запрос' })
      const raw = await getAudio(s.token, JSON.parse(text)), track = normalizeTrack(raw)
      if (!track || track.restricted) throw new Error('VK не разрешает воспроизвести этот трек')
      if (track.duration > 720) throw new Error('Для сета выбери трек короче 12 минут')
      const all = await storage.list()
      if (!all.some((t) => t.id === track.id) && all.length >= 10000) throw new Error('Библиотека заполнена')
      const current = await env.LIB.get(sessionKey(uid), 'json')
      if (current?.id !== s.id) throw new Error('Аккаунт VK изменился. Повтори добавление.')
      await storage.put({ ...track, vk_user: s.id, added: Date.now() })
      const { identity, ...publicTrack } = track
      return json(200, { track: publicTrack })
    }
    return json(404, { error: 'Unknown action' })
  } catch (e) { return json(422, { error: e instanceof SyntaxError ? 'Некорректный запрос' : e.message }) }
}
export async function vkCallback(env, url, allowed) {
  let message, ok = false
  try {
    if (!configured(env)) throw new Error('Подключение VK не настроено.')
    const match = /^(\d+)\.([a-f0-9]{64})$/.exec(url.searchParams.get('state') || '')
    if (!match) throw new Error('Ссылка входа недействительна. Начни подключение из FLOW.')
    const uid = Number(match[1]), nonceHash = await hash(match[2])
    if (!allowed(uid) || (await env.LIB.get(pendingKey(uid))) !== nonceHash) throw new Error('Ссылка входа истекла. Подключи VK из FLOW заново.')
    if (url.searchParams.has('error')) { await env.LIB.delete(pendingKey(uid)); throw new Error('Вход отменён. Вернись в FLOW.') }
    const code = url.searchParams.get('code') || ''
    if (!code || code.length > 2048) throw new Error('VK не подтвердил вход.')
    const auth = await request('https://oauth.vk.com/access_token', { client_id: env.VK_CLIENT_ID, client_secret: env.VK_CLIENT_SECRET, redirect_uri: env.VK_REDIRECT_URI, code })
    if (!auth.access_token || !auth.user_id) throw new Error('VK не выдал разрешение. Проверь настройки приложения VK.')
    await api(auth.access_token, 'audio.get', { count: 1 })
    const profile = (await api(auth.access_token, 'users.get'))[0] || {}
    if ((await env.LIB.get(pendingKey(uid))) !== nonceHash) throw new Error('Подключение отменено. Начни заново из FLOW.')
    await env.LIB.delete(pendingKey(uid))
    const previous = await env.LIB.get(sessionKey(uid), 'json')
    if (previous && previous.id !== Number(auth.user_id)) {
      let cursor
      do {
        const page = await env.LIB.list({ prefix: `t:${uid}:`, cursor })
        for (const entry of page.keys) if (entry.metadata?.source === 'vk') await env.LIB.delete(entry.name)
        cursor = page.list_complete ? undefined : page.cursor
      } while (cursor)
    }
    await env.LIB.put(sessionKey(uid), JSON.stringify({ id: Number(auth.user_id), name: `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'VK', token: await seal(env, auth.access_token), expires: auth.expires_in ? Date.now() + auth.expires_in * 1000 : 0 }))
    ok = true; message = 'Вернись в FLOW в Telegram и нажми «Обновить подключение». Обновление может занять до минуты.'
  } catch (e) { message = e.message }
  const safe = String(message).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  return new Response(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLOW · VK</title><style>body{font:17px/1.6 system-ui;background:#0e1016;color:#f4f4f8;max-width:480px;margin:15vh auto;padding:24px}h1{color:#c6f76d}</style><h1>${ok ? 'VK подключён' : 'Не удалось подключить VK'}</h1><p>${safe}</p></html>`, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } })
}
