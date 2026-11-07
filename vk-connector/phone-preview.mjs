// Temporary, single-user phone verification. Not a replacement for Telegram auth.
import { createServer } from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Sessions } from './sessions.mjs'
import { connector } from './server.mjs'
import { audioResponse } from './audio-response.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(resolve(root, 'work'), { recursive: true })
const persistent = !!process.env.FLOW_PREVIEW_STATE_DIR
const directory = persistent ? resolve(process.env.FLOW_PREVIEW_STATE_DIR) : await mkdtemp(resolve(root, 'work/phone-preview-'))
await mkdir(directory, { recursive: true, mode: 0o700 })
const keyPath = resolve(directory, 'connector.key')
let secret
if (persistent) {
  try { secret = await readFile(keyPath, 'utf8') } catch (e) {
    if (e.code !== 'ENOENT') throw e
    secret = randomBytes(32).toString('hex')
    await writeFile(keyPath, secret, { mode: 0o600, flag: 'wx' })
  }
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid persisted connector key')
} else secret = randomBytes(32).toString('hex')
const accessKey = process.env.FLOW_PREVIEW_KEY || randomBytes(32).toString('hex')
if (!/^[a-f0-9]{64}$/.test(accessKey)) throw new Error('FLOW_PREVIEW_KEY must be 64 random hex characters')
await mkdir(resolve(root, 'work'), { recursive: true })
const sessions = new Sessions({ secret, directory, max: 1 })
const service = connector({ secret, sessions })
await new Promise((r) => service.listen(0, '127.0.0.1', r))
const rpcUrl = `http://127.0.0.1:${service.address().port}/rpc`
const tracks = new Map()
const mediaCache = new Map() // At most two recent tracks on the server, never a library download.
// Diagnostic breadcrumbs contain action/stage/status only, never form values or credentials.
const requests = []
let authJob = null, authError = ''
const authCommands = new Set(['phone-login', 'login-phone', 'app-login-code', 'app-login'])
const pendingAuth = () => ({ configured: true, provider: 'browser', connected: false, login: { stage: authJob?.stage || 'starting', pending: true } })
const assets = new Map([
  ['/', ['vk-connector/phone-preview.html', 'text/html; charset=utf-8']],
  ...['style.css', 'vk-library.js', 'vk-browser.js', 'vk-app-login.js'].map((file) => ['/' + file, ['flow/' + file, file.endsWith('.css') ? 'text/css' : 'text/javascript']])
])
async function rpc(action, params = {}) {
  const body = JSON.stringify({ uid: '1', action, params })
  const time = String(Date.now()), nonce = randomBytes(16).toString('hex')
  const signature = createHmac('sha256', secret).update(`${time}\n${nonce}\n${body}`).digest('hex')
  return fetch(rpcUrl, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Flow-Time': time, 'X-Flow-Nonce': nonce, 'X-Flow-Signature': signature }, signal: AbortSignal.timeout(action === 'file' ? 285000 : 70000) })
}
const server = createServer(async (req, res) => {
  const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
  try {
    const url = new URL(req.url, 'http://preview.local')
    if (url.pathname !== '/api/app.php') {
      const asset = assets.get(url.pathname)
      if (!asset || !['GET', 'HEAD'].includes(req.method)) return json(404, { error: 'Not found' })
      res.writeHead(200, { 'Content-Type': asset[1] })
      res.end(req.method === 'HEAD' ? undefined : await readFile(resolve(root, asset[0])))
      return
    }
    const action = url.searchParams.get('a')
    const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('flow-preview-media='))?.slice('flow-preview-media='.length)
    const supplied = String(req.headers['x-flow-preview-key'] || (action === 'file' && ['GET', 'HEAD'].includes(req.method) ? cookie : '') || '')
    if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(accessKey))) return json(401, { error: 'Нужна личная ссылка теста FLOW' })
    if (req.headers['x-flow-preview-key']) res.setHeader('Set-Cookie', `flow-preview-media=${accessKey}; HttpOnly; SameSite=Strict; Path=/api/app.php`)
    if (action === 'preview-diagnostics' && req.method === 'GET') return json(200, { requests: requests.slice(-20) })
    const commands = { 'vk-status': 'status', 'vk-app-login': 'app-login', 'vk-app-login-status': 'app-login-status', 'vk-app-login-code': 'app-login-code', 'vk-phone-login': 'phone-login', 'vk-login-phone': 'login-phone', 'vk-browser-open': 'open', 'vk-browser-frame': 'frame', 'vk-browser-input': 'input', 'vk-list': 'list', 'vk-playlists': 'playlists', 'vk-add': 'track', 'vk-logout': 'logout' }
    const suppliedId = String(req.headers['x-flow-request-id'] || '')
    const entry = { id: /^[a-f0-9]{32}$/.test(suppliedId) ? suppliedId : randomBytes(16).toString('hex'), action: Object.hasOwn(commands, action) ? action : 'other', at: Date.now(), phase: 'received', status: null }
    if (req.method === 'POST') { requests.push(entry); if (requests.length > 20) requests.shift() }
    res.setHeader('X-Flow-Request-Id', entry.id)
    res.once('finish', () => { entry.status = res.statusCode; if (entry.phase === 'received') entry.phase = 'rejected' })
    if (!['GET', 'POST'].includes(req.method) && !(action === 'file' && req.method === 'HEAD')) return json(405, { error: 'Method not allowed' })
    if (['vk-app-login', 'vk-app-login-code', 'vk-phone-login', 'vk-login-phone', 'vk-browser-open', 'vk-browser-input', 'vk-add', 'vk-logout'].includes(action) && req.method !== 'POST') return json(405, { error: 'POST only' })
    if (action === 'list') return json(200, { tracks: [...tracks.values()].map(({ identity, vk_user, ...track }) => track) })
    let params = Object.fromEntries(url.searchParams)
    if (req.method === 'POST') {
      let size = 0; const chunks = []
      for await (const chunk of req) { size += chunk.length; if (size > 4096) return json(413, { error: 'Request too large' }); chunks.push(chunk) }
      if (size) params = JSON.parse(Buffer.concat(chunks).toString())
    }
    let command = commands[action]
    if (action === 'file') {
      const track = tracks.get(url.searchParams.get('id'))
      if (!track) return json(404, { error: 'Добавь трек в тестовую библиотеку' })
      command = 'file'; params = { identity: track.identity, vk_user: track.vk_user }
    }
    if (!command) return json(404, { error: 'Unknown action' })
    // Free tunnels can close a long HTTP request while Chromium is still working.
    // Accept each login command once, then report progress via short status reads.
    if (authCommands.has(command)) {
      if (authJob) { entry.phase = 'already_pending'; return json(202, pendingAuth()) }
      authError = ''
      const job = { stage: ['phone-login', 'app-login'].includes(command) ? 'starting' : 'submitting' }
      authJob = job; entry.phase = 'queued'
      void (async () => {
        try {
          entry.phase = 'forwarded'
          const response = await rpc(command, params)
          const data = await response.json()
          if (!response.ok) { authError = data.error || 'VK не ответил на запрос'; entry.phase = 'provider_error' }
          else entry.phase = 'completed'
        } catch { authError = 'VK не завершил запрос. Проверь состояние входа перед повтором.'; entry.phase = 'provider_error' }
        finally { if (authJob === job) authJob = null }
      })()
      return json(202, pendingAuth())
    }
    if (authJob && ['app-login-status', 'status'].includes(command)) return json(200, pendingAuth())
    if (command === 'file') {
      const cacheKey = url.searchParams.get('id')
      let cached = mediaCache.get(cacheKey)
      if (cached && Date.now() - cached.at > 10 * 60000) { mediaCache.delete(cacheKey); cached = null }
      if (!cached) {
        while (mediaCache.size >= 2) mediaCache.delete(mediaCache.keys().next().value)
        const promise = (async () => {
          const response = await rpc(command, params)
          if (!response.ok) throw new Error((await response.json()).error || 'VK не отдал аудио')
          return Buffer.from(await response.arrayBuffer())
        })()
        cached = { at: Date.now(), promise }; mediaCache.set(cacheKey, cached)
        promise.catch(() => { if (mediaCache.get(cacheKey) === cached) mediaCache.delete(cacheKey) })
      }
      entry.phase = 'forwarded'
      try { audioResponse(req, res, await cached.promise); entry.phase = 'completed' }
      catch { entry.phase = 'provider_error'; json(502, { error: 'Не удалось подготовить аудио из VK. Попробуй ещё раз.' }) }
      return
    }
    entry.phase = 'forwarded'
    const response = await rpc(command, params)
    if (!response.ok) { entry.phase = 'provider_error'; return json(response.status, await response.json()) }
    if (command === 'file' || command === 'frame') {
      res.writeHead(200, { 'Content-Type': response.headers.get('Content-Type') })
      await pipeline(Readable.fromWeb(response.body), res)
      return
    }
    const data = await response.json()
    if (command === 'app-login-status' && authError) data.login = { ...data.login, error: authError }
    entry.phase = 'completed'
    if (command === 'track') {
      tracks.set(data.track.id, { ...data.track, vk_user: data.profile.id })
      const { identity, ...track } = data.track
      return json(200, { track })
    }
    if (command === 'logout') { tracks.clear(); mediaCache.clear(); res.setHeader('Set-Cookie', 'flow-preview-media=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/api/app.php') }
    json(200, data)
  } catch {
    // No request, VK response or credentials are written to logs.
    if (!res.headersSent) json(422, { error: 'Не удалось выполнить запрос. Повтори попытку.' })
    else res.destroy()
  }
})
await new Promise((r) => server.listen(Number(process.env.PORT) || 0, '127.0.0.1', r))
console.log(`FLOW phone preview port: ${server.address().port}`)
if (!process.env.FLOW_PREVIEW_KEY) console.log(`Local private link: http://127.0.0.1:${server.address().port}/#${accessKey}`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  server.close(); server.closeAllConnections(); service.close(); service.closeAllConnections()
  if (!persistent) await sessions.logout('1').catch(() => {})
  await sessions.close().catch(() => {})
  if (!persistent) await rm(directory, { recursive: true, force: true })
  process.exit(0)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close())
// A forgotten test must not retain an authenticated browser indefinitely.
if (!persistent) setTimeout(() => void close(), 60 * 60000).unref()
