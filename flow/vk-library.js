import { createVkBrowser } from './vk-browser.js'
import { createVkAppLogin } from './vk-app-login.js'
/** Mobile VK browser. The server owns authorization and resolves expiring streams. */
export function createVkLibrary({ api, onAdded, onLogout, canImport, existingIds, onChange }) {
  const dialog = document.createElement('dialog')
  dialog.className = 'vk-dialog vk-library'
  dialog.setAttribute('aria-labelledby', 'vkTitle')
  dialog.innerHTML = `<header><h2 id="vkTitle">VK Музыка</h2><button class="icon" data-close aria-label="Закрыть">✕</button></header>
    <p class="dim" data-account>Подключение…</p>
    <div data-login><p class="dim" data-login-copy>Подключи свой VK, чтобы выбирать треки и плейлисты прямо с телефона.</p>
      <button class="play" data-connect>Подключить VK</button></div>
    <div class="vk-controls"><button class="ghost" data-refresh>Обновить подключение</button><button class="ghost" data-browser-window hidden>Окно VK</button><button class="ghost" data-logout hidden>Отключить</button></div>
    <div data-browser hidden>
      <form><label class="search-field"><input type="search" placeholder="Поиск музыки в VK" aria-label="Поиск музыки в VK" maxlength="200"><button class="icon" type="submit" aria-label="Искать">⌕</button></label></form>
      <div class="vk-controls"><button class="ghost" data-my>Моя музыка</button><button class="ghost" data-playlists>Плейлисты</button></div>
      <select aria-label="Плейлист VK" hidden><option value="">Выбери плейлист</option></select>
      <button class="ghost" data-more-playlists hidden>Ещё плейлисты</button>
      <div class="vk-controls"><button class="ghost" data-select>Выбрать доступные</button><button class="ghost" data-add disabled>Добавить (0)</button></div>
      <button class="ghost" data-stop-scan hidden>Остановить загрузку списка</button><ul data-tracks></ul><button class="ghost" data-more hidden>Загрузить ещё</button>
    </div><p data-status role="status" aria-live="polite"></p>`
  document.body.append(dialog)
  const $ = (s) => dialog.querySelector(s)
  const status = (s, error = false) => { $('[data-status]').textContent = s; $('[data-status]').classList.toggle('error', error) }
  const request = async (action, params, init) => (await api(action, params, init)).json()
  let tracks = [], playlists = [], selected = new Set(), query = { kind: 'my' }, nextOffset = null, playlistOffset = 0
  let generation = 0, busy = false, adding = false, connected = false, provider = null, scanController = null, visibleLimit = 100
  const browser = createVkBrowser({ api, onConnected: () => refresh(), onLoginStep: () => appLogin.open() })
  const appLogin = createVkAppLogin({ api, onConnected: () => refresh(), onBrowser: () => browser.open() })
  function lock() {
    for (const el of dialog.querySelectorAll('button:not([data-close]):not(.track-select), input, select')) el.disabled = busy || adding
    $('[data-add]').disabled = busy || adding || !selected.size || !canImport()
    $('[data-add]').textContent = `Добавить (${selected.size})`
    $('[data-stop-scan]').disabled = !scanController
    $('[data-stop-scan]').hidden = !scanController
  }
  function render() {
    const existing = existingIds()
    $('[data-tracks]').replaceChildren(...tracks.slice(0, visibleLimit).map((track) => {
      const row = document.createElement('li')
      row.className = 'vk-row'
      const button = document.createElement('button')
      button.className = 'track-select'
      button.setAttribute('aria-pressed', String(selected.has(track.id)))
      button.disabled = adding || existing.has(track.id) || (track.restricted && provider !== 'browser')
      button.innerHTML = '<span class="tick" aria-hidden="true"></span><span class="meta"><b></b><small></small></span>'
      row.classList.toggle('track', true)
      row.classList.toggle('on', selected.has(track.id))
      button.querySelector('b').textContent = track.title
      button.querySelector('small').textContent = [track.artist, existing.has(track.id) ? 'Уже в библиотеке' : track.restricted ? (provider === 'browser' ? 'FLOW поищет доступную версию' : 'Недоступен в VK') : `${Math.floor(track.duration / 60)}:${String(track.duration % 60).padStart(2, '0')}`].filter(Boolean).join(' · ')
      button.onclick = () => { selected.has(track.id) ? selected.delete(track.id) : selected.add(track.id); render() }
      row.append(button)
      return row
    }))
    $('[data-more]').hidden = nextOffset === null && visibleLimit >= tracks.length
    $('[data-more]').textContent = visibleLimit < tracks.length ? 'Показать ещё' : 'Продолжить загрузку списка'
    lock()
    // Preserve per-row disabled state after the global toolbar lock.
    for (const [index, button] of [...dialog.querySelectorAll('[data-tracks] button')].entries()) button.disabled = busy || adding || existing.has(tracks[index].id) || (tracks[index].restricted && provider !== 'browser')
  }
  async function load(more = false) {
    if (busy || adding) return
    const ticket = ++generation, controller = new AbortController()
    scanController = controller
    const auto = query.kind === 'my' || query.kind === 'playlist'
    if (!more) { tracks = []; selected.clear(); visibleLimit = 100; nextOffset = 0 }
    busy = true; render(); status('Загружаю список музыки…')
    const map = new Map(tracks.map(t => [t.id, t]))
    try {
      do {
        const offset = nextOffset ?? 0
        const page = await request('vk-list', { ...query, offset }, { signal: controller.signal })
        if (ticket !== generation || controller.signal.aborted) return
        for (const t of page.items) map.set(t.id, t)
        tracks = [...map.values()]
        if (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)) throw new Error('VK не продвинул загрузку списка. Показана только полученная часть.')
        nextOffset = page.nextOffset
        status(nextOffset !== null && auto ? `Загружаю список: ${tracks.length} из ${page.count}. Аудиофайлы пока не скачиваются.` : tracks.length ? `Найдено ${tracks.length} из ${page.count} треков` : 'Здесь пока нет музыки')
        render()
        if (!auto || nextOffset === null) break
        // Sequential requests, with a cancellable pause to avoid hammering VK.
        await new Promise(resolve => { const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve() }; const timer = setTimeout(done, 350); controller.signal.addEventListener('abort', done, { once: true }) })
      } while (!controller.signal.aborted && ticket === generation)
    } catch (e) { if (ticket === generation && !controller.signal.aborted) status(`${e.message} Получено: ${tracks.length}. Можно продолжить.`, true) }
    finally {
      if (ticket === generation) {
        if (controller.signal.aborted) status(`Загрузка списка остановлена. Получено: ${tracks.length}. Можно продолжить.`)
        busy = false; scanController = null; render()
      }
    }
  }
  $('[data-stop-scan]').onclick = () => scanController?.abort()
  async function refresh() {
    if (busy || adding) return
    const ticket = ++generation
    busy = true; lock(); status('Проверяю подключение…')
    try {
      const result = await request('vk-status')
      if (ticket !== generation) return
      connected = result.connected
      provider = result.provider || 'oauth'
      $('[data-browser-window]').hidden = provider !== 'browser'
      $('[data-login-copy]').textContent = provider === 'browser' ? 'Введи номер и код подтверждения в FLOW. После входа сервер проверит доступ к твоей музыке.' : 'Подключи свой VK, чтобы выбирать треки и плейлисты прямо с телефона. Вход — на сайте VK.'
      $('[data-login]').hidden = connected
      $('[data-browser]').hidden = !connected
      $('[data-logout]').hidden = !connected
      $('[data-account]').textContent = connected ? `Подключён: ${result.profile?.name || 'VK'}` : 'Музыка из твоего аккаунта'
      status(result.configured ? '' : 'Владелец FLOW ещё не настроил доступ к VK Музыке. Пока можно добавить файлы с телефона или через бота.', !result.configured)
      busy = false; lock()
      $('[data-connect]').disabled = !result.configured
      if (connected) await load()
    } catch (e) { if (ticket === generation) { busy = false; lock(); status(e.message, true) } }
  }
  $('[data-close]').onclick = () => dialog.close()
  dialog.addEventListener('close', () => { if (!adding) { generation++; scanController?.abort(); scanController = null; busy = false } })
  $('[data-refresh]').onclick = refresh
  $('[data-browser-window]').onclick = () => browser.open()
  $('[data-connect]').onclick = async () => {
    if (busy || adding) return
    if (provider === 'browser') { await appLogin.open(); return }
    busy = true; lock()
    try {
      const { url } = await request('vk-login', {}, { method: 'POST' })
      if (window.Telegram?.WebApp?.openLink) window.Telegram.WebApp.openLink(url)
      else window.open(url, '_blank', 'noopener,noreferrer')
      status('Заверши вход на сайте VK, вернись сюда и нажми «Обновить подключение».')
    } catch (e) { status(e.message, true) }
    finally { busy = false; lock() }
  }
  $('[data-logout]').onclick = async () => {
    if (busy || adding) return
    if (!canImport()) { status('Сначала останови сет', true); return }
    busy = true; lock()
    try {
      await request('vk-logout', {}, { method: 'POST' })
      tracks = []; playlists = []; selected.clear(); query = { kind: 'my' }; nextOffset = null
      $('select').hidden = true; $('[data-more-playlists]').hidden = true
      await onLogout()
    } catch (e) { status(e.message, true); busy = false; lock(); return }
    busy = false; await refresh()
  }
  $('form').onsubmit = (event) => {
    event.preventDefault()
    const q = $('input').value.trim()
    query = q ? { kind: 'search', q } : { kind: 'my' }
    $('select').hidden = true
    void load()
  }
  $('[data-my]').onclick = () => { query = { kind: 'my' }; $('input').value = ''; $('select').hidden = true; void load() }
  async function loadPlaylists(more = false) {
    if (busy || adding) return
    const ticket = ++generation
    busy = true; lock(); status('Загружаю плейлисты…')
    try {
      const page = await request('vk-playlists', { offset: more ? playlistOffset : 0 })
      if (ticket !== generation) return
      playlists = more ? [...playlists, ...page.items] : page.items
      playlistOffset = page.nextOffset
      const select = $('select')
      select.replaceChildren(new Option('Выбери плейлист', ''), ...playlists.map((p, index) => new Option(`${p.title} · ${p.count}`, String(index))))
      select.hidden = false
      $('[data-more-playlists]').hidden = playlistOffset === null
      status(playlists.length ? '' : 'В VK нет плейлистов')
    } catch (e) { status(e.message, true) }
    finally { if (ticket === generation) { busy = false; render() } }
  }
  $('[data-playlists]').onclick = () => loadPlaylists()
  $('[data-more-playlists]').onclick = () => loadPlaylists(true)
  $('select').onchange = () => {
    const p = playlists[Number($('select').value)]
    if (!p || $('select').value === '') return
    $('input').value = ''
    query = { kind: 'playlist', ownerId: p.ownerId, playlistId: p.id, accessKey: p.accessKey }
    void load()
  }
  $('[data-more]').onclick = () => { if (visibleLimit < tracks.length) { visibleLimit += 100; render() } else void load(true) }
  $('[data-select]').onclick = () => {
    const existing = existingIds()
    const available = tracks.filter((t) => !existing.has(t.id) && (!t.restricted || provider === 'browser'))
    selected = selected.size === available.length ? new Set() : new Set(available.map((t) => t.id))
    render()
  }
  $('[data-add]').onclick = async () => {
    if (busy || adding || !canImport()) return
    adding = true; render(); onChange()
    const chosen = tracks.filter((t) => selected.has(t.id))
    let done = 0, failed = 0, lastError = ''
    for (const t of chosen) {
      status(`Добавляю ${done + failed + 1}/${chosen.length} · ${t.title}`)
      try {
        const data = await request('vk-add', {}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t.identity) })
        await onAdded(data.track); selected.delete(t.id); done++
      } catch (e) { failed++; lastError = e.message }
    }
    adding = false; render(); onChange()
    status(`Добавлено: ${done}.${failed ? ` Не добавлено: ${failed}. ${lastError}` : ' Треки готовы к сету.'}`, failed > 0)
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && dialog.open && !connected && !busy && !adding) void refresh() })
  return { open() { if (!dialog.open) dialog.showModal(); if (!adding) void refresh() }, get busy() { return adding } }
}
