import test from 'node:test'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { createHmac, randomBytes, createCipheriv } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve as path } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connector } from '../vk-connector/server.mjs'
import { Sessions } from '../vk-connector/sessions.mjs'
import { list, resolve, matchScore } from '../vk-connector/music.mjs'
import { hlsBytes, publicIPv4, mediaUrl, downloadAudio } from '../vk-connector/media.mjs'
const raw = { id: 3, owner_id: 7, title: 'Test Song', artist: 'Artist', duration: 180, url: 'https://a.userapi.com/song.mp3' }
const secret = 'test-connector-secret-'.repeat(3)
const run = promisify(execFile)

test('connector RPC signatures bind body, user, timestamp and nonce; streams stay private', async () => {
  const users = []
  const sessions = { serial: (_uid, fn) => fn(), status: async (uid) => ({ connected: true, profile: { id: Number(uid), name: 'VK' } }), call: async (uid) => { users.push(uid); return [raw] }, frame: async () => Buffer.from('jpeg'), input: async (uid) => { users.push(uid); return { ok: true } } }
  const server = connector({ secret, sessions, download: async () => Buffer.alloc(1024) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const signed = (data) => {
    const body = JSON.stringify(data), time = String(Date.now()), nonce = randomBytes(16).toString('hex')
    return { method: 'POST', body, headers: { 'X-Flow-Time': time, 'X-Flow-Nonce': nonce, 'X-Flow-Signature': createHmac('sha256', secret).update(`${time}\n${nonce}\n${body}`).digest('hex') } }
  }
  try {
    assert.equal((await fetch(base + '/rpc', { method: 'POST', body: '{}' })).status, 401)
    const request = signed({ uid: '7', action: 'status' })
    assert.equal((await fetch(base + '/rpc', request)).status, 200)
    assert.equal((await fetch(base + '/rpc', request)).status, 409)
    const changed = signed({ uid: '7', action: 'status' }); changed.body = JSON.stringify({ uid: '8', action: 'status' })
    assert.equal((await fetch(base + '/rpc', changed)).status, 401)
    const file = await fetch(base + '/rpc', signed({ uid: '7', action: 'file', params: { identity: { id: 3, ownerId: 7 }, vk_user: 7 } }))
    assert.equal(file.status, 200); assert.equal((await file.arrayBuffer()).byteLength, 1024)
    assert.deepEqual(users, ['7'])
    const wrongAccount = await fetch(base + '/rpc', signed({ uid: '8', action: 'file', params: { identity: { id: 3, ownerId: 7 }, vk_user: 7 } }))
    assert.equal(wrongAccount.status, 422)
    assert.equal((await fetch(base + '/rpc', signed({ uid: '7', action: 'evaluate', params: { code: 'process.env' } }))).status, 400)
  } finally { await new Promise((r) => server.close(r)) }
})

test('Desktop catalog search merges results without advancing API offset by catalog rows', async () => {
  const calls = []
  const call = async (method, params) => {
    calls.push([method, params])
    if (method === 'catalog.getAudioSearch') return { catalog: { sections: [{ id: 'section' }] } }
    if (method === 'catalog.getSection') return { audios: [{ ...raw, id: 4 }, raw] }
    return { items: [raw, raw], count: 80 }
  }
  const first = await list(call, { kind: 'search', q: 'test' })
  assert.equal(first.items.length, 2); assert.equal(first.nextOffset, 2)
  assert.equal(first.items[0].id, 'vk:7_4')
  calls.length = 0
  await list(call, { kind: 'search', q: 'test', offset: 2 })
  assert.deepEqual(calls.map(([name]) => name), ['audio.search'])
  calls.length = 0
  await list(call, { kind: 'my', offset: 10050 })
  assert.equal(calls[0][1].offset, 10050, 'Large collections must not repeat the page at offset 10000')
  await assert.rejects(() => list(call, { offset: Infinity }), /Некорректное/)
})

test('Desktop alternative lookup uses available matching uploads only', async () => {
  const result = await resolve(async (method) => {
    if (method === 'audio.getById') return [{ ...raw, url: '' }]
    if (method === 'catalog.getAudioSearch') return {}
    if (method === 'audio.search') return { items: [{ ...raw, id: 4, artist: 'Different', url: 'bad' }, { ...raw, id: 5, content_restricted: 1 }, { ...raw, id: 6, url: 'https://a.userapi.com/available.mp3' }] }
  }, { id: 3, ownerId: 7 })
  assert.equal(result.track.id, 'vk:7_3'); assert.equal(result.track.alternative, true); assert.match(result.url, /available/)
  assert.equal(matchScore(raw, { ...raw, artist: 'Different' }), 0)
  await assert.rejects(() => resolve(async () => [], { id: 3, ownerId: 7 }), /не нашёл/)
})

test('session persistence is authenticated encryption and logout erases it', async () => {
  await mkdir('work', { recursive: true }); const dir = await mkdtemp(path('work/session-test-'))
  const sessions = new Sessions({ secret, directory: dir })
  try {
    const state = { cookies: [{ name: 'remixsid', value: 'secret-cookie' }], origins: [] }
    await sessions.save('42', { connected: true, context: { cookies: async () => state.cookies, pages: () => [] } })
    const bytes = await readFile(sessions.path('42'))
    assert.ok(!bytes.includes(Buffer.from('secret-cookie')))
    assert.deepEqual(await sessions.saved('42'), state)
    assert.equal(await sessions.saved('43'), undefined)
    bytes[30] ^= 1; await writeFile(sessions.path('42'), bytes)
    assert.equal(await sessions.saved('42'), undefined)
    await sessions.logout('42')
    await assert.rejects(() => readFile(sessions.path('42')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('media rejects private destinations and parses encrypted HLS, fMP4 maps, and byte ranges', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1']) assert.equal(publicIPv4(ip), false)
  assert.equal(publicIPv4('8.8.8.8'), true)
  for (const url of ['http://a.userapi.com/a', 'https://userapi.com.evil.test/a', 'https://a.userapi.com:444/a']) assert.throws(() => mediaUrl(url))
  const iv = Buffer.alloc(16); iv.writeBigUInt64BE(5n, 8)
  const key = randomBytes(16), cipher = createCipheriv('aes-128-cbc', key, iv), plain = Buffer.from('test audio')
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  const manifest = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\npart.ts\n#EXT-X-ENDLIST'
  assert.deepEqual(await hlsBytes('https://a.userapi.com/a.m3u8', manifest, async (url) => url.pathname.endsWith('key') ? key : encrypted), plain)
  const mapped = '#EXTM3U\n#EXT-X-MAP:URI="init"\n#EXT-X-BYTERANGE:3@1\nfile\n#EXT-X-BYTERANGE:2\nfile\n#EXT-X-ENDLIST'
  assert.equal((await hlsBytes('https://a.userapi.com/a.m3u8', mapped, async (u) => Buffer.from(u.pathname.endsWith('init') ? 'INIT' : '01234567'))).toString(), 'INIT12345')
  await assert.rejects(() => hlsBytes('https://a.userapi.com/a', '#EXTM3U\nfile', async () => plain), /эфиры/)
  await assert.rejects(() => hlsBytes('https://a.userapi.com/a', '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXT-X-ENDLIST', async () => plain), /Защищённый/)
})

test('connector remuxes synthetic AAC HLS without re-encoding, with real ffmpeg', async (t) => {
  try { await run('ffmpeg', ['-version']) } catch { t.skip('ffmpeg unavailable'); return }
  await mkdir('work', { recursive: true }); const dir = await mkdtemp(path('work/connector-hls-'))
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-c:a', 'aac', '-f', 'mpegts', dir + '/segment'])
    const segment = await readFile(dir + '/segment')
    const result = await downloadAudio('https://a.userapi.com/a.m3u8', { fetch: async (url) => url.pathname.endsWith('.m3u8') ? Buffer.from('#EXTM3U\n#EXTINF:1,\npart.ts\n#EXT-X-ENDLIST') : segment })
    assert.equal(result.subarray(4, 8).toString(), 'ftyp'); assert.ok(result.length > 512)
    await writeFile(dir + '/result.m4a', result)
    const probe = await run('ffprobe', ['-v','error','-show_entries','stream=codec_name','-of','csv=p=0',dir+'/result.m4a'])
    assert.equal(probe.stdout.trim(), 'aac')
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('browser capacity counts concurrent openings once and recovers after disconnect', async () => {
  await mkdir('work', { recursive: true }); const directory = await mkdtemp(path('work/browser-capacity-'))
  const browsers = [], gates = []
  const sessions = new Sessions({ secret, directory, max: 2, launch: async () => {
    const browser = new EventEmitter()
    browser.close = async () => {}
    browser.newContext = async () => ({
      route: async () => {}, close: async () => {},
      newPage: async () => ({ isClosed: () => false, on() {}, goto: () => new Promise((resolve) => gates.push(resolve)) })
    })
    browsers.push(browser); return browser
  } })
  try {
    const first = sessions.ensure('1')
    while (gates.length < 1) await new Promise((r) => setTimeout(r, 5))
    const second = sessions.ensure('2')
    while (gates.length < 2) await new Promise((r) => setTimeout(r, 5))
    await assert.rejects(() => sessions.ensure('3'), /заняты/)
    gates.splice(0).forEach((release) => release())
    await Promise.all([first, second])
    assert.equal(sessions.sessions.size, 2)
    browsers[0].emit('disconnected')
    assert.equal(sessions.sessions.size, 0)
    const recovered = sessions.ensure('3')
    while (gates.length < 1) await new Promise((r) => setTimeout(r, 5))
    gates.shift()(); await recovered
    assert.equal(browsers.length, 2)
    assert.equal(sessions.sessions.size, 1)
  } finally { await sessions.close(); await rm(directory, { recursive: true, force: true }) }
})

test('successive native media ranges reuse the resolved URL without touching the VK browser', async () => {
  let calls=0, checks=0
  const sessions={serial:(_uid,fn)=>fn(),status:async()=>{checks++;return {connected:true,profile:{id:7}}},call:async()=>{calls++;return [raw]},logout:async()=>({ok:true})}
  const server=connector({secret,sessions,stream:async(_req,res)=>res.end('audio')})
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const call=async(action,params={})=>{
    const body=JSON.stringify({uid:'7',action,params}),time=String(Date.now()),nonce=randomBytes(16).toString('hex')
    const r=await fetch(`http://127.0.0.1:${server.address().port}/rpc`,{method:'POST',body,headers:{'X-Flow-Time':time,'X-Flow-Nonce':nonce,'X-Flow-Signature':createHmac('sha256',secret).update(`${time}\n${nonce}\n${body}`).digest('hex')}})
    await r.text();return r.status
  }
  const params={identity:{id:3,ownerId:7},vk_user:7,track_id:'vk:7_3'}
  try {
    assert.equal(await call('stream',params),200)
    assert.equal(await call('stream',params),200)
    assert.equal(calls,1);assert.equal(checks,1)
    assert.equal(await call('stream',{...params,vk_user:8}),422)
    await call('logout');await call('stream',params)
    assert.equal(calls,2,'Logout invalidates the resolved URL')
  } finally {await new Promise(r=>server.close(r))}
})
