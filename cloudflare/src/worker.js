// FLOW on Cloudflare Workers: Telegram bot webhook, mini app API and the mini
// app itself (static assets) in one Worker. Library lives in Workers KV.
//
// Routes (kept identical to the PHP version, so the front-end is unchanged):
//   POST /api/bot.php     Telegram webhook
//   GET  /api/app.php     ?a=list | ?a=file&id=…   (auth: Telegram initData)
//   POST /api/app.php     ?a=delete&id=…
//   GET  /api/setup.php   one-time: webhook + menu button + commands
//   *                     static mini app; files over Cloudflare's 25 MB
//                         limit are stored as .part0, .part1… and stitched here.

const TG_FILE_LIMIT = 20 * 1024 * 1024
const enc = new TextEncoder()

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname
    try {
      if (path === '/api/bot.php' || path === '/api/bot') return await webhook(request, env, ctx)
      if (path === '/api/app.php' || path === '/api/app') return await appApi(request, env, url)
      if (path === '/api/setup.php' || path === '/api/setup') return await setup(env, url)
      if (path.startsWith('/api/')) return json(404, { error: 'Not found' })
      return await assets(request, env, url)
    } catch (error) {
      console.error(error)
      return json(500, { error: String(error.message || error) })
    }
  }
}

// ---------------------------------------------------------------- helpers

function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  })
}

function token(env) {
  const t = String(env.BOT_TOKEN || '').trim()
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(t)) throw new Error('BOT_TOKEN не задан: выполни `npx wrangler secret put BOT_TOKEN`')
  return t
}

const apiBase = (env) => env.API_BASE || 'https://api.telegram.org'

