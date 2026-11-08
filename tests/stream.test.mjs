import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import { streamAudio, rewritePlaylist, StreamResources } from '../vk-connector/stream.mjs'

test('native HLS rewrites child playlists, AES keys, maps and segments without exposing CDN URLs', () => {
  const urls = []
  const text = rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init"\n#EXTINF:3,\npart.ts\n#EXT-X-ENDLIST', 'https://a.userapi.com/f/main.m3u8', url => { urls.push(url.href); return '?resource=' + urls.length })
  assert.equal(urls.length, 3)
  assert.ok(urls.every(url => url.startsWith('https://a.userapi.com/f/')))
  assert.ok(!text.includes('userapi'))
  assert.match(text, /URI="\?resource=1"/)
  assert.throws(() => rewritePlaylist('#EXTM3U\nhttps://evil.test/a', 'https://a.userapi.com/a', () => ''), /неподдерживаемый/)
  assert.throws(() => rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"', 'https://a.userapi.com/a', () => ''), /Защищённый/)
})
test('resource handles are bound to Telegram user and track, and revoked on logout', () => {
  const resources = new StreamResources()
  const id = resources.add('42', 'vk:1_2', 'https://a.userapi.com/a')
  assert.equal(resources.get('42', 'vk:1_2', id).url, 'https://a.userapi.com/a')
  assert.throws(() => resources.get('43', 'vk:1_2', id))
  assert.throws(() => resources.get('42', 'vk:1_3', id))
  resources.clear('42'); assert.throws(() => resources.get('42', 'vk:1_2', id))
})
test('audio forwards the first bytes before the upstream file finishes', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const upstream = Readable.from((async function* () { yield Buffer.alloc(8192, 1); await gate; yield Buffer.alloc(8192, 2) })())
  upstream.statusCode = 200; upstream.headers = { 'content-type': 'audio/mpeg', 'content-length': '16384' }
  const server = createServer((req, res) => streamAudio(req, res, { url: 'https://a.userapi.com/a.mp3' }, () => '', async () => upstream).catch(() => res.destroy()))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal: AbortSignal.timeout(3000) })
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.equal(first.value[0], 1); assert.ok(first.value.length <= 8192)
    release()
    let total = first.value.length
    for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.length }
    assert.equal(total, 16384)
  } finally { release(); await new Promise(resolve => server.close(resolve)) }
})
