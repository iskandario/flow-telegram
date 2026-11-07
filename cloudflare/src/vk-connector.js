const enc = new TextEncoder()
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
export const connectorConfigured = (env) => !!(env.VK_CONNECTOR_URL && String(env.VK_CONNECTOR_SECRET || '').length >= 32)
async function rpc(env, uid, action, params = {}, binary = false, range = '') {
  if (!connectorConfigured(env)) throw new Error('Серверное окно VK не настроено')
  const body = JSON.stringify({ uid: String(uid), action, params })
  const time = String(Date.now()), nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const key = await crypto.subtle.importKey('raw', enc.encode(env.VK_CONNECTOR_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${time}\n${nonce}\n${body}`)))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const url = new URL(String(env.VK_CONNECTOR_URL).replace(/\/$/, '') + '/rpc')
  if (url.protocol !== 'https:') throw new Error('Для сервера VK нужен HTTPS')
  const response = await fetch(url, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(action === 'file' ? 280000 : 65000), headers: { 'Content-Type': 'application/json', 'X-Flow-Time': time, 'X-Flow-Nonce': nonce, 'X-Flow-Signature': signature, ...(range ? { Range: range } : {}) } })
  if (!response.ok && !(binary && response.status === 416)) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || 'Серверное окно VK не ответило')
  }
  if (binary) return new Response(response.body, { status: response.status, headers: { 'Content-Type': action === 'frame' ? 'image/jpeg' : 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...Object.fromEntries(['content-range', 'content-length', 'accept-ranges'].filter(h => response.headers.has(h)).map(h => [h, response.headers.get(h)])) } })
  return response.json()
}
export async function connectorFile(env, uid, track, range = '') {
  try { return await rpc(env, uid, 'file', { identity: track.identity, vk_user: track.vk_user }, true, range) }
  catch (e) { return json(422, { error: e.message }) }
}
export async function connectorAction(request, env, uid, action, url, storage) {
  if (['vk-login', 'vk-app-login', 'vk-app-login-code', 'vk-phone-login', 'vk-login-phone', 'vk-logout', 'vk-add', 'vk-browser-open', 'vk-browser-input'].includes(action) && request.method !== 'POST') return json(405, { error: 'POST only' })
  try {
    if (action === 'vk-status') return json(200, await rpc(env, uid, 'status'))
    if (action === 'vk-app-login') return json(200, await rpc(env, uid, 'app-login'))
    if (action === 'vk-app-login-status') return json(200, await rpc(env, uid, 'app-login-status'))
    if (action === 'vk-login' || action === 'vk-browser-open') return json(200, await rpc(env, uid, 'open'))
    if (action === 'vk-browser-frame') return rpc(env, uid, 'frame', {}, true)
    if (action === 'vk-list' || action === 'vk-playlists') return json(200, await rpc(env, uid, action === 'vk-list' ? 'list' : 'playlists', Object.fromEntries(url.searchParams)))
    if (action === 'vk-logout') {
      await rpc(env, uid, 'logout')
      await env.LIB.delete(`vk:session:${uid}`); await env.LIB.delete(`vk:pending:${uid}`)
      for (const t of await storage.list()) if (t.source === 'vk') await storage.remove(t.id)
      return json(200, { ok: true })
    }
    if (action === 'vk-browser-input' || action === 'vk-app-login-code' || action === 'vk-phone-login' || action === 'vk-login-phone' || action === 'vk-add') {
      const text = await request.text()
      if (enc.encode(text).length > 4096) return json(413, { error: 'Слишком большой запрос' })
      const params = JSON.parse(text)
      if (!params || typeof params !== 'object' || Array.isArray(params)) return json(400, { error: 'Некорректный запрос' })
      if (action === 'vk-phone-login') return json(200, await rpc(env, uid, 'phone-login', { restart: params.restart === true }))
      if (action === 'vk-login-phone') return json(200, await rpc(env, uid, 'login-phone', { phone: params.phone }))
      if (action === 'vk-app-login-code') return json(200, await rpc(env, uid, 'app-login-code', { code: params.code }))
      if (action === 'vk-browser-input') return json(200, await rpc(env, uid, 'input', params))
      const data = await rpc(env, uid, 'track', params)
      const all = await storage.list()
      if (!all.some((t) => t.id === data.track.id) && all.length >= 10000) throw new Error('Библиотека заполнена')
      await storage.put({ ...data.track, vk_user: data.profile.id, vk_provider: 'browser', added: Date.now() })
      const { identity, ...track } = data.track
      return json(200, { track })
    }
    return json(404, { error: 'Unknown action' })
  } catch (e) { return json(422, { error: e instanceof SyntaxError ? 'Некорректный запрос' : e.message }) }
}