async function tg(env, method, params = {}) {
  const res = await fetch(`${apiBase(env)}/bot${token(env)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  })
  const data = await res.json().catch(() => ({ ok: false, description: 'Bad response' }))
  if (!data.ok) console.warn('tg', method, data.description)
  return data
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function sha256hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)))
}

async function hmac(keyBytes, text) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', key, enc.encode(text))
}

/** Constant-time string compare. */
function same(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function webhookSecret(env) {
  return (await sha256hex('flow-webhook|' + token(env))).slice(0, 48)
}

function allowed(env, uid) {
  const list = String(env.ALLOWED_USERS || '').split(/[\s,]+/).filter(Boolean).map(Number)
  return !list.length || list.includes(uid)
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const label = (t) => (t.artist ? `${t.artist} — ${t.title}` : t.title)

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many
}

// ---------------------------------------------------------------- storage
// One KV key per track: t:<uid>:<trackId>, the track itself in the key's
// metadata, so a single list() returns the whole library and concurrent
// uploads can never overwrite each other.

const trackKey = (uid, id) => `t:${uid}:${id}`

async function listTracks(env, uid) {
  const tracks = []
  let cursor
  do {
    const page = await env.LIB.list({ prefix: `t:${uid}:`, cursor })
    for (const k of page.keys) if (k.metadata) tracks.push(k.metadata)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return tracks.sort((a, b) => b.added - a.added)
}

async function getTrack(env, uid, id) {
  const { value, metadata } = await env.LIB.getWithMetadata(trackKey(uid, id))
  return value === null ? null : metadata
}

// ---------------------------------------------------------------- bot

async function webhook(request, env, ctx) {
  if (request.method !== 'POST') return new Response('FLOW bot', { status: 200 })
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || ''
  if (!same(header, await webhookSecret(env))) return new Response('forbidden', { status: 403 })
  const update = await request.json().catch(() => null)
  if (update) {
    ctx.waitUntil(
      handleUpdate(env, update).catch(async (e) => {
        console.error('update failed', e)
        const chat = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id
        if (chat) await tg(env, 'sendMessage', { chat_id: chat, text: '⚠️ Что-то пошло не так, попробуй ещё раз.' })
      })
    )
  }
  return json(200, {})
}

async function handleUpdate(env, update) {
  if (update.callback_query) return onCallback(env, update.callback_query)
  if (update.message) return onMessage(env, update.message)
}

let originCache = ''
/** Public address of the mini app, remembered by /api/setup.php. */
async function publicOrigin(env) {
  if (!originCache) originCache = (await env.LIB.get('cfg:origin')) || ''
  return originCache
}

function appButton(origin, text = '🎧 Открыть FLOW') {
  return { inline_keyboard: [[{ text, web_app: { url: origin + '/' } }]] }
}

function reply(env, chat, html, markup) {
  const params = { chat_id: chat, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  if (markup) params.reply_markup = markup
  return tg(env, 'sendMessage', params)
}

function audioFrom(m) {
  let a = m.audio
  if (!a && m.document) {
    const d = m.document
    if (String(d.mime_type || '').startsWith('audio/') || /\.(mp3|m4a|aac|wav|flac|ogg|opus|aiff?)$/i.test(d.file_name || '')) a = d
  }
  if (!a) return null
  const file = String(a.file_name || 'Трек').replace(/\.[^.]+$/, '')
  let artist = String(a.performer || '').trim()
  let title = String(a.title || '').trim()
  if (!title) {
    title = file
    const mm = !artist && file.match(/^(.+?)\s+[-–—]\s+(.+)$/u)
    if (mm) { artist = mm[1].trim(); title = mm[2].trim() }
  }
  return {
    id: String(a.file_unique_id),
    file_id: String(a.file_id),
    // KV metadata is capped at 1024 bytes — keep names short.
    title: title.slice(0, 120),
    artist: artist.slice(0, 80),
    duration: Number(a.duration) || 0,
    size: Number(a.file_size) || 0,
    mime: String(a.mime_type || 'audio/mpeg').slice(0, 40),
    added: Date.now()
  }
}

async function onMessage(env, m) {
  if (m.chat?.type !== 'private') return
  const chat = m.chat.id
  const uid = Number(m.from?.id || 0)
  const origin = await publicOrigin(env)
  const text = String(m.text || '').trim()

  if (!allowed(env, uid)) return reply(env, chat, `Это личный бот FLOW 🔒\nТвой ID: <code>${uid}</code>`)

  const track = audioFrom(m)
  if (track) {
    if (track.size > TG_FILE_LIMIT) {
      return reply(env, chat, '😕 Файл больше 20 МБ — Telegram не отдаёт такие ботам. Пришли mp3 поменьше (320 kbps ≈ 8 МБ на 3 минуты).')
    }
    if (await getTrack(env, uid, track.id)) {
      return reply(env, chat, `Уже есть в библиотеке: <b>${esc(label(track))}</b>`, appButton(origin, '🎧 Микс'))
    }
    await env.LIB.put(trackKey(uid, track.id), '1', { metadata: track })
    return reply(env, chat, `✅ <b>${esc(label(track))}</b>\nДобавил в библиотеку`, appButton(origin, '🎧 Микс'))
  }

  if (m.voice || m.video_note || m.video) {
    return reply(env, chat, 'Голосовые и видео я не микширую 🙂 Пришли трек как музыку или файлом (mp3, m4a, wav, flac).')
  }

  const cmd = (text.split(/\s+/)[0] || '').replace(/@\w+$/, '').toLowerCase()
  switch (cmd) {
    case '/start': {
      const name = esc(m.from?.first_name || 'бро')
      return reply(env, chat,
        `Йо, ${name}! Я <b>FLOW</b> — карманный диджей 🎧\n\n` +
        '1. Кидай мне треки (музыкой или файлом, до 20 МБ).\n' +
        '2. Жми «Открыть FLOW» — соберу из них сет: подберу порядок по темпу, сведу на фразах, а в режиме «Мэшап» положу вокал одного трека на бит следующего.\n' +
        '3. Есть Home Assistant? Подключи лампы в настройках — будут мигать в бит.\n\n' +
        '/list — библиотека · /clear — очистить · /id — твой ID',
        appButton(origin))
    }
    case '/app':
    case '/mix':
      return reply(env, chat, 'Погнали 👇', appButton(origin))
    case '/id':
      return reply(env, chat, `Твой Telegram ID: <code>${uid}</code>`)
    case '/list': {
      const tracks = await listTracks(env, uid)
      if (!tracks.length) return reply(env, chat, 'Библиотека пустая. Пришли мне пару треков 🎶')
      const lines = tracks.slice(0, 30).map((t, i) => `${i + 1}. ${esc(label(t))}`)
      const more = tracks.length > 30 ? `\n…и ещё ${tracks.length - 30}` : ''
      return reply(env, chat, `<b>Твоя библиотека</b> (${tracks.length})\n${lines.join('\n')}${more}`, appButton(origin))
    }
    case '/clear':
      return reply(env, chat, 'Точно удалить всю библиотеку? Сами файлы в чате останутся.', {
        inline_keyboard: [[
          { text: '🗑 Да, очистить', callback_data: 'clear:yes' },
          { text: 'Отмена', callback_data: 'clear:no' }
        ]]
      })
    default: {
      const n = (await listTracks(env, uid)).length
      return reply(env, chat, n
        ? `Я на связи 🤙 В библиотеке ${n} ${plural(n, 'трек', 'трека', 'треков')}. Кидай ещё музыку или открывай микс.`
        : 'Я на связи 🤙 Пришли мне треки — и запускай микс.', appButton(origin))
    }
  }
}

async function onCallback(env, q) {
  const uid = Number(q.from.id)
  const chat = q.message?.chat?.id ?? uid
  const msg = q.message?.message_id
  if (q.data === 'clear:yes' && allowed(env, uid)) {
    const tracks = await listTracks(env, uid)
    await Promise.all(tracks.map((t) => env.LIB.delete(trackKey(uid, t.id))))
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Очищено' })
    if (msg) await tg(env, 'editMessageText', { chat_id: chat, message_id: msg, text: '🗑 Библиотека очищена.' })
    return
  }
  await tg(env, 'answerCallbackQuery', { callback_query_id: q.id })
  if (msg) await tg(env, 'editMessageText', { chat_id: chat, message_id: msg, text: 'Ок, ничего не трогаю 👌' })
}

// ---------------------------------------------------------------- mini app API

/** Validate Telegram WebApp initData (core.telegram.org/bots/webapps). */
export async function verifyInitData(env, initData, maxAge = 86400) {
  if (!initData) return null
  const params = new URLSearchParams(initData)
  const hash = params.get('hash') || ''
  if (!hash) return null
  params.delete('hash')
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n')
  const secret = await hmac(enc.encode('WebAppData'), token(env))
  const calc = hex(await hmac(new Uint8Array(secret), check))
  if (!same(calc, hash)) return null
  if (Number(params.get('auth_date') || 0) < Date.now() / 1000 - maxAge) return null
  try {
    const user = JSON.parse(params.get('user') || '')
    return user && user.id ? user : null
  } catch {
    return null
  }
}

async function appApi(request, env, url) {
  const user = await verifyInitData(env, request.headers.get('X-Telegram-Init-Data') || '')
  if (!user) return json(401, { error: 'Открой FLOW через кнопку в боте' })
  const uid = Number(user.id)
  if (!allowed(env, uid)) return json(403, { error: 'Это личный бот' })
  const action = url.searchParams.get('a')
  const id = url.searchParams.get('id') || ''

  if (action === 'list') {
    const tracks = (await listTracks(env, uid)).map(({ id, title, artist, duration, size }) => ({ id, title, artist, duration, size }))
    return json(200, { tracks, user: { id: uid, name: user.first_name || '' } })
  }

  if (action === 'delete') {
    if (request.method !== 'POST') return json(405, { error: 'POST only' })
    await env.LIB.delete(trackKey(uid, id))
    return json(200, { ok: true })
  }

  if (action === 'file') {
    const track = await getTrack(env, uid, id)
    if (!track) return json(404, { error: 'Трека нет в библиотеке' })
    const file = await tg(env, 'getFile', { file_id: track.file_id })
    const filePath = file.result?.file_path
    if (!filePath) return json(410, { error: 'Telegram не отдал файл. Пришли трек боту ещё раз.' })
    const upstream = await fetch(`${apiBase(env)}/file/bot${token(env)}/${filePath}`)
    if (!upstream.ok || !upstream.body) return json(502, { error: 'Не удалось скачать трек из Telegram' })
    const headers = {
      'Content-Type': track.mime || 'audio/mpeg',
      'Cache-Control': 'private, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff'
    }
    const length = upstream.headers.get('Content-Length')
    if (length) headers['Content-Length'] = length
    return new Response(upstream.body, { status: 200, headers })
  }

  return json(404, { error: 'Unknown action' })
}

// ---------------------------------------------------------------- setup

async function setup(env, url) {
  const origin = url.origin
  const rows = []
  let ok = true
  const check = (name, pass, detail = '') => { rows.push([name, pass, detail]); if (!pass) ok = false }
  let username = ''
  try {
    check('HTTPS', url.protocol === 'https:', origin)
    check('Хранилище KV', !!env.LIB)
    const me = await tg(env, 'getMe')
    username = me.result?.username || ''
    check('Токен бота', !!me.ok, me.ok ? '@' + username : me.description || 'Telegram отклонил токен')
    if (ok) {
      await env.LIB.put('cfg:origin', origin)
      originCache = origin
      const hook = await tg(env, 'setWebhook', {
        url: origin + '/api/bot.php',
        secret_token: await webhookSecret(env),
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
        max_connections: 10
      })
      check('Webhook', !!hook.ok, origin + '/api/bot.php')
      const menu = await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'FLOW', web_app: { url: origin + '/' } } })
      check('Кнопка FLOW у поля ввода', !!menu.ok)
      await tg(env, 'setMyCommands', { commands: [
        { command: 'mix', description: 'Открыть микшер' },
        { command: 'list', description: 'Моя библиотека' },
        { command: 'clear', description: 'Очистить библиотеку' },
        { command: 'id', description: 'Мой Telegram ID' }
      ] })
      await tg(env, 'setMyDescription', { description: 'FLOW — карманный диджей. Присылай треки, а я сведу их в сет: автомикс по темпу, мэшапы и светомузыка.' })
      await tg(env, 'setMyShortDescription', { short_description: 'Автомикс, мэшапы и светомузыка из твоих треков 🎧' })
    }
  } catch (e) {
    check('Настройка', false, String(e.message || e))
  }
  const li = rows.map(([n, p, d]) => `<li><b class="${p ? 'y' : 'n'}">${p ? '✓' : '✗'}</b> ${esc(n)}<small>${esc(d)}</small></li>`).join('')
  const link = ok && username ? `<p>Открой <a href="https://t.me/${esc(username)}">@${esc(username)}</a>, нажми «Start» и пришли пару треков.<br>Ссылка мини-аппа для BotFather: <code>${esc(origin)}/</code></p>` : ''
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLOW · установка</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#101219;color:#f2f2f7;max-width:640px;margin:40px auto;padding:0 18px}li{list-style:none;padding:10px 0;border-bottom:1px solid #2a2d38}small{color:#9aa0b4;display:block}b.y{color:#c6f76d}b.n{color:#ff6b7a}a{color:#c6f76d}code{color:#c6f76d}</style>
<h1>${ok ? '✅ FLOW готов' : '⚠️ Нужно поправить'}</h1><ul>${li}</ul>${link}`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  })
}

