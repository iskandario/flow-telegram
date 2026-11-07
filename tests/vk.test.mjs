import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTrack, mediaUrl, vkAction, vkCallback, vkFile } from '../cloudflare/src/vk.js'
import worker from '../cloudflare/src/worker.js'
import { createHmac } from 'node:crypto'
const raw = { id: 3, owner_id: -2, title: '<script>Track</script>', artist: 'Artist', duration: 123, url: 'https://a.userapi.com/track.mp3' }
const token = '123456789:' + 'a'.repeat(35)
function env() {
  const values = new Map()
  return { BOT_TOKEN: token, VK_CLIENT_ID: '123', VK_CLIENT_SECRET: 'secret', VK_REDIRECT_URI: 'https://flow.example/api/vk-callback.php', LIB: {
    async get(key, type) { const v = values.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v.value) : v.value },
    async put(key, value, options = {}) { values.set(key, { value, ...options }) },
    async delete(key) { values.delete(key) },
    async getWithMetadata(key) { const v = values.get(key); return { value: v?.value ?? null, metadata: v?.metadata ?? null } },
    async list({ prefix }) { return { list_complete: true, keys: [...values].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })) } } }, values }
}
function initData(id = 42) {
  const fields = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: 'Test' }) })
  const check = [...fields].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  fields.set('hash', createHmac('sha256', secret).update(check).digest('hex'))
  return fields.toString()
}
async function call(e, action, { uid = 42, method = 'GET', params = {}, body, auth = true } = {}) {
  const url = new URL('https://flow.example/api/app.php'); url.searchParams.set('a', action)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const headers = auth ? { 'X-Telegram-Init-Data': initData(uid) } : {}
  return worker.fetch(new Request(url, { method, headers, body: body && JSON.stringify(body) }), e, {})
}
test('identities, restricted tracks and media origin validation', () => {
  const t = normalizeTrack(raw)
  assert.equal(t.id, 'vk:-2_3'); assert.equal(t.restricted, false); assert.equal(t.url, undefined)
  assert.equal(normalizeTrack({ id: 0 }), null)
  assert.equal(normalizeTrack({ ...raw, url: '' }).restricted, true)
  for (const value of ['http://a.userapi.com/a', 'https://userapi.com.evil.test/a', 'https://u:p@a.userapi.com/a', 'https://127.0.0.1/a', 'https://a.userapi.com:444/a']) assert.throws(() => mediaUrl(value))
})
test('authentication and method checks precede VK actions', async () => {
  const e = env()
  assert.equal((await call(e, 'vk-status', { auth: false })).status, 401)
  assert.equal((await call(e, 'vk-login')).status, 405)
  assert.equal((await call(e, 'vk-status')).status, 200)
  assert.equal((await call(e, 'vk-list')).status, 422)
})
test('phone OAuth, paging, import, per-user file access, logout and replay protection', async () => {
  const e = env(), original = globalThis.fetch, requests = []
  globalThis.fetch = async (url, options) => {
    const u = String(url)
    if (u === raw.url) return new Response(new Uint8Array(1024), { headers: { 'Content-Type': 'audio/mpeg' } })
    const params = Object.fromEntries(options.body); requests.push([u, params])
    if (u.endsWith('/access_token')) return Response.json({ access_token: 'vk-private-token', user_id: 7, expires_in: 3600 })
    if (u.endsWith('/users.get')) return Response.json({ response: [{ first_name: 'VK', last_name: 'User' }] })
    if (u.endsWith('/audio.getById')) return Response.json({ response: [raw] })
    return Response.json({ response: { items: [raw, raw, { id: 0 }], count: 80 } })
  }
  try {
    const login = await (await call(e, 'vk-login', { method: 'POST' })).json()
    const state = new URL(login.url).searchParams.get('state')
    const cb = new URL(`https://flow.example/api/vk-callback.php?state=${state}&code=test`)
    assert.equal((await vkCallback(e, cb, () => true)).status, 200)
    assert.equal((await vkCallback(e, cb, () => true)).status, 400)
    assert.ok(!e.values.get('vk:session:42').value.includes('vk-private-token'))
    const status = await (await call(e, 'vk-status')).json(); assert.equal(status.connected, true); assert.equal(status.profile.id, 7); assert.equal(status.token, undefined)
    const page = await (await call(e, 'vk-list', { params: { kind: 'search', q: 'Song', offset: 50 } })).json()
    assert.equal(page.items.length, 1); assert.equal(page.nextOffset, 53)
    assert.ok(requests.some(([u, p]) => u.endsWith('/audio.search') && p.q === 'Song'))
    const added = await (await call(e, 'vk-add', { method: 'POST', body: { id: 3, ownerId: -2 } })).json()
    assert.equal(added.track.id, 'vk:-2_3'); assert.equal(added.track.identity, undefined)
    assert.equal((await (await call(e, 'list')).json()).tracks[0].source, 'vk')
    assert.equal((await call(e, 'file', { uid: 99, params: { id: 'vk:-2_3' } })).status, 404)
    const file = await call(e, 'file', { params: { id: 'vk:-2_3' } })
    assert.equal(file.status, 200); assert.equal((await file.arrayBuffer()).byteLength, 1024)
    assert.equal((await call(e, 'vk-logout', { method: 'POST' })).status, 200)
    assert.equal((await (await call(e, 'list')).json()).tracks.length, 0)
    assert.equal((await call(e, 'file', { params: { id: 'vk:-2_3' } })).status, 404)
  } finally { globalThis.fetch = original }
})
test('VK access errors do not expose tokens or raw provider response', async () => {
  const e = env(), original = globalThis.fetch
  globalThis.fetch = async (url) => String(url).endsWith('/access_token')
    ? Response.json({ access_token: 'secret-credential', user_id: 7 })
    : Response.json({ error: { error_code: 15, error_msg: 'secret-credential' } })
  try {
    const data = await (await call(e, 'vk-login', { method: 'POST' })).json()
    const state = new URL(data.url).searchParams.get('state')
    const response = await vkCallback(e, new URL(`https://flow.example/api/vk-callback.php?state=${state}&code=test`), () => true)
    assert.equal(response.status, 400)
    const body = await response.text(); assert.match(body, /не разрешил/); assert.ok(!body.includes('secret-credential'))
    assert.equal((await (await call(e, 'vk-status')).json()).connected, false)
  } finally { globalThis.fetch = original }
})
