// Device files stay on this device, scoped to the signed-in Telegram user.
// Metadata is separate from audio so listing music never reads all file bytes.
export function localLibrary(userId) {
  let dbPromise
  function database() {
    return dbPromise ||= new Promise((resolve, reject) => {
      const request = indexedDB.open('flow-local-' + userId, 2)
      let failed = false
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio')
        // Keep v1 Blob records readable without rewriting users' audio during upgrade.
      }
      request.onsuccess = () => {
        if (failed) { request.result.close(); return }
        request.result.onversionchange = () => { request.result.close(); dbPromise = null }
        resolve(request.result)
      }
      request.onerror = () => { failed = true; dbPromise = null; reject(new Error('Хранилище телефона недоступно')) }
      request.onblocked = () => { failed = true; dbPromise = null; reject(new Error('Закрой другие окна FLOW и повтори загрузку библиотеки')) }
    })
  }
  async function run(mode, stores, operation) {
    const db = await database()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode)
      let request
      try { request = operation(tx) } catch { tx.abort(); reject(new Error('Не удалось записать файл на устройстве')); return }
      tx.oncomplete = () => resolve(request?.result)
      tx.onerror = tx.onabort = () => reject(new Error(tx.error?.name === 'QuotaExceededError' ? 'На телефоне недостаточно места для музыки' : 'Не удалось сохранить файл на устройстве'))
    })
  }
  return {
    list: async () => (await run('readonly', ['tracks'], (tx) => tx.objectStore('tracks').getAll())).map(({ blob, ...t }) => t),
    async blob(id) {
      const record = await run('readonly', ['audio'], (tx) => tx.objectStore('audio').get(id))
      if (record) return new Blob([record.bytes], { type: record.type || 'application/octet-stream' })
      return (await run('readonly', ['tracks'], (tx) => tx.objectStore('tracks').get(id)))?.blob
    },
    remove: (id) => run('readwrite', ['tracks', 'audio'], (tx) => {
      tx.objectStore('audio').delete(id)
      return tx.objectStore('tracks').delete(id)
    }),
    async add(file) {
      if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('Выбери аудиофайл до 20 МБ')
      if (!/\.(mp3|m4a|aac|wav|flac|ogg|opus|aiff?)$/i.test(file.name) && !file.type.startsWith('audio/')) throw new Error('Нужен аудиофайл')
      // ArrayBuffer storage also works where WebKit rejects IndexedDB Blob/File writes.
      const bytes = await file.arrayBuffer()
      const hash = await crypto.subtle.digest('SHA-256', bytes)
      const id = 'local:' + [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
      const name = file.name.replace(/\.[^.]+$/, '')
      const parts = name.match(/^(.+?)\s+[-–—]\s+(.+)$/)
      const track = { id, source: 'local', title: parts ? parts[2] : name, artist: parts ? parts[1] : '', duration: 0, size: file.size }
      await run('readwrite', ['tracks', 'audio'], (tx) => {
        tx.objectStore('audio').put({ bytes, type: file.type }, id)
        return tx.objectStore('tracks').put(track)
      })
      return track
    }
  }
}
