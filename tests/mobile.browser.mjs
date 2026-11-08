import { chromium, webkit } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve('flow')
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://local').pathname
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
    if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return }
    const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream')
    res.end(await readFile(file))
  } catch { res.writeHead(404).end() }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
function wav() {
  const rate = 22050, samples = rate * 12, bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * (i % (rate / 2) < 800 ? 16000 : 1000)), 44 + i * 2)
  return bytes
}
const browserType = process.env.FLOW_BROWSER === 'webkit' ? webkit : chromium
const browser = await browserType.launch({ headless: true, ...(browserType === chromium ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {}) })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  const page = await context.newPage()
  page.on('pageerror', (error) => { errors.push(error.message); console.error(error.message) })
  await page.route('https://telegram.org/**', (route) => route.fulfill({ contentType: 'text/javascript', body: '' }))
  await page.addInitScript(() => { window.Telegram = { WebApp: { initData: 'test-auth', ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {}, disableVerticalSwipes() {}, openLink(url) { window.openedVk = url }, showConfirm(_, cb) { cb(true) } } } })
  await page.addInitScript(() => {
    window.idbErrors = []
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args)
      request.addEventListener('error', () => window.idbErrors.push({ name: request.error?.name, message: request.error?.message }))
      return request
    }
  })
  let tracks = [{ id: 'tg1', title: 'Telegram track', artist: 'Artist', duration: 12, size: 1000, source: 'telegram' }]
  const vk1 = { id: 'vk:7_1', title: '<img src=x onerror=alert(1)>', artist: 'VK Artist', source: 'vk', duration: 12, identity: { id: 1, ownerId: 7, accessKey: '' }, restricted: false }
  const vk2 = { ...vk1, id: 'vk:7_2', title: 'Second track', identity: { id: 2, ownerId: 7, accessKey: '' } }
  const locked = { ...vk1, id: 'vk:7_3', title: 'Unavailable', restricted: true }
  let connected = false, failSecond = true
  await page.route('**/api/app.php?**', async (route) => {
    const url = new URL(route.request().url()), action = url.searchParams.get('a')
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (action === 'media-session') return send({ ok: true })
    if (action === 'list') return send({ tracks, user: { id: 42, name: 'Test User' } })
    if (action === 'vk-status') return send({ configured: true, connected, profile: connected ? { name: 'VK User', id: 7 } : null })
    if (action === 'vk-login') return send({ url: 'https://oauth.vk.com/authorize?state=test' })
    if (action === 'vk-list') return send({ items: url.searchParams.get('offset') === '50' ? [vk1, vk2] : [vk1, locked], count: 3, nextOffset: url.searchParams.get('offset') === '50' ? null : 50 })
    if (action === 'vk-playlists') return send({ items: [{ id: 1, ownerId: 7, accessKey: '', title: 'Playlist', count: 3 }], nextOffset: null })
    if (action === 'vk-add') {
      const body = route.request().postDataJSON()
      if (body.id === 2 && failSecond) { failSecond = false; return send({ error: 'VK временно недоступен' }, 422) }
      const track = body.id === 1 ? vk1 : vk2
      if (!tracks.some((t) => t.id === track.id)) tracks.push(track)
      return send({ track })
    }
    if (action === 'vk-logout') { connected = false; tracks = tracks.filter((t) => t.source !== 'vk'); return send({ ok: true }) }
    if (action === 'delete') { tracks = tracks.filter((t) => t.id !== url.searchParams.get('id')); return send({ ok: true }) }
    if (action === 'file') return route.fulfill({ contentType: 'audio/wav', body: wav() })
    return send({ error: action }, 404)
  })
  await page.goto(origin)
  await page.waitForFunction(() => document.querySelectorAll('#library .track').length === 1)
  await page.locator('#library .listen').click()
  await page.waitForFunction(() => document.querySelector('.listen-panel audio').currentTime > 0)
  assert.equal(await page.locator('.listen-panel audio').evaluate(a => a.src.startsWith('blob:')), false, 'Normal listening uses native audio requests, not a downloaded Blob')
  await page.locator('.listen-panel audio').evaluate(a => a.pause())
  await page.locator('.bottom-nav a[href="#dj"]').click()
  for (const deck of ['A', 'B']) {
    const card = page.locator(`[data-deck="${deck}"]`)
    await card.locator('[data-load]').click()
    await card.locator('[data-play]').waitFor()
    await page.waitForFunction(d => !document.querySelector(`[data-deck="${d}"] [data-play]`).disabled, deck)
    await card.locator('.dj-advanced summary').click()
    await card.locator('[data-bpm]').fill('120')
    await card.locator('[data-bpm]').dispatchEvent('change')
    await card.locator('[data-play]').click()
  }
  await page.waitForFunction(() => [...document.querySelectorAll('[data-play]')].every(b => b.textContent === 'Ⅱ'))
  await page.screenshot({path:'work/mobile-dj-updated.png',fullPage:true})
  assert.equal(await page.locator('.listen-panel audio').evaluate(a => a.paused), true)
  await page.locator('[data-deck="A"] [data-loop]').click()
  assert.equal(await page.locator('[data-deck="A"] [data-loop]').getAttribute('aria-pressed'), 'true')
  await page.locator('[data-deck="B"] [data-sync]').click()
  await page.locator('[data-deck="A"] [data-loop]').click()
  for (const deck of ['A', 'B']) await page.locator(`[data-deck="${deck}"] [data-cue]`).click()
  await page.waitForFunction(() => [...document.querySelectorAll('[data-play]')].every(b => b.textContent === '▶'))

  for (const width of [320, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 })
    for (const view of ['stage', 'settings', 'dj', 'music']) {
      await page.locator(`.bottom-nav a[href="#${view}"]`).click()
      assert.equal(await page.locator(`[data-view="${view}"]`).isVisible(), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal overflow at ${width} in ${view}`)
    }
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.bottom-nav a[href="#stage"]').click()
  await page.locator('[data-mode="mash"]').click()
  assert.equal(await page.locator('#mashPair').isVisible(), true)
  assert.match(await page.locator('#modeDescription').textContent(), /вокал/)
  await page.locator('[data-mode="mix"]').click()
  await page.screenshot({ path: 'work/mobile-studio.png', fullPage: true })
  await page.locator('.bottom-nav a[href="#music"]').click()
  await page.locator('#importVk').click()
  await page.locator('[data-connect]').click()
  await page.waitForFunction(() => window.openedVk)
  assert.match(await page.evaluate(() => window.openedVk), /oauth.vk.com/)
  connected = true
  await page.locator('[data-refresh]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-tracks] li').length === 3 && document.querySelector('[data-stop-scan]').hidden)
  assert.equal(await page.locator('[data-tracks] img').count(), 0, 'VK metadata is text, not HTML')
  assert.equal(await page.locator('[data-tracks] button').nth(1).isDisabled(), true)
  assert.equal(await page.locator('[data-more]').isVisible(), false, 'Whole library is discovered automatically')
  await page.waitForFunction(() => document.querySelectorAll('[data-tracks] li').length === 3)
  await page.locator('[data-select]').click()
  await page.locator('[data-add]').click()
  await page.waitForFunction(() => document.querySelector('[data-status]').textContent.includes('Не добавлено: 1'))
  await page.locator('[data-add]').click()
  await page.waitForFunction(() => document.querySelector('[data-status]').textContent.includes('Треки готовы'))
  await mkdir('work', { recursive: true })
  await page.screenshot({ path: 'work/mobile-vk.png' })
  await page.locator('.vk-library [data-close]').click()
  assert.equal(await page.locator('#play').isDisabled(), false, 'Playback re-enabled after import')
  await page.locator('[data-source=vk]').click()
  assert.equal(await page.locator('#library .track').count(), 2)
  await page.locator('#search').fill('Second')
  assert.equal(await page.locator('#library .track').count(), 1)
  await page.locator('#search').fill('no matches')
  assert.equal(await page.locator('#noResults').isVisible(), true)
  await page.locator('#search').fill('')
  await page.locator('[data-source=all]').click()
  await page.locator('#audioFiles').setInputFiles({ name: 'Local Artist - Phone.wav', mimeType: 'audio/wav', buffer: wav() })
  await page.waitForFunction(() => document.querySelector('#importStatus').textContent.includes('Добавлено:'))
  assert.match(await page.locator('#importStatus').textContent(), /Добавлено: 1\./, JSON.stringify(await page.evaluate(() => window.idbErrors)))
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('#library .track').length === 4)
  await page.locator('[data-source=local]').click()
  assert.equal(await page.locator('#library .track').count(), 1, 'Device files persist across reload')
  await page.locator('#library .track-select').click()
  await page.locator('#play').click()
  await page.waitForFunction(() => document.querySelector('#play').textContent.includes('Стоп'), { timeout: 20000 })
  assert.equal(await page.locator('#refresh').isDisabled(), true)
  assert.equal(await page.locator('#library .del').isDisabled(), true)
  await page.locator('#play').click()
  await page.locator('#library .del').click()
  await page.waitForFunction(() => !document.querySelector('#library .track'))
  await page.locator('[data-source=vk]').click()
  await page.locator('#library .track-select').first().click()
  await page.locator('#play').click()
  await page.waitForFunction(() => document.querySelector('#play').textContent.includes('Стоп'), { timeout: 20000 })
  await page.locator('#play').click()
  assert.ok((await page.evaluate(() => caches.keys())).includes('flow-audio-v2-42'))
  await page.locator('#importVk').click()
  await page.locator('[data-logout]').click()
  await page.waitForFunction(() => !document.querySelector('[data-login]').hidden)
  await page.locator('.vk-library [data-close]').click()
  assert.equal(await page.locator('#library .track').count(), 0)
  assert.ok(!(await page.evaluate(() => caches.keys())).includes('flow-audio-v2-42'), 'Disconnect clears audio cache')
  await page.locator('[data-source=all]').click()
  await page.screenshot({ path: 'work/mobile-library.png', fullPage: true })
  assert.deepEqual(errors, [], 'No runtime errors')
  if (browserType === chromium) {
    const legacy = await page.evaluate(async () => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('flow-local-legacy-fixture', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('tracks', { keyPath: 'id' })
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('tracks', 'readwrite')
          tx.objectStore('tracks').put({ id: 'old', title: 'Old song', source: 'local', blob: new Blob(['old-audio']) })
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onerror = () => reject(tx.error)
        }
      })
      const { localLibrary } = await import('/local-library.js')
      const library = localLibrary('legacy-fixture')
      const list = await library.list(), audio = await (await library.blob('old')).text()
      await library.remove('old')
      return { list, audio, remaining: await library.list(), removedAudio: await library.blob('old') }
    })
    assert.equal(legacy.list[0].title, 'Old song'); assert.equal(legacy.audio, 'old-audio')
    assert.equal(legacy.remaining.length, 0); assert.equal(legacy.removedAudio, undefined)
  }
  await context.close()
  // Phone controls for the server browser: authenticated frames, input and return to music.
  const remote = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const loginPage = await remote.newPage()
  loginPage.on('pageerror', (error) => errors.push(error.message))
  await loginPage.route('https://telegram.org/**', (route) => route.fulfill({ contentType: 'text/javascript', body: '' }))
  await loginPage.addInitScript(() => { window.Telegram = { WebApp: { initData: 'test-auth', ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {}, disableVerticalSwipes() {}, openLink(url) { window.openedVk = url } } } })
  let signedIn = false, appStarted = false, codeRequired = false, submittedCode = null, phoneRequests = 0
  const inputs = []
  await loginPage.route('**/api/app.php?**', (route) => {
    const action = new URL(route.request().url()).searchParams.get('a')
    const send = (data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
    if (action === 'list') return send({ tracks: [], user: { id: 42 } })
    if (action === 'vk-status' || action === 'vk-browser-open') return send({ configured: true, provider: 'browser', connected: signedIn, profile: signedIn ? { id: 7, name: 'VK test' } : null })
    if (action === 'vk-phone-login') { if (route.request().postDataJSON().restart) codeRequired = false; appStarted = true; return send({ connected: signedIn, login: { stage: codeRequired ? 'code_required' : 'phone_required', channel: 'sms', codeLength: 6 } }) }
    if (action === 'vk-login-phone') { assert.equal(route.request().postDataJSON().phone, '+79001234567'); phoneRequests++; codeRequired = true; return send({ ok: true }) }
    if (action === 'vk-app-login-status') return send({ connected: signedIn, login: { stage: codeRequired ? 'code_required' : appStarted ? 'phone_required' : 'expired', channel: 'sms', codeLength: 6 } })
    if (action === 'vk-app-login-code') { submittedCode = route.request().postDataJSON().code; signedIn = submittedCode === '123456'; return send({ ok: true }) }
    if (action === 'vk-browser-frame') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="430" height="760"><rect width="430" height="760" fill="white"/><text x="20" y="40">VK login fixture</text></svg>' })
    if (action === 'vk-browser-input') { const input = route.request().postDataJSON(); inputs.push(input); if (input.key === 'Enter') signedIn = true; return send({ ok: true }) }
    if (action === 'vk-list') return send({ items: [], count: 0, nextOffset: null })
    return send({ ok: true })
  })
  await loginPage.goto(origin)
  await loginPage.locator('#importVk').click()
  await loginPage.locator('[data-connect]').click()
  await loginPage.locator('#vkLoginPhone').waitFor({ state: 'visible' })
  await loginPage.locator('#vkLoginPhone').fill('+7 900 123 45 67')
  await loginPage.evaluate(() => {
    window.phoneDisabledDuringPoll = false
    new MutationObserver(() => { if (document.querySelector('#vkLoginPhone').disabled) window.phoneDisabledDuringPoll = true }).observe(document.querySelector('#vkLoginPhone'), { attributes: true, attributeFilter: ['disabled'] })
  })
  await loginPage.waitForTimeout(3400)
  assert.equal(await loginPage.evaluate(() => document.activeElement.id), 'vkLoginPhone', 'Polling preserves keyboard focus')
  assert.equal(await loginPage.evaluate(() => window.phoneDisabledDuringPoll), false, 'Polling never disables the phone field')

  await loginPage.locator('[data-submit-phone]').click()
  await loginPage.locator('#vkPhoneCode').waitFor({ state: 'visible' })
  assert.equal(await loginPage.evaluate(() => window.openedVk), undefined, 'Phone login never opens a QR or leaves FLOW')
  assert.match(await loginPage.locator('[data-code-label]').textContent(), /SMS/)
  await loginPage.reload()
  await loginPage.locator('#importVk').click()
  await loginPage.locator('[data-connect]').click()
  await loginPage.locator('#vkPhoneCode').waitFor({ state: 'visible' })
  assert.equal(phoneRequests, 1, 'Reload resumes the same code step without resending SMS')
  await loginPage.locator('#vkPhoneCode').fill('654321')
  await loginPage.locator('[data-submit-code]').click()
  await loginPage.waitForFunction(() => !document.querySelector('#vkPhoneCode').disabled)
  assert.equal(await loginPage.locator('.vk-app-login').evaluate(el => el.open), true)
  await loginPage.locator('#vkPhoneCode').fill('123456')
  await loginPage.locator('[data-submit-code]').click()
  await loginPage.waitForFunction(() => !document.querySelector('.vk-app-login').open)
  assert.equal(submittedCode, '123456')
  assert.equal(await loginPage.locator('#vkPhoneCode').inputValue(), '', 'One-time code is cleared after sending')
  assert.match(await loginPage.locator('[data-account]').textContent(), /VK test/)
  signedIn = false; appStarted = false; codeRequired = false
  await loginPage.locator('[data-refresh]').click()
  await loginPage.locator('[data-connect]').click()
  await loginPage.locator('#vkLoginPhone').waitFor({ state: 'visible' })
  // Preserve a manual continuation even if an older server mislabels an overlay.
  let verificationState = { stage: 'phone_required', error: 'VK не разрешил продолжить вход. Проверь номер и повтори попытку.' }
  await loginPage.route('**/api/app.php?a=vk-app-login-status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ connected: signedIn, login: verificationState }) }))
  await loginPage.locator('.vk-app-login [data-check]').click()
  assert.equal(await loginPage.locator('.vk-app-login [data-browser]').isVisible(), true)
  await loginPage.waitForFunction(() => document.querySelector('.vk-app-login [data-status]').textContent.includes('текущую форму'))
  verificationState = { stage: 'verification', reason: 'captcha' }
  await loginPage.locator('.vk-app-login [data-check]').click()
  await loginPage.locator('#vkLoginPhone').waitFor({ state: 'hidden' })
  assert.match(await loginPage.locator('.vk-app-login [data-status]').textContent(), /не робот/)
  let openAttempts = 0, frameAttempts = 0
  await loginPage.route('**/api/app.php?a=vk-browser-open', route => {
    openAttempts++
    return route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'Server restarting'})})
  })
  await loginPage.route('**/api/app.php?a=vk-browser-frame', route => {
    frameAttempts++
    if(frameAttempts===1)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Frame unavailable'})})
    return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="430" height="760"><rect width="430" height="760" fill="white"/></svg>'})
  })
  await loginPage.locator('.vk-app-login [data-browser]').click()
  await loginPage.locator('.vk-browser img').waitFor({ state: 'visible' })
  assert.equal(openAttempts,1,'Recovery must not request a new login')
  assert.ok(frameAttempts>=2,'Frame polling recovers after open and frame errors')
  await loginPage.locator('.vk-browser img').click({ position: { x: 20, y: 20 } })
  await loginPage.waitForFunction(() => !document.querySelector('#vkBrowserText').disabled)
  await loginPage.locator('#vkBrowserText').fill('test-login-input')
  await loginPage.locator('.vk-input button').click()
  await loginPage.waitForFunction(() => !document.querySelector('#vkBrowserText').disabled)
  assert.equal(await loginPage.locator('#vkBrowserText').inputValue(), '', 'Input is cleared immediately after sending')
  assert.equal(inputs[0].type, 'click'); assert.equal(inputs[1].text, 'test-login-input')
  await loginPage.locator('[data-key=Enter]').click()
  await loginPage.locator('.vk-browser [data-check]').click()
  await loginPage.waitForFunction(() => !document.querySelector('.vk-browser').open)
  assert.match(await loginPage.locator('[data-account]').textContent(), /VK test/)
  // Scan several pages, cancel during discovery, resume, and keep the initial DOM bounded.
  let scanningOffsets = [], invalidCursor = false, failPageOnce = true
  await loginPage.route('**/api/app.php?a=vk-list&**', async route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'))
    scanningOffsets.push(offset)
    if(offset===100 && failPageOnce){failPageOnce=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Сервер FLOW временно не отвечает'})})}
    const items = Array.from({ length: Math.min(50, 250 - offset) }, (_, n) => ({ ...vk1, id: `vk:7_${offset + n + 10}`, title: `Scan ${offset + n}` }))
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items, count: 250, nextOffset: invalidCursor ? offset : offset + 50 < 250 ? offset + 50 : null }) })
  })
  await loginPage.locator('[data-my]').click()
  await loginPage.waitForFunction(() => document.querySelectorAll('[data-tracks] li').length === 50)
  await loginPage.locator('[data-stop-scan]').click()
  await loginPage.waitForFunction(() => document.querySelector('[data-stop-scan]').hidden)
  const stoppedCount = scanningOffsets.length
  await loginPage.waitForTimeout(500)
  assert.equal(scanningOffsets.length, stoppedCount, 'Stop prevents subsequent requests')
  await loginPage.reload()
  await loginPage.locator('#importVk').click()
  await loginPage.waitForFunction(() => document.querySelector('.vk-library [data-status]').textContent.includes('Найдено 250'))
  assert.equal(await loginPage.locator('[data-tracks] li').count(), 100, 'Complete metadata scan does not render the entire library')
  assert.deepEqual(scanningOffsets, [0, 50, 100, 100, 150, 200])
  await loginPage.locator('[data-more]').click()
  assert.equal(await loginPage.locator('[data-tracks] li').count(), 200)
  assert.equal(scanningOffsets.length, 6, 'Showing already discovered tracks performs no API request')
  invalidCursor = true
  await loginPage.locator('[data-my]').click()
  await loginPage.waitForFunction(() => document.querySelector('.vk-library [data-status]').textContent.includes('не продвинул'))
  assert.equal(scanningOffsets.length, 7, 'Non-advancing cursor cannot loop indefinitely')
  await remote.close()
  assert.deepEqual(errors, [], 'Remote login has no runtime errors')
  // Background mode creates a durable job and never scans VK pages from the client.
  const bgContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true})
  const bg=await bgContext.newPage();let syncStarted=false, bgTracks=[], clientScans=0
  await bg.route('https://telegram.org/**',r=>r.fulfill({contentType:'text/javascript',body:''}))
  await bg.addInitScript(()=>{window.Telegram={WebApp:{initData:'test',ready(){},expand(){}}}})
  await bg.route('**/api/app.php?**',r=>{
    const a=new URL(r.request().url()).searchParams.get('a')
    if(a==='vk-list')clientScans++
    if(a==='vk-sync-start'){assert.equal(r.request().method(),'POST');syncStarted=true}
    const value=a==='list'?{tracks:bgTracks,user:{id:88}}:a==='vk-status'?{configured:true,connected:true,provider:'browser',profile:{id:7},syncAvailable:true}:a==='vk-sync-status'?{state:bgTracks.length?'done':'queued',received:bgTracks.length,total:2}:{state:'queued',received:0}
    return r.fulfill({contentType:'application/json',body:JSON.stringify(value)})
  })
  await bg.goto(origin);await bg.locator('#importVk').click()
  await bg.waitForFunction(()=>document.querySelector('[data-sync-info]').textContent.includes('Можно закрыть'))
  assert.equal(syncStarted,true);assert.equal(clientScans,0)
  await bg.goto('about:blank')
  // Simulate server completion while the Mini App is not loaded.
  bgTracks=[vk1,vk2]
  await bg.goto(origin)
  await bg.waitForFunction(()=>document.querySelectorAll('#library .track').length===2)
  await bgContext.close()
  // A 1,156-track library must not trigger an audio download storm on opening or set startup.
  const largeContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const large = await largeContext.newPage(), requestedAudio = new Set()
  await large.addInitScript(() => { window.Telegram = { WebApp: { initData: 'test-auth', ready() {}, expand() {} } } })
  await large.route('https://telegram.org/**', route => route.fulfill({contentType:'text/javascript',body:''}))
  const largeTracks = Array.from({length:1156}, (_,i) => ({id:`large-${i}`,title:`Large ${i}`,artist:'Fixture',duration:12,source:'vk'}))
  await large.route('**/api/app.php?**', async route => {
    const u=new URL(route.request().url()),action=u.searchParams.get('a')
    if(action==='file'){requestedAudio.add(u.searchParams.get('id'));return route.fulfill({contentType:'audio/wav',body:wav()})}
    return route.fulfill({contentType:'application/json',body:JSON.stringify(action==='list'?{tracks:largeTracks,user:{id:77}}:{ok:true})})
  })
  await large.goto(origin)
  await large.waitForFunction(()=>document.querySelectorAll('#library .track').length===100)
  assert.equal(requestedAudio.size,0,'Opening a large library loads metadata only')
  await large.locator('#play').click()
  await large.waitForFunction(()=>document.querySelector('#nowTitle').textContent==='Large 0')
  await large.waitForTimeout(300)
  assert.ok(requestedAudio.size>=1 && requestedAudio.size<=2, 'Starting a set prepares at most two tracks, not all 1156')
  console.log('Large library: 1156 metadata rows, 100 initial DOM rows, '+requestedAudio.size+' audio requests at playback start')
  await largeContext.close()
  console.log('Mobile ' + browserType.name() + ': remote VK window, input and return to library passed')
  console.log('Mobile ' + browserType.name() + ': import, pagination, partial retry, local persistence, VK audio decode/playback, disconnect, accessibility and responsive layout passed')
} finally { await browser.close(); await new Promise((r) => server.close(r)) }
