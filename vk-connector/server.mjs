import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { Sessions } from './sessions.mjs'
import { RemoteState } from './remote-state.mjs'
import { audioResponse } from './audio-response.mjs'
import { list, playlists, resolve } from './music.mjs'
import { downloadAudio } from './media.mjs'
const ACTIONS = new Set(['status', 'open', 'app-login', 'app-login-status', 'app-login-code', 'phone-login', 'login-phone', 'frame', 'input', 'logout', 'list', 'playlists', 'track', 'file'])
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
export function connector({ secret, sessions, download = downloadAudio }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('FLOW_CONNECTOR_SECRET must contain at least 32 characters')
  const used = new Map(), media = new Map()
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.url === '/health' && req.method === 'GET') return json(res, 200, { ok: true, service: 'flow-vk-connector' })
    if (req.url !== '/rpc' || req.method !== 'POST') return json(res, 404, { error: 'Not found' })
    try {
      let size = 0; const chunks = []
      for await (const chunk of req) { size += chunk.length; if (size > 8192) { json(res, 413, { error: 'Request too large' }); return }; chunks.push(chunk) }
      const body = Buffer.concat(chunks).toString('utf8')
      const timestamp = String(req.headers['x-flow-time'] || ''), nonce = String(req.headers['x-flow-nonce'] || ''), signature = String(req.headers['x-flow-signature'] || '')
      if (!/^\d{10,13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60000 || !/^[a-f\d]{32}$/.test(nonce) || !/^[a-f\d]{64}$/.test(signature)) return json(res, 401, { error: 'Unauthorized connector request' })
      const expected = createHmac('sha256', secret).update(`${timestamp}\n${nonce}\n${body}`).digest()
      if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return json(res, 401, { error: 'Unauthorized connector request' })
      for (const [key, at] of used) if (Date.now() - at > 120000) used.delete(key)
      if (used.has(nonce)) return json(res, 409, { error: 'Request already used' })
      used.set(nonce, Date.now())
      const { uid, action, params = {} } = JSON.parse(body)
      if (!/^\d{1,20}$/.test(String(uid)) || !ACTIONS.has(action) || !params || typeof params !== 'object' || Array.isArray(params)) return json(res, 400, { error: 'Invalid request' })
      const user = String(uid)
      const result = await sessions.serial(user, async () => {
        if (action === 'status') return sessions.status(user)
        if (action === 'open') return sessions.open(user)
        if (action === 'phone-login') return sessions.phoneLogin(user, params.restart === true)
        if (action === 'login-phone') return sessions.loginPhone(user, params.phone)
        if (action === 'app-login') return sessions.appLogin(user)
        if (action === 'app-login-status') return sessions.appLoginStatus(user)
        if (action === 'app-login-code') return sessions.appLoginCode(user, params.code)
        if (action === 'frame') return sessions.frame(user)
        if (action === 'input') return sessions.input(user, params)
        if (action === 'logout') { for (const key of media.keys()) if (key.startsWith(user + ':')) media.delete(key); return sessions.logout(user) }
        const call = (method, args) => sessions.call(user, method, args)
        if (action === 'list') return list(call, params)
        if (action === 'playlists') return playlists(call, params)
        const state = await sessions.status(user)
        if (!state.connected) throw new Error('Войди в VK через окно подключения')
        if (params.vk_user && Number(params.vk_user) !== state.profile.id) throw new Error('Подключи тот аккаунт VK, из которого добавлен трек')
        const cacheKey = user + ':' + JSON.stringify(params.identity || params)
        const cached = media.get(cacheKey)
        if (action === 'file' && cached && Date.now() - cached.at < 600000) return cached.bytes
        const resolved = await resolve(call, params.identity || params)
        if (resolved.track.duration > 720) throw new Error('Для сета выбери трек короче 12 минут')
        if (action === 'file') {
          const bytes = await download(resolved.url, { userAgent: sessions.userAgent ? await sessions.userAgent(user) : undefined })
          while (media.size >= 2) media.delete(media.keys().next().value)
          media.set(cacheKey, { at: Date.now(), bytes }); return bytes
        }
        return { track: resolved.track, profile: state.profile }
      })
      if (action === 'file' && Buffer.isBuffer(result)) { audioResponse(req, res, result); return }
      if (Buffer.isBuffer(result)) {
        res.writeHead(200, { 'Content-Type': action === 'frame' ? 'image/jpeg' : 'audio/mpeg', 'Content-Length': result.length, 'Cache-Control': 'no-store' }); res.end(result)
      } else json(res, 200, result)
    } catch (error) {
      // Never log request bodies: login text, cookies and media URLs are private.
      const message = error instanceof SyntaxError ? 'Некорректный запрос' : error.message
      json(res, 422, { error: /^(VK|Войди|Пройди|Подключи|Некоррект|Неизвест|Не удалось|Все окна|Открой|Слишком|Недопуст|Трек|Для сета|Пустой|Защищ|Прямые|Аудио)/.test(message) ? message : 'Сервер VK не ответил. Повтори попытку.' })
    }
  })
}
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const secret = process.env.FLOW_CONNECTOR_SECRET || ''
  const sessions = new Sessions({ secret, store: process.env.FLOW_STATE_URL ? new RemoteState(process.env.FLOW_STATE_URL, secret) : null, directory: process.env.FLOW_SESSION_DIR || './state', max: Number(process.env.FLOW_MAX_BROWSERS) || 2 })
  const server = connector({ secret, sessions })
  const timer = setInterval(() => void sessions.idle(), 60000); timer.unref()
  server.requestTimeout = 300000; server.headersTimeout = 10000
  server.listen(Number(process.env.PORT) || 8788, process.env.HOST || '127.0.0.1', () => console.log('FLOW VK connector ready'))
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { clearInterval(timer); server.close(); void sessions.close().finally(() => process.exit(0)) })
}
