import { chromium } from 'playwright'
import { Sessions } from '../vk-connector/sessions.mjs'
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
await mkdir('work', { recursive: true })
const directory = await mkdtemp(resolve('work/connector-browser-'))
const browser = await chromium.launch({ headless: true })
const html = `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif}input,button{display:block;width:280px;height:44px;margin:10px}</style></head><body><h1>VK test login</h1><input id="phone"><button id="login">Continue</button><script>
function login(){localStorage.setItem('signed','yes');window.vk={id:7};window.vkApi={api:async(method,params)=>({items:[{id:3,owner_id:7,title:'Track',artist:'Artist',url:'https://a.userapi.com/song.mp3'}],count:1})};document.body.innerHTML='<span class="top_profile_name">VK test user</span>'}
document.querySelector('#login').onclick=login;if(localStorage.getItem('signed'))login()
</script></body></html>`
const sessions = new Sessions({ secret: 'isolated-test-secret-'.repeat(3), directory, max: 2, launch: async () => ({
  newContext: async (options) => {
    const context = await browser.newContext(options)
    let approved = false
    await context.route('https://vk.com/**', (route) => route.fulfill({ contentType: 'text/html', body: html + (approved ? '<script>login()</script>' : '') }))
    await context.route('https://id.vk.ru/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/account') approved = true
      const body = path === '/about/id' ? '<button onclick="location.href=\'/auth\'">Войти через VK ID</button>' : path === '/auth' ? `<script>fetch("https://api.vk.ru/method/auth.getAuthCode");function codeForm(){document.body.innerHTML='<h1>Введите код с телефона</h1>'+Array.from({length:6},()=>'<input inputmode="numeric" maxlength="1">').join('');const fields=[...document.querySelectorAll('input')];fields.forEach((f,i)=>f.oninput=()=>{if(f.value.length&&i<5)fields[i+1].focus();if(fields.map(f=>f.value).join('')==='123456')location.href='/account'});fields[0].focus()}</script><form onsubmit="event.preventDefault();window.phoneSubmissions=(window.phoneSubmissions||0)+1;codeForm();document.querySelector('h1').textContent='Введите код из SMS'"><input type="tel" name="login" oninput="if(event.data &amp;&amp; event.data.length>1)this.value='';this.form.querySelector('button').disabled=this.value!=='+79001234567'"><button type="submit" disabled>Продолжить</button></form><button onclick="codeForm()">Approve fixture</button>` : '<h1>Account</h1>'
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body })
    })
    await context.route('https://api.vk.ru/method/auth.getAuthCode', (route) => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ response: { auth_url: 'https://qr.vk.ru/ca?q=fixture42', expires_in: 60, auth_hash: 'never-expose-this', auth_id: 'private' } }) }))
    return context
  },
  close: () => browser.close()
}) })
try {
  const session = await sessions.serial('42', () => sessions.ensure('42'))
  assert.equal((await sessions.status('42')).connected, false)
  const field = await session.page.locator('#phone').boundingBox()
  await sessions.input('42', { type: 'click', x: field.x + 10, y: field.y + 10 })
  await sessions.input('42', { type: 'text', text: '+79001234567' })
  assert.equal(await session.page.locator('#phone').inputValue(), '+79001234567')
  const image = await sessions.frame('42'); assert.equal(image.subarray(0, 2).toString('hex'), 'ffd8')
  const button = await session.page.locator('#login').boundingBox()
  await sessions.input('42', { type: 'click', x: button.x + 10, y: button.y + 10 })
  assert.equal((await sessions.status('42')).profile.name, 'VK test user')
  await session.saving
  assert.ok(!(await readFile(sessions.path('42'))).includes(Buffer.from('signed')))
  assert.equal((await sessions.call('42', 'audio.get', {})).items[0].title, 'Track')
  await session.page.evaluate(() => { window.vkApi.api = async () => { throw { error_code: 5 } } })
  await assert.rejects(() => sessions.call('42', 'audio.get', {offset: 1}), /подтвердить вход/)
  assert.equal((await sessions.status('42')).connected, false, 'An expired VK API session cannot close the login window as signed in')
  assert.equal((await sessions.open('42')).connected, true, 'Reopening reloads the VK page before rechecking the session')
  assert.equal((await sessions.status('43')).connected, false)
  await sessions.ensure('43')
  await assert.rejects(() => sessions.ensure('44'), /заняты/)
  await assert.rejects(() => sessions.input('42', { type: 'click', x: -1, y: 1 }), /Некорректная/)
  await assert.rejects(() => sessions.call('42', 'messages.send', {}), /недоступен/)
  session.used = Date.now() - 16 * 60000
  await sessions.idle()
  assert.equal(sessions.sessions.has('42'), false)
  assert.equal((await sessions.phoneLogin('42')).connected, true, 'Reopening login restores encrypted session on music page instead of restarting VK ID')
  // Real VK adds enumerable properties whose getItem() is null. Older snapshots
  // containing such entries must still restore valid cookies and storage.
  const restored = sessions.sessions.get('42')
  await restored.saving
  await restored.page.evaluate(() => Object.defineProperty(localStorage, 'notAStorageKey', {value:'decorator',enumerable:true,configurable:true}))
  await sessions.save('42', restored)
  assert.ok((await sessions.saved('42')).origins.every(o => o.localStorage.every(v => typeof v.value === 'string')))
  const originalSaved = sessions.saved.bind(sessions)
  sessions.saved = async uid => {
    const value = await originalSaved(uid)
    if (value?.origins?.[0]) value.origins[0].localStorage.push({name:'legacyNull',value:null})
    return value
  }
  restored.used = Date.now() - 16 * 60000
  await sessions.idle()
  assert.equal((await sessions.status('42')).connected, true, 'A legacy null value cannot break authenticated restore')
  sessions.saved = originalSaved
  await sessions.logout('42')
  assert.equal((await sessions.status('42')).connected, false)
  const app = await sessions.appLogin('43')
  assert.equal(app.login.url, 'https://qr.vk.ru/ca?q=fixture42')
  assert.equal(app.connected, false)
  assert.ok(!JSON.stringify(app).includes('never-expose-this'))
  assert.equal((await sessions.appLoginStatus('43')).login.stage, 'waiting')
  assert.equal((await sessions.status('42')).connected, false, 'Approval must stay with its Telegram user')
  const appSession = sessions.sessions.get('43')
  appSession.appLogin.expiresAt = Date.now() - 1
  assert.equal((await sessions.appLoginStatus('43')).login.stage, 'expired')
  // Only VK's account redirect, followed by a genuine music-page profile, completes the flow.
  await appSession.page.getByText('Approve fixture').click()
  assert.equal((await sessions.appLoginStatus('43')).login.stage, 'code_required', 'Scanning a QR starts a separate phone-code step, even after QR expiry')
  await assert.rejects(() => sessions.appLoginCode('43', 'bad'), /шесть цифр/)
  await sessions.appLoginCode('43', '123456')
  await appSession.page.waitForURL('https://id.vk.ru/account')
  assert.equal((await sessions.appLoginStatus('43')).connected, true)
  assert.equal(appSession.page.url(), 'https://vk.com/audio')
  assert.equal(appSession.appLogin, null)
  await sessions.logout('43')
  assert.equal((await sessions.phoneLogin('43')).login.stage, 'phone_required')
  const phonePage = sessions.sessions.get('43').page
  await phonePage.evaluate(() => {
    const iframe = document.createElement('iframe')
    iframe.id = 'challenge-fixture'; iframe.srcdoc = '<p>Подтвердите, что вы не робот</p>'
    document.body.append(iframe)
  })
  await phonePage.frameLocator('#challenge-fixture').getByText('Подтвердите, что вы не робот').waitFor()
  const challenge = (await sessions.appLoginStatus('43')).login
  assert.equal(challenge.stage, 'verification', 'A challenge takes priority over the phone form behind it')
  assert.equal(challenge.reason, 'captcha')
  await assert.rejects(() => sessions.loginPhone('43', '+79001234567'), /следующему шагу/)
  assert.equal(await phonePage.locator('input[name=login]').inputValue(), '', 'Do not type or submit behind a challenge')
  await phonePage.locator('#challenge-fixture').evaluate(el => el.hidden = true)
  assert.equal((await sessions.appLoginStatus('43')).login.stage, 'phone_required', 'An inactive challenge iframe does not block login')
  await phonePage.locator('#challenge-fixture').evaluate(el => el.remove())
  await assert.rejects(() => sessions.loginPhone('43', 'invalid'), /Некорректный/)
  await sessions.loginPhone('43', '+79001234567')
  const sms = await sessions.phoneLogin('43')
  assert.equal(sms.login.stage, 'code_required', 'Reopening preserves pending SMS instead of starting another login')
  assert.equal(sms.login.channel, 'sms')
  assert.equal(sms.login.codeLength, 6)
  assert.equal(await sessions.sessions.get('43').page.evaluate(() => window.phoneSubmissions), 1)
  await sessions.appLoginCode('43', '654321')
  assert.equal((await sessions.phoneLogin('43')).login.stage, 'code_required', 'Wrong code does not silently restart login')
  await sessions.appLoginCode('43', '123456')
  await sessions.sessions.get('43').page.waitForURL('https://id.vk.ru/account')
  assert.equal((await sessions.appLoginStatus('43')).connected, true)
  const musicSession = sessions.sessions.get('43')
  musicSession.musicVerified = false
  await musicSession.page.evaluate(() => { window.vkApi.api = async () => { throw { error_code: 15 } } })
  const denied = await sessions.status('43')
  assert.equal(denied.authenticated, true)
  assert.equal(denied.connected, false, 'Having VK globals is insufficient: audio.get must actually succeed')
  console.log('Connector Chromium: remote input, screenshot, isolated accounts, VK page API, encrypted restore and logout passed')
  console.log('Connector Chromium: VK app link, expiry, account redirect, music verification and user isolation passed (fixture account)')
} finally { await sessions.close(); await browser.close(); await rm(directory, { recursive: true, force: true }) }
