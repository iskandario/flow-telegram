// Native HTML audio can request small byte ranges instead of a whole browser Blob.
export function audioResponse(req, res, bytes) {
  const length = bytes.length
  res.setHeader('Content-Type', bytes.subarray(4,8).toString() === 'ftyp' ? 'audio/mp4' : 'audio/mpeg')
  res.setHeader('Accept-Ranges', 'bytes')
  const range = req.headers.range
  let start = 0, end = length - 1
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!m || (!m[1] && !m[2])) return invalid()
    if (!m[1]) { const suffix = Number(m[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid(); start = Math.max(0, length - suffix) }
    else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), end) : end }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= length || end < start) return invalid()
    res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${length}`)
  }
  res.setHeader('Content-Length', end - start + 1)
  res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1))
  function invalid() { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${length}`); res.end() }
}
