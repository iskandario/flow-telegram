import test from 'node:test'
import assert from 'node:assert/strict'
import { connector } from '../vk-connector/server.mjs'
import worker from '../cloudflare/src/worker.js'
import { createHmac } from 'node:crypto'
import { cp, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
const token = '123456789:' + 'a'.repeat(35), secret = 'connector-proxy-test-key-'.repeat(3)
function auth(id) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) })
  const check = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n')
  const key = createHmac('sha256', 'WebAppData').update(token).digest()
  params.set('hash', createHmac('sha256', key).update(check).digest('hex')); return params.toString()
}
function store() {
  const values = new Map()
  return {
    async get(key, type) { const v = values.get(key); return v ? type === 'json' ? JSON.parse(v.value) : v.value : null },
    async put(key, value, extra) { values.set(key, { value, ...extra }) },
    async delete(key) { values.delete(key) },
    async list({ prefix }) { return { list_complete: true, keys: [...values].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })) } },
    async getWithMetadata(key) { const v = values.get(key); return { value: v?.value ?? null, metadata: v?.metadata ?? null } }
  }
}

test('PHP and Worker proxy signed browser sessions, audio and logout using Telegram identity', async () => {
  const connected = new Set(['42'])
  const raw = { id: 3, owner_id: 7, title: 'Song', artist: 'Artist', duration: 12, url: 'https://a.userapi.com/song.mp3' }
  const sessions = {
    serial: (_uid, fn) => fn(),
    status: async (uid) => ({ configured: true, provider: 'browser', connected: connected.has(uid), profile: connected.has(uid) ? { id: 7, name: 'VK User' } : null }),
    appLogin: async (uid) => ({ connected: false, login: { url: `https://qr.vk.ru/ca?q=user${uid}`, expiresAt: Date.now() + 60000 } }),
    appLoginStatus: async (uid) => ({ connected: connected.has(uid), login: { stage: 'waiting' } }),
    phoneLogin: async (uid, restart) => { assert.equal(uid, '43'); assert.equal(restart, false); return { login: { stage: 'phone_required' } } },
    loginPhone: async (uid, phone) => { assert.equal(uid, '43'); assert.equal(phone, '+79001234567'); return { ok: true } },
    appLoginCode: async (uid, code) => { assert.equal(uid, '43'); assert.equal(code, '123456'); return { ok: true } },
    frame: async () => Buffer.from('frame'), input: async () => ({ ok: true }),
    logout: async (uid) => { connected.delete(uid); return { ok: true } },
    call: async (_uid, method) => method === 'audio.getById' ? [raw] : { items: [raw], count: 1 }
  }
  const service = connector({ secret, sessions, download: async () => Buffer.alloc(1024, 7) })
  await new Promise((r) => service.listen(0, '127.0.0.1', r))
  const connectorUrl = `http://127.0.0.1:${service.address().port}`
  let php, directory
  const originalFetch = globalThis.fetch
  try {
    // An actual HTTP PHP process talks to the actual HMAC-protected connector.
    await mkdir('work', { recursive: true }); directory = await mkdtemp(resolve('work/proxy-php-'))
    await cp('flow/api', directory + '/api', { recursive: true }); await mkdir(directory + '/data')
    await writeFile(directory + '/api/config.local.php', `<?php return ['bot_token'=>'${token}', 'allowed_users'=>[], 'vk_connector_url'=>'${connectorUrl}', 'vk_connector_secret'=>'${secret}'];`)
    const probe = createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise((r) => probe.close(r))
    php = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', directory], { stdio: 'ignore' })
    const base = `http://127.0.0.1:${port}`
    for (let i = 0; i < 40; i++) { try { await fetch(base); break } catch { await new Promise((r) => setTimeout(r, 50)) } }
    const phpCall = (action, { uid = 42, method = 'GET', body, id, headers = {} } = {}) => fetch(`${base}/api/app.php?a=${action}${id ? '&id=' + encodeURIComponent(id) : ''}`, { method, headers: { 'X-Telegram-Init-Data': uid ? auth(uid) : '', ...headers }, body: body && JSON.stringify(body) })
    async function exercise(call) {
      const statusResponse = await call('vk-status'); const statusText = await statusResponse.text();
      assert.ok(statusText.startsWith('{'), statusText); const state = JSON.parse(statusText); assert.equal(state.provider, 'browser'); assert.equal(state.connected, true)
      assert.equal((await call('vk-app-login')).status, 405)
      const login = await (await call('vk-app-login', { method: 'POST', uid: 43 })).json()
      assert.equal(login.login.url, 'https://qr.vk.ru/ca?q=user43')
      assert.equal((await (await call('vk-app-login-status', { uid: 43 })).json()).connected, false)
      assert.equal((await (await call('vk-app-login-status')).json()).connected, true)
      for (const action of ['vk-phone-login', 'vk-login-phone', 'vk-app-login-code']) assert.equal((await call(action)).status, 405)
      assert.equal((await (await call('vk-phone-login', { method: 'POST', uid: 43, body: { uid: '42' } })).json()).login.stage, 'phone_required')
      assert.deepEqual(await (await call('vk-login-phone', { method: 'POST', uid: 43, body: { phone: '+79001234567', uid: '42' } })).json(), { ok: true })
      assert.deepEqual(await (await call('vk-app-login-code', { method: 'POST', uid: 43, body: { code: '123456', uid: '42' } })).json(), { ok: true })
      const frame = await call('vk-browser-frame'); assert.equal(frame.headers.get('content-type'), 'image/jpeg'); assert.equal(await frame.text(), 'frame')
      assert.equal((await call('vk-browser-input')).status, 405)
      assert.equal((await call('vk-browser-input', { method: 'POST', body: { type: 'key', key: 'Enter' } })).status, 200)
      const imported = await (await call('vk-add', { method: 'POST', body: { id: 3, ownerId: 7 } })).json()
      assert.equal(imported.track.id, 'vk:7_3'); assert.equal(imported.track.identity, undefined)
      assert.equal((await call('file', { uid: 43, id: 'vk:7_3' })).status, 404)
      const audio = await call('file', { id: 'vk:7_3' }); assert.equal(audio.status, 200); assert.equal((await audio.arrayBuffer()).byteLength, 1024)
      assert.equal((await call('media-session')).status, 405)
      const mediaSession = await call('media-session', { method: 'POST' })
      assert.equal(mediaSession.status, 200)
      assert.match(mediaSession.headers.get('set-cookie'), /httponly/i)
      const cookie = mediaSession.headers.get('set-cookie').split(';')[0]
      const range = await call('file', { uid: 0, id: 'vk:7_3', headers: { Cookie: cookie, Range: 'bytes=0-1' } })
      assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 2)
      assert.equal(range.headers.get('content-range'), 'bytes 0-1/1024')
      assert.equal((await call('list', { uid: 0, headers: { Cookie: cookie } })).status, 401)
      assert.equal((await call('delete', { uid: 0, method: 'POST', id: 'vk:7_3', headers: { Cookie: cookie } })).status, 401)
      assert.equal((await call('vk-logout', { method: 'POST' })).status, 200)
      assert.equal((await (await call('list')).json()).tracks.length, 0)
    }
    await exercise(phpCall)
    // Worker uses HTTPS in production; redirect only the test transport to the loopback fixture.
    connected.add('42')
    globalThis.fetch = (url, options) => String(url).startsWith('https://connector.test/') ? originalFetch(connectorUrl + new URL(url).pathname, options) : originalFetch(url, options)
    const env = { BOT_TOKEN: token, VK_CONNECTOR_URL: 'https://connector.test', VK_CONNECTOR_SECRET: secret, LIB: store() }
    const workerCall = (action, { uid = 42, method = 'GET', body, id, headers = {} } = {}) => worker.fetch(new Request(`https://flow.test/api/app.php?a=${action}${id ? '&id=' + encodeURIComponent(id) : ''}`, { method, headers: { 'X-Telegram-Init-Data': uid ? auth(uid) : '', ...headers }, body: body && JSON.stringify(body) }), env, {})
    await exercise(workerCall)
  } finally {
    globalThis.fetch = originalFetch
    if (php) { php.kill(); await new Promise((r) => php.once('exit', r)) }
    await new Promise((r) => service.close(r)); if (directory) await rm(directory, { recursive: true, force: true })
  }
})
