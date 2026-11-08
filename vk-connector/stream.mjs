import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { mediaUrl, publicIPv4 } from './media.mjs'

// Native HLS: proxy playlists, keys and segments; never transcode the whole song.
// Opaque, user-bound resource IDs keep CDN URLs and VK credentials off the client.
export class StreamResources {
  entries = new Map()
  add(uid, track, url, userAgent) {
    for (const [id, entry] of this.entries) if (entry.expires < Date.now()) this.entries.delete(id)
    while (this.entries.size >= 4096) this.entries.delete(this.entries.keys().next().value)
    const id = randomBytes(20).toString('hex')
    this.entries.set(id, { uid, track, url: mediaUrl(url).href, userAgent, expires: Date.now() + 1800000 })
    return id
  }
  get(uid, track, id) {
    const entry = this.entries.get(id)
    if (!entry || entry.uid !== uid || entry.track !== track || entry.expires < Date.now()) throw Error('Не удалось обновить поток. Запусти трек снова.')
    return entry
  }
  clear(uid) { for (const [id, entry] of this.entries) if (entry.uid === uid) this.entries.delete(id) }
}
export async function openMedia(value, { signal, range, userAgent } = {}, redirects = 0) {
  const url = mediaUrl(value)
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw Error('Некорректный диапазон аудио')
  const addresses = await lookup(url.hostname, { all: true, family: 4 })
  if (!addresses.length || addresses.some(a => !publicIPv4(a.address))) throw Error('Недопустимый адрес аудиосервера')
  return new Promise((resolve, reject) => {
    const req = https.get(url, { signal, lookup: (_host, options, cb) => options.all ? cb(null, [addresses[0]]) : cb(null, addresses[0].address, 4), headers: {
      Referer: 'https://vk.com/', ...(range ? { Range: range } : {}),
      ...(userAgent && !/[\r\n]/.test(userAgent) ? { 'User-Agent': userAgent.slice(0, 512) } : {})
    } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirects >= 3) return reject(Error('Слишком много перенаправлений аудио'))
        openMedia(mediaUrl(res.headers.location, url), { signal, range, userAgent }, redirects + 1).then(resolve, reject); return
      }
      if (![200, 206, 416].includes(res.statusCode)) { res.resume(); reject(Error('VK не отдал аудио. Запусти трек снова.')); return }
      resolve(res)
    })
    req.setTimeout(30000, () => req.destroy(Error('Аудиосервер VK не ответил')))
    req.on('error', reject)
  })
}
export function rewritePlaylist(text, base, register) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw Error('Некорректный HLS-плейлист')
  if (/#EXT-X-(?:KEY|SESSION-KEY):.*METHOD=(?!NONE|AES-128)[^,\r\n]+/.test(text)) throw Error('Защищённый поток VK не поддерживается')
  return text.split(/\r?\n/).map(line => {
    if (!line.trim()) return line
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${register(mediaUrl(uri, base))}"`)
    return register(mediaUrl(line.trim(), base))
  }).join('\n')
}
export async function streamAudio(req, res, entry, register, open = openMedia) {
  const controller = new AbortController()
  const abort = () => { if (!res.writableFinished) controller.abort() }
  res.once('close', abort)
  const timer = setTimeout(() => controller.abort(), 280000); timer.unref?.()
  let upstream
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        upstream = await open(entry.url, { signal: controller.signal, range: /\.m3u8(?:[?#]|$)/i.test(entry.url) ? undefined : req.headers.range, userAgent: entry.userAgent })
        break
      } catch (error) {
        if (attempt === 2 || controller.signal.aborted || !['ECONNRESET','EPIPE','ETIMEDOUT','EAI_AGAIN','ECONNREFUSED'].includes(error.code)) throw error
      }
    }
    const type = String(upstream.headers['content-type'] || '')
    const playlist = /\.m3u8(?:[?#]|$)/i.test(entry.url) || /mpegurl/i.test(type)
    res.setHeader('Cache-Control', 'no-store')
    if (playlist) {
      let size = 0; const chunks = []
      for await (const chunk of upstream) { size += chunk.length; if (size > 1024 * 1024) throw Error('Слишком большой HLS-плейлист'); chunks.push(chunk) }
      const text = rewritePlaylist(Buffer.concat(chunks).toString(), entry.url, register)
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
      res.end(text); return
    }
    if (/text\/html|application\/json/i.test(type)) throw Error('VK вернул страницу проверки вместо аудио')
    res.statusCode = upstream.statusCode
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (upstream.headers[name]) res.setHeader(name, upstream.headers[name])
    if (!type) res.setHeader('Content-Type', 'application/octet-stream')
    let size = 0
    const limit = new Transform({ transform(chunk, _, cb) { size += chunk.length; cb(size > 40 * 1024 * 1024 ? Error('Трек слишком большой') : null, chunk) } })
    await pipeline(upstream, limit, res)
  } finally { clearTimeout(timer); res.off('close', abort); upstream?.destroy() }
}
