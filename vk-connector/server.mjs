import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { Sessions } from './sessions.mjs'
import { RemoteState } from './remote-state.mjs'
import { audioResponse } from './audio-response.mjs'
import { list, playlists, resolve } from './music.mjs'
import { StreamResources, streamAudio } from './stream.mjs'
import { downloadAudio } from './media.mjs'
const ACTIONS = new Set(['status', 'open', 'app-login', 'app-login-status', 'app-login-code', 'phone-login', 'login-phone', 'frame', 'input', 'logout', 'list', 'playlists', 'track', 'file', 'stream'])
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
export function connector({ secret, sessions, download = downloadAudio, stream = streamAudio }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('FLOW_CONNECTOR_SECRET must contain at least 32 characters')
  const used = new Map(), media = new Map(), resolvedMedia = new Map(), resources = new StreamResources()
  let transfers = 0
  const transferWaiters = []
  const transfer = async (url, options) => {
    if (transfers >= 1) await new Promise(resolve => transferWaiters.push(resolve))
    else transfers++
    try { return await download(url, options) }
    finally { const next = transferWaiters.shift(); if (next) next(); else transfers-- }
  }
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.url === '/health' && req.method === 'GET') return json(res, 200, { ok: true, service: 'flow-vk-connector', release: '20261108-stream7' })
    if (req.url !== '/rpc' || req.method !== 'POST') return json(res, 404, { error: 'Not found' })
    const started = Date.now(); let actionName = 'request', mediaKey = null
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
      actionName = action
      const user = String(uid)
      const resolvedKey = user + ':' + JSON.stringify([params.vk_user, params.identity]); mediaKey = resolvedKey
      for (const [key, value] of resolvedMedia) if (Date.now() - value.at > 600000) resolvedMedia.delete(key)
      const warm = ['stream','file'].includes(action) && !params.resource && resolvedMedia.get(resolvedKey)
      const result = action === 'stream' && params.resource ? { entry: resources.get(user, params.track_id, params.resource) } : warm ? { resolved: warm.resolved, userAgent: warm.userAgent } : await sessions.serial(user, async () => {
        if (action === 'stream' && params.resource) return { entry: resources.get(user, params.track_id, params.resource) }
        if (action === 'status') return sessions.status(user)
        if (action === 'open') return sessions.open(user)
        if (action === 'phone-login') return sessions.phoneLogin(user, params.restart === true)
        if (action === 'login-phone') return sessions.loginPhone(user, params.phone)
        if (action === 'app-login') return sessions.appLogin(user)
        if (action === 'app-login-status') return sessions.appLoginStatus(user)
        if (action === 'app-login-code') return sessions.appLoginCode(user, params.code)
        if (action === 'frame') return sessions.frame(user)
        if (action === 'input') return sessions.input(user, params)
        if (action === 'logout') { resources.clear(user); for (const key of resolvedMedia.keys()) if (key.startsWith(user + ':')) resolvedMedia.delete(key); for (const key of media.keys()) if (key.startsWith(user + ':')) media.delete(key); return sessions.logout(user) }
        const call = (method, args) => sessions.call(user, method, args)
        if (action === 'list') return list(call, params)
        if (action === 'playlists') return playlists(call, params)
        const cachedResolve = ['stream','file'].includes(action) && resolvedMedia.get(resolvedKey)
        if (cachedResolve) return { resolved: cachedResolve.resolved, userAgent: cachedResolve.userAgent }
        let state = await sessions.status(user)
        if (!state.connected && sessions.appLoginStatus) state = await sessions.appLoginStatus(user)
        if (!state.connected) throw new Error('Войди в VK через окно подключения')
        if (params.vk_user && Number(params.vk_user) !== state.profile.id) throw new Error('Подключи тот аккаунт VK, из которого добавлен трек')
        const resolved = await resolve(call, params.identity || params)
        if (resolved.track.duration > 720) throw new Error('Для сета выбери трек короче 12 минут')
        if (action === 'stream' || action === 'file') {
          const userAgent = sessions.userAgent ? await sessions.userAgent(user) : undefined
          while (resolvedMedia.size >= 32) resolvedMedia.delete(resolvedMedia.keys().next().value)
          resolvedMedia.set(resolvedKey, { at: Date.now(), resolved, userAgent })
          return { resolved, userAgent }
        }
        return { track: resolved.track, profile: state.profile }
      })
      if (action === 'stream' || (action === 'file' && download === downloadAudio && /\.mp3(?:[?#]|$)/i.test(result.resolved?.url))) {
        const entry = result.entry || { url: result.resolved.url, userAgent: result.userAgent }
        try {
        await stream(req, res, entry, url => '?a=file&id=' + encodeURIComponent(params.track_id) + '&stream=1&resource=' + resources.add(user, params.track_id, url, entry.userAgent))
        } catch (error) { if (error.code === 'VK_MEDIA_EXPIRED') sessions.invalidateMedia?.(user); throw error }
        return
      }
      if (action === 'file') {
        let entry = media.get(resolvedKey)
        if (!entry || Date.now() - entry.at >= 600000) {
          entry = { at: Date.now() }
          entry.promise = transfer(result.resolved.url, { userAgent: result.userAgent }).catch(error => {
            if (media.get(resolvedKey) === entry) media.delete(resolvedKey)
            throw error
          })
          entry.promise.catch(() => {})
          while (media.size >= 2) media.delete(media.keys().next().value)
          media.set(resolvedKey, entry)
        }
        audioResponse(req, res, await entry.promise); return
      }
      if (Buffer.isBuffer(result)) {
        res.writeHead(200, { 'Content-Type': action === 'frame' ? 'image/jpeg' : 'audio/mpeg', 'Content-Length': result.length, 'Cache-Control': 'no-store' }); res.end(result)
      } else json(res, 200, result)
    } catch (error) {
      if (mediaKey) resolvedMedia.delete(mediaKey)
      const errorCode = /^[A-Za-z_0-9]{1,64}$/.test(error.code || '') ? error.code : error.name || 'Error'
      console.warn(JSON.stringify({event:'rpc_failure',action:actionName,kind:errorCode,cause:error.cause?.code,location:String(error.stack || '').split('\n').filter(line => /(?:sessions|remote-state|stream|media)\.mjs:\d+/.test(line)).map(line => line.match(/(?:sessions|remote-state|stream|media)\.mjs:\d+:\d+/)?.[0]).filter(Boolean).slice(0,3),elapsedMs:Date.now()-started}))
      // Never log request bodies: login text, cookies and media URLs are private.
      if (res.headersSent || res.destroyed) { res.destroy(); return }
      const message = error instanceof SyntaxError ? 'Некорректный запрос' : error.message
      json(res, 422, { code: errorCode, error: /^(VK|Войди|Пройди|Подключи|Некоррект|Неизвест|Не удалось|Все окна|Открой|Слишком|Недопуст|Трек|Для сета|Пустой|Защищ|Прямые|Аудио)/.test(message) ? message : 'Сервер VK не ответил. Повтори попытку.' })
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
