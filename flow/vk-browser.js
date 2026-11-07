// Interactive view of the user's isolated VK browser on the FLOW server.
// Frames and input use Telegram-authenticated requests; there is no public VNC URL.
export function createVkBrowser({ api, onConnected, onLoginStep }) {
  const dialog = document.createElement('dialog')
  dialog.className = 'vk-dialog vk-browser'
  dialog.setAttribute('aria-labelledby', 'vkBrowserTitle')
  dialog.innerHTML = `<header><h2 id="vkBrowserTitle">Вход в VK</h2><button class="icon" data-close aria-label="Закрыть окно VK">✕</button></header>
    <p class="dim">Это браузер на сервере FLOW. Ввод и сессия VK передаются этому серверу. Используй сервер, которому доверяешь.</p>
    <p class="dim">Коснись нужного поля в окне VK, затем введи телефон, код или другой текст ниже. Проверки VK проходи в этом окне.</p>
    <div class="vk-screen"><img alt="Удалённое окно VK: коснись поля или кнопки" draggable="false" hidden></div>
    <form class="vk-input"><label for="vkBrowserText">Текст для выбранного поля VK</label><div class="row"><input id="vkBrowserText" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="500"><button class="ghost" type="submit">Ввести</button></div></form>
    <div class="vk-controls"><button class="ghost" data-key="Backspace">⌫</button><button class="ghost" data-key="Tab">Следующее поле</button><button class="ghost" data-key="Enter">Enter</button><button class="ghost" data-scroll="-500" aria-label="Прокрутить окно VK вверх">↑</button><button class="ghost" data-scroll="500" aria-label="Прокрутить окно VK вниз">↓</button></div>
    <div class="vk-controls"><button class="ghost" data-drag aria-pressed="false">Перетаскивать в VK</button><button class="ghost" data-check>Я вошёл — открыть музыку</button><button class="ghost" data-reload>Перезагрузить VK</button></div>
    <p data-status role="status" aria-live="polite"></p>`
  document.body.append(dialog)
  const $ = (s) => dialog.querySelector(s)
  let timer = null, generation = 0, objectUrl = null, sending = false, loading = false, ticks = 0, fetchingFrame = false, checking = false, failures = 0
  const message = (text) => { $('[data-status]').textContent = text }
  const json = async (action, data) => (await api(action, {}, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json()
  function lock() {
    for (const el of dialog.querySelectorAll('button:not([data-close]), input')) el.disabled = sending || loading
    $('img').style.pointerEvents = sending || loading ? 'none' : ''
  }
  async function check() {
    if (checking) return false
    checking = true
    try {
    const ticket = generation
    const state = await json('vk-app-login-status')
    if (ticket !== generation || !dialog.open) return
    if (state.connected) { dialog.close(); await onConnected(); return true }
    if (onLoginStep && ['phone_required', 'code_required'].includes(state.login?.stage)) { dialog.close(); await onLoginStep(); return true }
    return false
    } finally { checking = false }
  }
  async function frame(ticket) {
    if (ticket !== generation || !dialog.open || document.hidden || fetchingFrame) return
    clearTimeout(timer)
    fetchingFrame = true
    try {
      if (!sending && !loading && document.activeElement !== $('input')) {
        const res = await api('vk-browser-frame')
        const blob = await res.blob()
        if (ticket !== generation || !dialog.open) return
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        if (failures) message('Связь с окном VK восстановлена. Продолжай текущую проверку.'); failures = 0
        objectUrl = URL.createObjectURL(blob); $('img').src = objectUrl; $('img').hidden = false
        if (++ticks % 4 === 0 && await check()) return
      }
    } catch (error) { if (ticket === generation) { failures++; message(error.message + ' Повторяю обновление окна; номер заново вводить не нужно.') } }
    finally {
      fetchingFrame = false
      if (dialog.open && !document.hidden) { clearTimeout(timer); timer = setTimeout(() => frame(generation), Math.min(10000, 1500 * 2 ** Math.min(failures, 3))) }
    }
  }
  async function input(data) {
    if (sending || loading || !dialog.open) return
    const ticket = generation
    sending = true; lock()
    try { await json('vk-browser-input', data); if (ticket === generation) message('Ввод отправлен в окно VK') }
    catch (error) { if (ticket === generation) message(error.message) }
    finally { sending = false; lock() }
  }
  const point = (event) => {
    const bounds = $('img').getBoundingClientRect()
    return { x: Math.min(429, Math.max(0, Math.floor((event.clientX - bounds.left) * 430 / bounds.width))), y: Math.min(759, Math.max(0, Math.floor((event.clientY - bounds.top) * 760 / bounds.height))) }
  }
  let gesture = [], dragMode = false
  $('[data-drag]').onclick = () => {
    dragMode = !dragMode
    $('[data-drag]').setAttribute('aria-pressed', String(dragMode))
    $('img').classList.toggle('drag-mode', dragMode)
    message(dragMode ? 'Жесты передаются в VK. Выключи этот режим, чтобы прокручивать окно FLOW.' : 'Можно прокручивать окно FLOW. Касания кнопок передаются в VK.')
  }
  $('img').onpointerdown = (event) => { if (sending || loading) return; gesture = [point(event)]; $('img').setPointerCapture(event.pointerId) }
  $('img').onpointermove = (event) => { if (gesture.length && gesture.length < 39) gesture.push(point(event)) }
  $('img').onpointerup = (event) => {
    if (!gesture.length) return
    const last = point(event), first = gesture[0]
    gesture.push(last)
    const moved = gesture.some((p) => Math.hypot(p.x - first.x, p.y - first.y) > 8)
    if (moved && !dragMode) { gesture = []; return }
    const command = moved ? { type: 'drag', points: gesture } : { type: 'click', ...last }
    gesture = []; void input(command)
  }
  $('img').onpointercancel = () => { gesture = [] }
  $('form').onsubmit = (event) => {
    event.preventDefault()
    const field = $('input'), text = field.value
    if (!text || sending || loading) return
    field.value = ''
    void input({ type: 'text', text })
  }
  for (const b of dialog.querySelectorAll('[data-key]')) b.onclick = () => input({ type: 'key', key: b.dataset.key })
  for (const b of dialog.querySelectorAll('[data-scroll]')) b.onclick = () => input({ type: 'scroll', dy: Number(b.dataset.scroll) })
  $('[data-reload]').onclick = () => input({ type: 'reload' })
  $('[data-check]').onclick = async () => { try { if (!await check()) message('VK ещё не подтвердил вход. Заверши вход или проверку в окне выше.') } catch (e) { message(e.message) } }
  $('[data-close]').onclick = () => dialog.close()
  dialog.addEventListener('close', () => { generation++; clearTimeout(timer); $('input').value = ''; $('img').hidden = true; if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null })
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden && dialog.open) void frame(generation) })
  return { async open() {
    if (dialog.open) return
    dialog.showModal(); const ticket = ++generation
    ticks = 0; loading = true; lock(); message('Открываю окно VK на сервере…')
    try {
      await json('vk-browser-open', {})
      if (ticket !== generation) return
      message('Войди в VK в окне ниже. Пароль и код не сохраняются в интерфейсе FLOW.')
      loading = false; lock(); void frame(ticket)
    } catch (error) { if (ticket === generation) { loading = false; lock(); message(error.message + ' Пробую получить текущее окно без нового входа.'); void frame(ticket) } }
  } }
}
