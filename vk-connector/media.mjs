import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { createDecipheriv } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)
const MAX = 20 * 1024 * 1024
export function mediaUrl(value, base) {
  const url = new URL(value, base)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !/(^|\.)(userapi\.com|vkuseraudio\.(net|com)|vk-cdn\.net|vkcdn\.ru|vk\.com|vk\.ru|mycdn\.me|okcdn\.ru)$/.test(url.hostname)) throw Object.assign(new Error('VK вернул неподдерживаемый адрес аудио'), {code:'VK_MEDIA_ORIGIN',origin: url.origin})
  return url
}
export function publicIPv4(ip) {
  const p = ip.split('.').map(Number)
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && p[0] !== 0 && p[0] !== 10 && p[0] !== 127 && p[0] < 224 && !(p[0] === 100 && p[1] >= 64 && p[1] <= 127) && !(p[0] === 169 && p[1] === 254) && !(p[0] === 172 && p[1] >= 16 && p[1] <= 31) && !(p[0] === 192 && (p[1] === 168 || p[1] === 0)) && !(p[0] === 198 && [18, 19].includes(p[1]))
}
export async function fetchMedia(value, limit, signal, redirects = 0, userAgent) {
  const url = mediaUrl(value)
  const addresses = await lookup(url.hostname, { all: true, family: 4 })
  if (!addresses.length || addresses.some((a) => !publicIPv4(a.address))) throw new Error('Недопустимый адрес аудиосервера')
  return new Promise((resolve, reject) => {
    let timer
    const req = https.get(url, { signal, lookup: (_host, options, cb) => options.all ? cb(null, [addresses[0]]) : cb(null, addresses[0].address, 4), headers: { Referer: 'https://vk.com/', ...(userAgent && typeof userAgent === 'string' && !/[\r\n]/.test(userAgent) ? { 'User-Agent': userAgent.slice(0, 512) } : {}) } }, (res) => {
      clearTimeout(timer)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume()
        fetchMedia(mediaUrl(res.headers.location, url), limit, signal, redirects + 1, userAgent).then(resolve, reject); return
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('VK не отдал аудио. Повтори загрузку.')); return }
      if (Number(res.headers['content-length']) > limit) { res.destroy(); reject(new Error('Аудио превышает допустимый размер')); return }
      const parts = []; let size = 0
      res.on('data', (chunk) => { size += chunk.length; if (size > limit) { res.destroy(new Error('Аудио превышает допустимый размер')); return }; parts.push(chunk) })
      res.on('error', reject); res.on('end', () => resolve(Buffer.concat(parts)))
    })
    timer = setTimeout(() => req.destroy(Object.assign(Error('Аудиосервер VK не ответил'), {code:'ETIMEDOUT'})), 12000)
    timer.unref?.()
    req.setTimeout(15000, () => req.destroy(Object.assign(Error('Аудиосервер VK не ответил'), {code:'ETIMEDOUT'})))
    req.on('error', error => { clearTimeout(timer); reject(error) })
    req.on('close', () => clearTimeout(timer))
  })
}
export function attributes(line) {
  const result = {}
  for (const match of line.slice(line.indexOf(':') + 1).matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/g)) result[match[1]] = match[2] ?? match[3]
  return result
}
export async function hlsBytes(url, manifest, fetch, depth = 0) {
  if (depth > 3) throw new Error('Некорректный HLS-плейлист')
  const lines = manifest.trim().split(/\r?\n/).map((s) => s.trim())
  if (lines[0] !== '#EXTM3U') throw new Error('Некорректный HLS-плейлист')
  const audio = lines.filter((s) => s.startsWith('#EXT-X-MEDIA:')).map(attributes).find((a) => a.TYPE === 'AUDIO' && a.URI)
  const variant = lines.findIndex((s) => s.startsWith('#EXT-X-STREAM-INF:'))
  if (audio || variant >= 0) {
    const uri = audio?.URI || lines.slice(variant + 1).find((s) => s && !s.startsWith('#'))
    if (!uri) throw new Error('Пустой HLS-плейлист')
    const next = mediaUrl(uri, url)
    return hlsBytes(next, (await fetch(next, 1024 * 1024)).toString(), fetch, depth + 1)
  }
  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('Прямые эфиры не поддерживаются')
  // Keep only four segment requests ahead; decrypt and append in manifest order.
  // Byte-range playlists retain the sequential resource cache below.
  const segments = lines.filter(line => line && !line.startsWith('#'))
  if (segments.length > 600) throw new Error('Слишком длинный HLS-трек')
  const pending = new Map()
  const parallel = !lines.some(line => line.startsWith('#EXT-X-BYTERANGE:'))
  let consumed = 0
  const fill = () => {
    if (!parallel) return
    for (let i = consumed; i < Math.min(segments.length, consumed + 4); i++) {
      if (!pending.has(i)) pending.set(i, Promise.resolve().then(() => fetch(mediaUrl(segments[i], url), 8 * 1024 * 1024)).then(bytes => ({ bytes }), error => ({ error })))
    }
  }
  const segment = async (line, range) => {
    if (!parallel) return getPart(line, range)
    fill()
    const result = await pending.get(consumed)
    pending.delete(consumed++)
    if (result.error) throw result.error
    return result.bytes
  }
  const parts = []; let total = 0, count = 0, sequence = 0n, key = null, iv = null, range = null, previousRange = null, rangeResource = null
  const append = (bytes) => { total += bytes.length; if (total > 40 * 1024 * 1024) throw new Error('Трек слишком большой'); parts.push(bytes) }
  const getPart = async (uri, rangeText) => {
    const target = mediaUrl(uri, url)
    let start = 0, length = null
    if (rangeText) {
      const match = /^(\d+)(?:@(\d+))?$/.exec(rangeText)
      if (!match) throw new Error('Некорректный диапазон HLS')
      length = Number(match[1]); start = match[2] === undefined ? (previousRange?.url === target.href ? previousRange.end : NaN) : Number(match[2])
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0 || start + length > 40 * 1024 * 1024) throw new Error('Некорректный диапазон HLS')
    }
    const bytes = rangeText && rangeResource?.url === target.href ? rangeResource.bytes : await fetch(target, rangeText ? 40 * 1024 * 1024 : 8 * 1024 * 1024)
    rangeResource = rangeText ? { url: target.href, bytes } : null
    if (length !== null && bytes.length < start + length) throw new Error('VK вернул неполный сегмент')
    previousRange = length === null ? null : { url: target.href, end: start + length }
    return length === null ? bytes : bytes.subarray(start, start + length)
  }
  const decrypt = (bytes, explicitIV = iv) => {
    if (!key) return bytes
    const vector = explicitIV || Buffer.alloc(16)
    if (!explicitIV) vector.writeBigUInt64BE(sequence, 8)
    const d = createDecipheriv('aes-128-cbc', key, vector)
    try { return Buffer.concat([d.update(bytes), d.final()]) } catch { throw new Error('Не удалось прочитать HLS-аудио') }
  }
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { const value = line.split(':')[1]; if (!/^\d+$/.test(value) || BigInt(value) > 0xffffffffffffffffn) throw new Error('Некорректный номер сегмента'); sequence = BigInt(value) }
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = attributes(line)
      if (a.METHOD === 'NONE') { key = iv = null; continue }
      if (a.METHOD !== 'AES-128' || !a.URI || (a.KEYFORMAT && a.KEYFORMAT !== 'identity')) throw new Error('Защищённый поток VK не поддерживается')
      key = await fetch(mediaUrl(a.URI, url), 16)
      if (key.length !== 16) throw new Error('Некорректный ключ HLS')
      if (a.IV && !/^0x[a-f\d]{1,32}$/i.test(a.IV)) throw new Error('Некорректный IV HLS')
      iv = a.IV ? Buffer.from(a.IV.slice(2).padStart(32, '0'), 'hex') : null
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attributes(line)
      if (!a.URI || (key && !iv)) throw new Error('Некорректный заголовок HLS')
      append(decrypt(await getPart(a.URI, a.BYTERANGE)))
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(17)
    else if (line && !line.startsWith('#')) {
      if (++count > 600) throw new Error('Слишком длинный HLS-трек')
      append(decrypt(await segment(line, range))); range = null; sequence++
    }
  }
  if (!count) throw new Error('Пустой HLS-плейлист')
  return Buffer.concat(parts)
}
export async function downloadAudio(value, { ffmpeg = 'ffmpeg', fetch = fetchMedia, userAgent } = {}) {
  const url = mediaUrl(value), signal = AbortSignal.timeout(180000)
  const get = async (u, limit) => {
    for (let attempt = 0; ; attempt++) {
      try { return await fetch(u, limit, signal, 0, userAgent) }
      catch (error) {
        if (attempt >= 2 || signal.aborted || !['ECONNRESET','EPIPE','ETIMEDOUT','EAI_AGAIN','ECONNREFUSED'].includes(error.code)) throw error
      }
    }
  }
  const hls = /\.m3u8(?:[?#]|$)/i.test(url.href)
  const data = await get(url, hls ? 1024 * 1024 : MAX)
  if (!hls && !data.subarray(0, 32).toString().trimStart().startsWith('#EXTM3U')) {
    if (data.length < 512) throw new Error('VK вернул пустое аудио')
    if (/^\s*(?:<!doctype html|<html)/i.test(data.subarray(0, 256).toString())) throw new Error('VK вернул страницу проверки вместо аудио. Открой окно VK.')
    return data
  }
  const bytes = await hlsBytes(url, data.toString(), get)
  const dir = await mkdtemp(join(tmpdir(), 'flow-vk-'))
  try {
    const input = join(dir, 'input')
    let output = join(dir, 'audio.m4a')
    await writeFile(input, bytes, { mode: 0o600 })
    const common = ['-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', input, '-vn', '-t', '720']
    try {
      // AAC HLS can be repackaged without spending CPU re-encoding every sample.
      await run(ffmpeg, [...common, '-c:a', 'copy', '-movflags', '+faststart', '-fs', String(MAX), '-f', 'mp4', output], { timeout: 30000, maxBuffer: 8192 })
    } catch {
      output = join(dir, 'audio.mp3')
      try { await run(ffmpeg, [...common, '-c:a', 'libmp3lame', '-b:a', '192k', '-fs', String(MAX), '-f', 'mp3', output], { timeout: 90000, maxBuffer: 8192 }) }
      catch { throw new Error('Не удалось обработать HLS-аудио на сервере FLOW') }
    }
    const result = await readFile(output)
    if (result.length < 512 || result.length > MAX) throw new Error('Некорректный размер аудио')
    return result
  } finally { await rm(dir, { recursive: true, force: true }) }
}
