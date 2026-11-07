import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, open } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { buildAssets, LIMIT, CHUNK } from '../cloudflare/build.mjs'
import { serveAssets } from '../cloudflare/src/assets.js'

function fixture({ missing = -1, truncated = -1 } = {}) {
  const calls = [], bytes = new TextEncoder().encode('abcdefghijklmnopqrst')
  const manifest = { '/model.onnx': { size: bytes.length, parts: 10, chunkSize: 2, etag: '"model-v1"' } }
  let cancelled = 0
  const env = { ASSETS: { async fetch(input) {
    const path = new URL(typeof input === 'string' ? input : input.url).pathname
    calls.push(path)
    if (path === '/flow-chunks.json') return Response.json(manifest)
    const match = path.match(/\.part(\d+)$/)
    if (!match) return new Response('Not found', { status: 404 })
    const index = Number(match[1])
    if (index === missing) return new Response('Missing', { status: 404 })
    let sent = false
    return new Response(new ReadableStream({
      pull(controller) {
        if (sent) return controller.close()
        sent = true
        controller.enqueue(bytes.slice(index * 2, index * 2 + (index === truncated ? 1 : 2)))
      },
      cancel() { cancelled++ }
    }, { highWaterMark: 0 }))
  } } }
  return { env, calls, cancelled: () => cancelled }
}
const request = (options) => new Request('https://flow.test/model.onnx', options)

test('large assets stream sequentially, including more than six parts', async () => {
  const f = fixture()
  const response = await serveAssets(request(), f.env)
  assert.equal(response.headers.get('Content-Length'), '20')
  assert.equal(f.calls.filter((p) => p.includes('.part')).length, 1, 'Do not open all upstream bodies before consumption')
  assert.equal(await response.text(), 'abcdefghijklmnopqrst')
  assert.equal(f.calls.filter((p) => p.includes('.part')).length, 10)
})

test('asset cancellation stops subsequent part requests', async () => {
  const f = fixture(), response = await serveAssets(request(), f.env)
  const reader = response.body.getReader()
  await reader.read()
  await reader.cancel()
  assert.equal(f.cancelled(), 1)
  assert.equal(f.calls.filter((p) => p.includes('.part')).length, 1)
})

test('missing and truncated parts fail instead of returning a partial model', async () => {
  for (const options of [{ missing: 2 }, { truncated: 2 }]) {
    const f = fixture(options), response = await serveAssets(request(), f.env)
    await assert.rejects(() => response.arrayBuffer(), /asset part/)
  }
  assert.equal((await serveAssets(request(), fixture({ missing: 0 }).env)).status, 502)
})

test('HEAD, conditional reads and unknown paths avoid opening large parts', async () => {
  const f = fixture()
  const head = await serveAssets(request({ method: 'HEAD' }), f.env)
  assert.equal(head.headers.get('Content-Length'), '20')
  assert.equal(await head.text(), '')
  assert.equal((await serveAssets(request({ headers: { 'If-None-Match': '"model-v1"' } }), f.env)).status, 304)
  assert.equal((await serveAssets(new Request('https://flow.test/nope'), f.env)).status, 404)
  assert.equal(f.calls.filter((p) => p.includes('.part')).length, 0)
})

test('build splits oversized files below the upload limit with exact reconstruction', async () => {
  await mkdir('work', { recursive: true })
  const root = await mkdtemp(resolve('work/assets-test-')), src = join(root, 'src'), out = join(root, 'public')
  try {
    await mkdir(join(src, 'stems'), { recursive: true })
    for (const name of ['index.html', 'app.js', 'dj.js', 'local-library.js', 'vk-library.js', 'vk-browser.js', 'vk-app-login.js', 'engine.js', 'lights.js', 'analysis.js', 'bpm.js', 'style.css']) await writeFile(join(src, name), 'fixture')
    const file = await open(join(src, 'stems/model.onnx'), 'w')
    await file.truncate(LIMIT + 17)
    await file.write(Buffer.from('last!'), 0, 5, LIMIT + 12)
    await file.close()
    await buildAssets(src, out)
    const entry = JSON.parse(await readFile(join(out, 'flow-chunks.json'), 'utf8'))['/stems/model.onnx']
    assert.equal(entry.size, LIMIT + 17)
    assert.equal(entry.parts, 2)
    assert.equal((await stat(join(out, 'stems/model.onnx.part0'))).size, CHUNK)
    const tail = await readFile(join(out, 'stems/model.onnx.part1'))
    assert.ok(tail.length < LIMIT)
    assert.equal(tail.subarray(-5).toString(), 'last!')
    await assert.rejects(() => stat(join(out, 'stems/model.onnx')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
