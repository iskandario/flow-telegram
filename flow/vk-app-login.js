// Keep login in FLOW. The server advances VK's actual form; refresh only reads its state.
export function createVkAppLogin({ api, onConnected, onBrowser }) {
  const dialog = document.createElement('dialog')
  dialog.className = 'vk-dialog vk-app-login'
  dialog.setAttribute('aria-labelledby', 'vkAppLoginTitle')
  dialog.innerHTML = `<header><h2 id="vkAppLoginTitle">Подключить VK</h2><button class="icon" data-close aria-label="Закрыть подключение VK">✕</button></header>
    <p>Введи номер, затем код подтверждения. Всё в этом окне — QR-код не нужен.</p>
    <p class="dim">Вход выполняется через сервер FLOW. Он получит доступ к твоей сессии VK для загрузки музыки. Используй сервер, которому доверяешь.</p>
    <p data-step class="dim"></p>
    <form data-phone-form hidden><label for="vkLoginPhone">Номер телефона VK</label>
      <input id="vkLoginPhone" type="tel" autocomplete="tel" inputmode="tel" placeholder="+7 900 000 00 00" maxlength="24" required>
      <button class="play" data-submit-phone type="submit">Продолжить</button></form>
    <form data-code-form hidden><label for="vkPhoneCode" data-code-label>Код подтверждения VK</label>
      <p class="dim" data-code-help></p>
      <input id="vkPhoneCode" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,8}" minlength="4" maxlength="8" placeholder="Код" required>
      <button class="play" data-submit-code type="submit">Подтвердить код</button></form>
    <p data-status role="status" aria-live="polite"></p>
    <button class="ghost" data-check>Проверить состояние</button>
    <div data-verification hidden><p data-verification-help></p><button class="ghost" data-browser>Открыть проверку VK</button></div>
    <details><summary>Начать вход заново</summary><p class="dim">Текущая попытка будет сброшена. Нажимай, только если хочешь получить новый код или изменить номер.</p><button class="ghost" data-retry>Сбросить и начать заново</button></details>`
  document.body.append(dialog)
  const $ = (selector) => dialog.querySelector(selector)
  const json = async (action, body) => (await api(action, {}, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()
  let checking = false, revision = 0
  let busy = false, timer, generation = 0, stage = 'loading', length = null, persistentError = ''
  const message = (value) => { $('[data-status]').textContent = value }
  const phone = () => $('#vkLoginPhone').value.replace(/[\s()-]/g, '')
  const validCode = () => /^\d{4,8}$/.test($('#vkPhoneCode').value) && (!length || $('#vkPhoneCode').value.length === length)
  function lock() {
    for (const element of dialog.querySelectorAll('button:not([data-close]), input')) element.disabled = busy
    $('[data-submit-phone]').disabled = busy || !/^\+[1-9]\d{7,14}$/.test(phone())
    $('[data-submit-code]').disabled = busy || !validCode()
  }
  function render(state) {
    if (state.connected) { dialog.close(); void onConnected(); return }
    const login = state.login || { stage: 'expired' }
    stage = login.stage; length = login.codeLength || null
    if (['code_required', 'checking', 'music_unavailable'].includes(stage)) $('#vkLoginPhone').value = ''
    $('[data-phone-form]').hidden = stage !== 'phone_required'
    $('[data-code-form]').hidden = stage !== 'code_required'
    const requiresVerification = ['verification', 'music_unavailable'].includes(stage)
    $('[data-verification]').hidden = !requiresVerification && !login.error && !persistentError && stage !== 'phone_required'
    $('[data-verification-help]').textContent = login.reason === 'captcha' ? 'VK просит подтвердить, что ты не робот. Открой проверку и пройди её самостоятельно. Текущая попытка входа сохранена.' : requiresVerification ? 'VK запросил дополнительную проверку. Пройди её в форме VK, затем вернись к проверке подключения.' : 'Если вход не продолжается, открой текущую форму VK: там может быть дополнительная проверка. Попытка входа сохранится, номер повторно не отправится.'
    $('[data-step]').textContent = stage === 'phone_required' ? '1 из 3 · Номер телефона' : stage === 'code_required' ? '2 из 3 · Подтверждение' : stage === 'checking' ? '3 из 3 · Доступ к музыке' : ''
    const labels = { sms: 'Код из SMS', app: 'Код из приложения VK', phone: 'Код из приложения VK', call: 'Цифры из входящего звонка', unknown: 'Код подтверждения VK' }
    $('[data-code-label]').textContent = labels[login.channel] || labels.unknown
    $('[data-code-help]').textContent = login.channel === 'sms' ? 'Введи код из SMS здесь. Переходить по ссылкам не нужно.' : login.channel === 'call' ? 'Введи цифры номера, которые запросил VK.' : 'Введи код, который запросил VK. Если открывал другое приложение, вернись в это окно — попытка входа сохранена.'
    $('#vkPhoneCode').maxLength = length || 8
    $('#vkPhoneCode').minLength = length || 4
    $('#vkPhoneCode').pattern = length ? `[0-9]{${length}}` : '[0-9]{4,8}'
    $('#vkPhoneCode').placeholder = length ? `${length} цифр` : 'Код'
    const messages = { starting: 'Открываю форму VK. Можно оставаться на этой странице.', submitting: 'VK обрабатывает запрос. Номер и код повторно не отправляются.', phone_required: 'Укажи номер с кодом страны. Способ подтверждения определяет VK.', code_required: 'Ожидаю код. Обновление страницы не запрашивает новый.', checking: 'Вход выполнен. Проверяю запрос к музыкальной библиотеке…', music_unavailable: 'Вход в VK выполнен, но VK пока не предоставил доступ к музыке. Подключение ещё не завершено.', verification: login.reason === 'password' ? 'VK запросил пароль. Введи его только в форме VK через кнопку ниже.' : 'VK запросил дополнительный шаг подтверждения.', expired: 'Попытка входа завершена. Начни заново кнопкой ниже.' }
    const error = login.error || persistentError
    message(login.invalidCode ? 'VK отклонил код. Проверь его и введи снова.' : login.reason === 'captcha' ? 'VK ожидает проверку «Я не робот». Это не отказ во входе.' : error?.startsWith('VK не разрешил продолжить вход.') ? 'Не удалось продолжить вход автоматически. Открой текущую форму VK кнопкой ниже.' : error || messages[stage] || 'Проверяю состояние VK…')
    lock()
  }
  function schedule() {
    clearTimeout(timer)
    if (dialog.open && !document.hidden && !['expired', 'verification', 'music_unavailable'].includes(stage)) timer = setTimeout(() => void check(), 3000)
  }
  async function operation(action, body) {
    if (busy) return
    const ticket = generation
    revision++; busy = true; clearTimeout(timer); lock()
    try {
      const state = await json(action, body)
      if (ticket !== generation || !dialog.open) return
      render(state)
    } catch (e) { if (ticket === generation) { persistentError = e.message; message(e.message) } }
    finally { busy = false; lock(); if (ticket === generation) schedule(); else if (dialog.open) void check() }
  }
  async function check() {
    if (busy || checking || !dialog.open) return
    const ticket = generation, version = revision
    checking = true
    try {
      const state = await json('vk-app-login-status')
      if (ticket === generation && version === revision && !busy && dialog.open) render(state)
    } catch (e) { if (ticket === generation && version === revision && !busy) message(e.message) }
    finally { checking = false; if (dialog.open && !busy) schedule() }
  }
  async function submit(action, body) {
    if (busy) return
    const ticket = generation
    revision++; busy = true; clearTimeout(timer); persistentError = ''; lock(); message('Отправляю в VK…')
    try {
      await json(action, body)
      if (ticket !== generation || !dialog.open) return
      render(await json('vk-app-login-status'))
    } catch (e) { if (ticket === generation) { persistentError = e.message; message(e.message) } }
    finally { busy = false; lock(); if (ticket === generation) schedule(); else if (dialog.open) void check() }
  }
  $('#vkLoginPhone').oninput = lock
  $('#vkPhoneCode').oninput = () => { $('#vkPhoneCode').value = $('#vkPhoneCode').value.replace(/\D/g, ''); lock() }
  $('[data-phone-form]').onsubmit = event => { event.preventDefault(); if (!busy && /^\+[1-9]\d{7,14}$/.test(phone())) void submit('vk-login-phone', { phone: phone() }) }
  $('[data-code-form]').onsubmit = event => { event.preventDefault(); if (!busy && validCode()) { const code = $('#vkPhoneCode').value; $('#vkPhoneCode').value = ''; void submit('vk-app-login-code', { code }) } }
  $('[data-check]').onclick = () => { persistentError = ''; void check() }
  $('[data-retry]').onclick = () => { persistentError = ''; $('#vkPhoneCode').value = ''; void operation('vk-phone-login', { restart: true }) }
  $('[data-browser]').onclick = () => { dialog.close(); void onBrowser() }
  $('[data-close]').onclick = () => dialog.close()
  dialog.addEventListener('close', () => { generation++; clearTimeout(timer); $('#vkPhoneCode').value = ''; $('#vkLoginPhone').value = '' })
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden && dialog.open) void check() })
  return { async open() {
    if (dialog.open) return
    dialog.showModal(); persistentError = ''; message('Восстанавливаю шаг входа…')
    // Idempotent: never replace an in-progress code form on reopen or refresh.
    await operation('vk-phone-login', {})
  } }
}
