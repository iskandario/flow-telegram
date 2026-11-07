// Same VK web API as FLOW Desktop. Runs only in the user's signed-in browser session.
export function track(raw) {
  const id = Number(raw?.id), ownerId = Number(raw?.owner_id)
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(ownerId) || !ownerId || !raw.title) return null
  return { id: `vk:${ownerId}_${id}`, source: 'vk', title: String(raw.title).slice(0, 200), artist: String(raw.artist || '').slice(0, 200), duration: Math.max(0, Number(raw.duration) || 0), size: 0,
    identity: { id, ownerId, accessKey: String(raw.access_key || '').slice(0, 200) }, restricted: !raw.url || !!raw.content_restricted }
}
function items(value) { return Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : [] }
function pageOffset(value) {
  const offset = value === undefined ? 0 : Number(value)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new Error('Некорректное смещение списка VK')
  return offset
}
async function catalog(call, query) {
  try {
    const found = await call('catalog.getAudioSearch', { query })
    const id = found?.catalog?.sections?.[0]?.id
    return id ? (await call('catalog.getSection', { section_id: id }))?.audios || [] : []
  } catch { return [] }
}
const words = (value) => String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[()[\]{}.,:;!?'"«»&+/\\_*–—-]+/g, ' ').split(/\s+/).filter(Boolean)
const bare = (value) => words(String(value || '').replace(/\s*[([].*?[)\]]/g, ' ').replace(/\s+(feat|ft|prod)\.?\s.*$/i, '')).join(' ')
export function matchScore(want, got) {
  const a = words(want.title).join(' '), b = words(got.title).join(' ')
  if (!a || !b) return 0
  const title = a === b ? 3 : bare(want.title) && bare(want.title) === bare(got.title) ? 2 : 0
  if (!title) return 0
  const artist = new Set(words(want.artist)), shared = words(got.artist).filter((w) => artist.has(w)).length
  if (artist.size && !shared) return 0
  return title + Math.min(shared, 3) + (want.duration && got.duration && Math.abs(want.duration - got.duration) <= 3 ? 2 : 0)
}
export async function list(call, query = {}) {
  const offset = pageOffset(query.offset), count = query.kind === 'search' ? 50 : 200
  let response, extra = []
  if (query.kind === 'search') {
    const q = String(query.q || '').trim().slice(0, 200)
    if (!q) return { items: [], count: 0, nextOffset: null }
    response = await call('audio.search', { q, offset, count, auto_complete: 1 })
    if (offset === 0) extra = await catalog(call, q)
  } else if (query.kind === 'playlist') {
    const owner_id = Number(query.ownerId), album_id = Number(query.playlistId)
    if (!Number.isSafeInteger(owner_id) || !owner_id || !Number.isSafeInteger(album_id) || album_id < 0) throw new Error('Некорректный плейлист VK')
    response = await call('audio.get', { owner_id, album_id, access_key: String(query.accessKey || '').slice(0, 200), offset, count })
  } else if (!query.kind || query.kind === 'my') response = await call('audio.get', { offset, count })
  else throw new Error('Неизвестный раздел VK')
  const rows = items(response), next = offset + rows.length
  const mapped = [...new Map([...extra, ...rows].map(track).filter(Boolean).map((t) => [t.id, t])).values()]
  return { items: mapped, count: Math.max(Number(response.count) || rows.length, mapped.length), nextOffset: rows.length && next < response.count ? next : null }
}
export async function playlists(call, query = {}) {
  const offset = pageOffset(query.offset)
  const response = await call('audio.getPlaylists', { offset, count: 50 }), rows = items(response), next = offset + rows.length
  return { items: rows.filter((p) => p.owner_id && Number.isSafeInteger(Number(p.id))).map((p) => ({ id: Number(p.id), ownerId: Number(p.owner_id), accessKey: String(p.access_key || '').slice(0, 200), title: String(p.title || 'Плейлист').slice(0, 200), count: Number(p.count) || 0 })), nextOffset: rows.length && next < response.count ? next : null }
}
export async function resolve(call, identity) {
  const id = Number(identity?.id), ownerId = Number(identity?.ownerId), accessKey = String(identity?.accessKey || '')
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(ownerId) || !ownerId || !/^[a-zA-Z0-9_-]{0,200}$/.test(accessKey)) throw new Error('Некорректный трек VK')
  const response = await call('audio.getById', { audios: `${ownerId}_${id}${accessKey ? '_' + accessKey : ''}` })
  const raw = items(response).find((r) => Number(r.id) === id && Number(r.owner_id) === ownerId)
  const original = track(raw)
  if (!original) throw new Error('VK не нашёл трек — возможно, он удалён')
  if (raw.url && !raw.content_restricted) return { track: original, url: raw.url }
  // As in Desktop, look for another playable upload of the same song, never bypass a restricted stream.
  const query = `${original.artist} ${original.title}`.trim()
  const found = [...await catalog(call, query), ...items(await call('audio.search', { q: query, count: 50, auto_complete: 0 }))]
  const best = found.filter((r) => r.url && !r.content_restricted && !(Number(r.id) === id && Number(r.owner_id) === ownerId))
    .map((raw) => ({ raw, score: matchScore(original, raw) })).filter((r) => r.score > 0).sort((a, b) => b.score - a.score)[0]
  if (!best) throw new Error('VK не даёт воспроизвести трек; доступной версии не найдено')
  return { track: { ...original, restricted: false, alternative: true }, url: best.raw.url }
}