// ---------------------------------------------------------------- static assets

function isolate(response, extra = {}) {
  const res = new Response(response.body, response)
  // Cross-origin isolation lets the neural net use all cores (and WebGPU).
  res.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  res.headers.set('Cross-Origin-Embedder-Policy', 'credentialless')
  res.headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  for (const [k, v] of Object.entries(extra)) res.headers.set(k, v)
  return res
}

async function assets(request, env, url) {
  const res = await env.ASSETS.fetch(request)
  if (res.status !== 404) {
    const extra = /\.(onnx|wasm)$/.test(url.pathname) ? { 'Cache-Control': 'public, max-age=2592000' } : {}
    if (url.pathname.endsWith('.wasm')) extra['Content-Type'] = 'application/wasm'
    return isolate(res, extra)
  }
  // Big file split into <path>.part0, .part1 … at deploy time: stream them back to back.
  const parts = []
  for (let i = 0; i < 20; i++) {
    const part = await env.ASSETS.fetch(new URL(`${url.pathname}.part${i}`, url.origin).href)
    if (part.status !== 200) { part.body?.cancel(); break }
    parts.push(part)
  }
  if (!parts.length) return res
  const lengths = parts.map((p) => Number(p.headers.get('Content-Length') || 0))
  const known = lengths.every((n) => n > 0)
  const total = lengths.reduce((a, b) => a + b, 0)
  const { readable, writable } = known && typeof FixedLengthStream === 'function' ? new FixedLengthStream(total) : new TransformStream()
  ;(async () => {
    for (const p of parts) await p.body.pipeTo(writable, { preventClose: true })
    await writable.close()
  })().catch((e) => console.error('stitch', e))
  const type = url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'
  const headers = { 'Content-Type': type }
  if (known) headers['Content-Length'] = String(total)
  return isolate(new Response(readable, { headers }), {
    'Cache-Control': 'public, max-age=2592000'
  })
}
