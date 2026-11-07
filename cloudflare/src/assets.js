// Only the current part is open. Backpressure and cancellation reach ASSETS.
export async function serveAssets(request, env, url = new URL(request.url)) {
  const response = await env.ASSETS.fetch(request)
  if (response.status !== 404 || !['GET', 'HEAD'].includes(request.method)) return response
  const manifestResponse = await env.ASSETS.fetch(new URL('/flow-chunks.json', url.origin).href)
  if (!manifestResponse.ok) { await manifestResponse.body?.cancel(); return response }
  const manifest = await manifestResponse.json()
  const file = Object.hasOwn(manifest, url.pathname) ? manifest[url.pathname] : null
  if (!file) return response
  await response.body?.cancel()
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || !Number.isInteger(file.parts) || file.parts < 1 || file.parts > 45 || !Number.isSafeInteger(file.chunkSize) || file.chunkSize <= 0 || Math.ceil(file.size / file.chunkSize) !== file.parts) {
    return new Response('Invalid asset manifest', { status: 502 })
  }
  const headers = {
    'Content-Type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
    'Content-Length': String(file.size),
    'Cache-Control': 'public, max-age=0, must-revalidate',
    ETag: file.etag
  }
  if (request.headers.get('If-None-Match') === file.etag) {
    delete headers['Content-Length']
    return new Response(null, { status: 304, headers })
  }
  if (request.method === 'HEAD') return new Response(null, { headers })
  let index = 0, reader, partBytes = 0, cancelled = false
  async function nextPart() {
    const part = await env.ASSETS.fetch(new URL(`${url.pathname}.part${index}`, url.origin).href)
    if (cancelled) { await part.body?.cancel(); return }
    if (part.status !== 200 || !part.body) {
      await part.body?.cancel()
      throw new Error(`Missing asset part ${index}`)
    }
    reader = part.body.getReader(); partBytes = 0
  }
  try { await nextPart() } catch { return new Response('Asset unavailable', { status: 502 }) }
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (!cancelled) {
          const expected = Math.min(file.chunkSize, file.size - index * file.chunkSize)
          const { done, value } = await reader.read()
          if (!done) {
            partBytes += value.byteLength
            if (partBytes > expected) throw new Error(`Oversized asset part ${index}`)
            controller.enqueue(value)
            return
          }
          if (partBytes !== expected) throw new Error(`Truncated asset part ${index}`)
          reader.releaseLock(); reader = null
          if (++index === file.parts) { controller.close(); return }
          await nextPart()
        }
      } catch (error) {
        await reader?.cancel(error).catch(() => {})
        if (!cancelled) controller.error(error)
      }
    },
    async cancel(reason) { cancelled = true; await reader?.cancel(reason) }
  }, { highWaterMark: 0 })
  // Workers derives Content-Length from FixedLengthStream when available.
  const body = typeof FixedLengthStream === 'function' ? stream.pipeThrough(new FixedLengthStream(file.size)) : stream
  return new Response(body, { headers })
}
