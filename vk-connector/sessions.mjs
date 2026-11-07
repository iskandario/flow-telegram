import { chromium } from 'playwright'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { APP_LOGIN_START, startAppLogin, reachedAccount, needsPhoneCode, enterPhoneCode, startPhoneLogin, loginStep, enterLoginPhone, enterLoginCode } from './app-login.mjs'

const WIDTH = 430, HEIGHT = 760
const METHODS = new Set(['audio.get', 'audio.getById', 'audio.search', 'audio.getPlaylists', 'catalog.getAudioSearch', 'catalog.getSection'])
const trustedPage = (value) => { try { const u = new URL(value); return u.protocol === 'https:' && /(^|\.)(vk\.com|vk\.ru|vkid\.ru)$/.test(u.hostname) } catch { return false } }
// Popup navigation may arrive before Playwright creates its Frame.
export function allowNavigation(request) {
  if (!request.isNavigationRequest()) return true
  let frame
  try { frame = request.frame() } catch { return trustedPage(request.url()) }
  return !!frame.parentFrame() || trustedPage(request.url())
}
export class Sessions {
  constructor({ secret, directory, store = null, max = 2, launch = () => chromium.launch({ headless: true }) }) {
    this.key = createHash('sha256').update('flow-vk-browser|' + secret).digest()
    this.store = store
    this.directory = directory; this.max = max; this.launch = launch
    this.sessions = new Map(); this.queues = new Map(); this.browserPromise = null; this.browser = null
    this.creating = 0
  }
  path(uid) { if (!/^\d{1,20}$/.test(String(uid))) throw new Error('Некорректный пользователь'); return join(this.directory, `${uid}.bin`) }
  async saved(uid) {
    this.path(uid)
    const remote = this.store ? await this.store.read(uid) : null
    try {
      const data = this.store ? remote : await readFile(this.path(uid))
      if (!data) return undefined
      const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(12, 28))
      const stored = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString())
      return stored.at > Date.now() - 30 * 86400000 ? stored.state : undefined
    } catch { return undefined }
  }
  async save(uid, session) {
    if (!session.connected && !session.accountVerified) return
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const plain = JSON.stringify({ at: Date.now(), state: await session.context.storageState() })
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
    if (this.store) { await this.store.write(uid, Buffer.concat([iv, cipher.getAuthTag(), encrypted])); return }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temp = this.path(uid) + '.tmp'
    await writeFile(temp, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600 })
    await rename(temp, this.path(uid))
  }
  async serial(uid, operation) {
    this.path(uid)
    const previous = this.queues.get(uid) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    this.queues.set(uid, current)
    try { return await current } finally { if (this.queues.get(uid) === current) this.queues.delete(uid) }
  }
  async ensure(uid, initialUrl = 'https://vk.com/audio') {
    let session = this.sessions.get(uid)
    if (session && !session.page.isClosed()) { session.used = Date.now(); return session }
    if (session) { this.sessions.delete(uid); await session.context.close().catch(() => {}) }
    if (this.sessions.size + this.creating >= this.max) throw new Error('Все окна VK заняты. Попробуй немного позже.')
    this.creating++
    let context
    try {
      this.browserPromise ||= this.launch().then((browser) => {
        this.browser = browser
        browser.on?.('disconnected', () => {
          if (this.browser !== browser) return
          this.browser = null; this.browserPromise = null
          this.sessions.clear()
        })
        return browser
      }).catch((e) => { this.browserPromise = null; throw e })
      const browser = await this.browserPromise
      const restoredState = await this.saved(uid)
      context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, storageState: restoredState, acceptDownloads: false, locale: 'ru-RU', serviceWorkers: 'block' })
      // Login stays on VK's own origins; neither arbitrary navigation nor downloads are exposed.
      await context.route('**/*', async (route) => {
        try {
          if (!allowNavigation(route.request())) return await route.abort()
          return await route.fallback()
        } catch {
          // Closing a page can cancel an in-flight route. Never crash other sessions.
          await route.abort().catch(() => {})
        }
      })
      const page = await context.newPage()
      session = { context, page, used: Date.now(), connected: false, lastSave: 0, restored: !!restoredState, ...(restoredState ? { appLogin: { mode: 'phone', stage: 'checking' } } : {}) }
      const attach = (current) => {
        current.on('download', (download) => void download.cancel())
        current.on('popup', (popup) => {
          if (context.pages().length > 3 || (popup.url() !== 'about:blank' && !trustedPage(popup.url()))) { void popup.close(); return }
          session.page = popup; attach(popup)
          popup.once('close', () => { if (session.page === popup) session.page = current })
        })
      }
      attach(page)
      await page.goto(restoredState ? 'https://vk.com/audio' : initialUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {
        if (!trustedPage(page.url())) throw new Error('VK не открыл окно входа. Попробуй позже.')
      })
      if (restoredState && /\/audio/.test(page.url())) {
        await page.waitForFunction(() => Number(window.vk?.id) > 0 && typeof window.vkApi?.api === 'function', {}, { timeout: 15000 }).catch(() => {})
      }
      this.sessions.set(uid, session)
      return session
    } catch (error) { await context?.close().catch(() => {}); this.sessions.delete(uid); throw error }
    finally { this.creating-- }
  }
  async profile(uid, session) {
    if (!trustedPage(session.page.url())) return { configured: true, provider: 'browser', connected: false, profile: null }
    const result = await session.page.evaluate(() => ({ id: Number(window.vk?.id) || 0, api: typeof window.vkApi?.api === 'function', name: document.querySelector('.top_profile_name, [data-testid="topnav-profile-name"], [class*="TopNavBtn__profileName"]')?.textContent?.trim() || 'VK' })).catch(() => ({ id: 0 }))
    const authenticated = result.id > 0 && result.api && !session.needsLogin
    if (authenticated && !session.musicVerified) {
      session.musicVerified = await session.page.evaluate(async () => {
        try {
          const value = await Promise.race([window.vkApi.api('audio.get', { count: 1, offset: 0, v: '5.204' }), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))])
          return Array.isArray(value?.items) && !value.error
        } catch { return false }
      }).catch(() => false)
    }
    const connected = authenticated && !!session.musicVerified
    session.connected = connected
    if (connected && Date.now() - session.lastSave > 30000) { await this.save(uid, session); session.lastSave = Date.now() }
    return { configured: true, provider: 'browser', connected, authenticated, profile: connected ? { id: result.id, name: result.name } : null, viewport: { width: WIDTH, height: HEIGHT } }
  }
  async status(uid) {
    const existing = this.sessions.get(uid)
    if (existing?.appLogin && reachedAccount(existing.page.url())) return this.appLoginStatus(uid)
    if (!existing && !await this.saved(uid)) return { configured: true, provider: 'browser', connected: false, profile: null }
    return this.profile(uid, await this.ensure(uid))
  }
  async open(uid) {
    const session = await this.ensure(uid)
    await session.page.setViewportSize({ width: WIDTH, height: HEIGHT })
    if (session.needsLogin || !trustedPage(session.page.url())) {
      await session.page.goto('https://vk.com/audio', { waitUntil: 'domcontentloaded', timeout: 45000 })
      session.needsLogin = false
    }
    return this.profile(uid, session)
  }
  async appLogin(uid) {
    const session = await this.ensure(uid, APP_LOGIN_START)
    const state = await this.profile(uid, session)
    if (state.connected) return state
    // A refresh starts a new VK login, invalidating the link shown by FLOW.
    session.appLogin = null
    session.appLogin = await startAppLogin(session.page)
    return { ...state, login: { ...session.appLogin } }
  }
  async phoneLogin(uid, restart = false) {
    const existing = this.sessions.get(uid)
    if (existing?.appLogin && !restart) return this.appLoginStatus(uid)
    const session = await this.ensure(uid, APP_LOGIN_START)
    const state = await this.profile(uid, session)
    if (state.connected) return state
    if (session.restored && !restart) return this.appLoginStatus(uid)
    session.appLogin = await startPhoneLogin(session.page)
    return this.appLoginStatus(uid)
  }
  async loginPhone(uid, phone) {
    const session = this.sessions.get(uid)
    if (!session?.appLogin || session.appLogin.mode !== 'phone') throw new Error('VK не ожидает номер. Начни подключение заново.')
    session.used = Date.now()
    await enterLoginPhone(session.page, phone)
    return { ok: true }
  }
  async appLoginStatus(uid) {
    const session = this.sessions.get(uid)
    if (!session) return { configured: true, provider: 'browser', connected: false, login: { stage: 'expired' } }
    session.used = Date.now()
    const login = session.appLogin
    if (login && reachedAccount(session.page.url())) {
      session.accountVerified = true
      await this.save(uid, session)
      login.stage = 'checking'; delete login.url
      session.needsLogin = false
      await session.page.setViewportSize({ width: WIDTH, height: HEIGHT })
      await session.page.goto('https://vk.com/audio', { waitUntil: 'domcontentloaded', timeout: 20000 })
      if (!/\/challenge/.test(session.page.url())) await session.page.waitForFunction(() => Number(window.vk?.id) > 0 && typeof window.vkApi?.api === 'function', { }, { timeout: 10000 }).catch(() => {})
    }
    const state = await this.profile(uid, session)
    if (state.connected) { session.appLogin = null; return state }
    let stage = login?.stage || 'expired'
    let detail = {}
    if (state.authenticated) stage = 'music_unavailable'
    else if (login?.mode === 'phone') { detail = await loginStep(session.page); login.stage = stage = detail.stage }
    else if (login && await needsPhoneCode(session.page)) { login.stage = stage = 'code_required'; delete login.url }
    else if (/\/challenge/.test(session.page.url())) stage = 'verification'
    else if (stage === 'waiting' && Date.now() >= login.expiresAt) stage = 'expired'
    // Only explicit account redirect + actual VK music profile can finish login.
    return { ...state, login: { ...detail, stage, expiresAt: login?.expiresAt } }
  }
  async appLoginCode(uid, code) {
    const session = this.sessions.get(uid)
    if (!session?.appLogin) throw new Error('VK не ожидает код. Начни подключение заново.')
    session.used = Date.now()
    await (session.appLogin.mode === 'phone' ? enterLoginCode(session.page, code) : enterPhoneCode(session.page, code))
    session.appLogin.stage = 'code_required'
    return { ok: true }
  }
  async input(uid, input) {
    const session = await this.ensure(uid), page = session.page
    if (input.type === 'reload') {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 })
      session.needsLogin = false
      return { ok: true }
    }
    if (!trustedPage(page.url())) throw new Error('Открой окно VK заново')
    if (input.type === 'click') {
      const x = Number(input.x), y = Number(input.y)
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) throw new Error('Некорректная точка на экране')
      await page.mouse.click(x, y)
    } else if (input.type === 'drag') {
      if (!Array.isArray(input.points) || input.points.length < 2 || input.points.length > 40 || input.points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x >= WIDTH || p.y < 0 || p.y >= HEIGHT)) throw new Error('Некорректный жест в окне VK')
      await page.mouse.move(input.points[0].x, input.points[0].y)
      await page.mouse.down()
      try { for (const point of input.points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 2 }) } finally { await page.mouse.up() }
    } else if (input.type === 'text') {
      if (typeof input.text !== 'string' || input.text.length > 500) throw new Error('Слишком длинный ввод')
      await page.keyboard.insertText(input.text)
    } else if (input.type === 'key' && ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown'].includes(input.key)) await page.keyboard.press(input.key)
    else if (input.type === 'scroll') await page.mouse.wheel(0, Math.max(-700, Math.min(700, Number(input.dy) || 0)))
    else throw new Error('Недопустимая команда окна VK')
    return { ok: true }
  }
  async frame(uid) {
    const s = await this.ensure(uid)
    try {
      // Do not fast-forward animations on an interactive verification page.
      return await s.page.screenshot({ type: 'jpeg', quality: 55, animations: 'allow', timeout: 5000 })
    } catch (error) {
      if (error.name === 'TimeoutError') throw new Error('Не удалось обновить изображение VK за 5 секунд. Текущая страница не сброшена; FLOW повторит загрузку.')
      throw error
    }
  }
  async userAgent(uid) {
    const session = await this.ensure(uid)
    return session.page.evaluate(() => navigator.userAgent)
  }
  async call(uid, method, params) {
    if (!METHODS.has(method)) throw new Error('Метод VK недоступен FLOW')
    const session = await this.ensure(uid)
    if (/\/challenge/.test(session.page.url())) throw new Error('Пройди проверку в окне VK и повтори')
    const state = await this.profile(uid, session)
    if (!state.connected) throw new Error('Войди в VK через окно подключения')
    const cacheable = ['audio.get', 'audio.getPlaylists'].includes(method)
    const cacheKey = JSON.stringify([state.profile?.id, method, params])
    session.catalogCache ||= new Map()
    const cached = session.catalogCache.get(cacheKey)
    if (cacheable && cached && Date.now()-cached.at < 120000) return cached.response
    const result = await session.page.evaluate(async ({ method, params }) => {
      try {
        const response = await Promise.race([window.vkApi.api(method, { ...params, v: '5.204' }), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 25000))])
        return { ok: true, response }
      } catch (e) { return { ok: false, code: Number(e?.error_code || e?.error?.error_code) || 0 } }
    }, { method, params })
    if (!result.ok) {
      if ([5, 14, 17].includes(result.code)) { session.needsLogin = true; session.connected = false; session.musicVerified = false; session.catalogCache?.clear(); throw new Error('VK просит подтвердить вход. Открой окно подключения.') }
      if ([6, 9, 29].includes(result.code)) throw new Error('VK временно ограничил запросы. Попробуй позже.')
      throw new Error('VK не ответил на запрос. Проверь окно подключения и повтори.')
    }
    if (cacheable && !result.response?.error) {
      for(const [key,value] of session.catalogCache)if(Date.now()-value.at>=120000)session.catalogCache.delete(key)
      while(session.catalogCache.size>=32)session.catalogCache.delete(session.catalogCache.keys().next().value)
      session.catalogCache.set(cacheKey,{at:Date.now(),response:result.response})
    }
    return result.response
  }
  async logout(uid) {
    if (this.store) await this.store.remove(uid)
    const session = this.sessions.get(uid)
    this.sessions.delete(uid)
    await session?.context.close().catch(() => {})
    await rm(this.path(uid), { force: true }); await rm(this.path(uid) + '.tmp', { force: true })
    return { ok: true }
  }
  async idle() {
    for (const [uid, s] of this.sessions) if (Date.now() - s.used > 15 * 60000 && !this.queues.has(uid)) {
      await this.serial(uid, async () => { await this.save(uid, s); this.sessions.delete(uid); await s.context.close() }).catch(() => {})
    }
  }
  async close() {
    for (const [uid, s] of this.sessions) { await this.save(uid, s).catch(() => {}); await s.context.close().catch(() => {}) }
    this.sessions.clear()
    const browser = await this.browserPromise
    await browser?.close()
  }
}
