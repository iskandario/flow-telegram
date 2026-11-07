// The URL comes from VK's own auth.getAuthCode response in this browser session.
// Never expose auth_hash/auth_id or accept a login URL supplied by the client.
export const APP_LOGIN_START = 'https://id.vk.ru/about/id'
export function appLoginLink(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['qr.vk.ru', 'qr.vk.com'].includes(url.hostname) || url.port || url.username || url.password || url.hash || url.pathname !== '/ca') return null
    if ([...url.searchParams.keys()].some((key) => key !== 'q') || url.searchParams.getAll('q').length !== 1 || !/^[A-Za-z0-9_-]{4,256}$/.test(url.searchParams.get('q') || '')) return null
    return url.href
  } catch { return null }
}
export function isAuthCodeResponse(response) {
  try {
    const url = new URL(response.url())
    return url.protocol === 'https:' && ['api.vk.ru', 'api.vk.com'].includes(url.hostname) && url.pathname === '/method/auth.getAuthCode'
  } catch { return false }
}
export async function startAppLogin(page) {
  await page.setViewportSize({ width: 1280, height: 900 })
  if (page.url() !== APP_LOGIN_START) await page.goto(APP_LOGIN_START, { waitUntil: 'domcontentloaded', timeout: 20000 })
  // Install before clicking: the first response can arrive immediately.
  const pending = page.waitForResponse(isAuthCodeResponse, { timeout: 20000 }).catch(() => null)
  await page.getByText('Войти через VK ID', { exact: true }).first().click({ timeout: 15000 })
  const response = await pending
  const result = response ? await response.json().catch(() => null) : null
  const url = appLoginLink(result?.response?.auth_url)
  const seconds = Number(result?.response?.expires_in)
  if (!url || !Number.isFinite(seconds) || seconds <= 0) throw new Error('VK не выдал ссылку входа. Попробуй ещё раз или открой окно VK.')
  return { stage: 'waiting', url, expiresAt: Date.now() + Math.min(seconds, 180) * 1000 }
}
export function reachedAccount(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && ['id.vk.ru', 'id.vk.com'].includes(u.hostname) && /^\/account(?:\/|$)/.test(u.pathname) } catch { return false }
}
export async function needsPhoneCode(page) {
  try {
    const url = new URL(page.url())
    if (!['id.vk.ru', 'id.vk.com'].includes(url.hostname) || url.protocol !== 'https:' || url.pathname !== '/auth') return false
    return await page.getByText(/Введите код с телефона/i).first().isVisible()
  } catch { return false }
}
export async function enterPhoneCode(page, code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new Error('Некорректный код: нужны шесть цифр из приложения VK')
  if (!await needsPhoneCode(page)) throw new Error('VK сейчас не запрашивает код с телефона. Обнови состояние входа.')
  const fields = page.locator('input:visible:not([type="hidden"]):not([type="checkbox"])')
  const count = await fields.count()
  if (count !== 1 && count !== 6) throw new Error('VK изменил форму кода. Открой окно VK и введи код там.')
  for (let i = 0; i < count; i++) await fields.nth(i).fill('')
  await fields.first().focus()
  // Real key events allow both a single OTP field and six auto-advancing boxes.
  await page.keyboard.type(code, { delay: 60 })
  return { ok: true }
}

// The primary mobile flow stays in FLOW. Read the real VK form before accepting input.
function authPage(page) {
  try { const u = new URL(page.url()); return u.protocol === 'https:' && ['id.vk.ru', 'id.vk.com'].includes(u.hostname) && u.pathname === '/auth' } catch { return false }
}
const codeFields = (page) => page.locator('input:visible:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="password"]):not([type="tel"][name="login"])')
export async function loginStep(page) {
  // VK can place a challenge over a still-visible phone form, including in an
  // iframe. Detect the blocking step first; a visible input is not proof that
  // the user can interact with it. Only inspect, never interact with challenges.
  for (const frame of page.frames()) {
    try {
      if (frame !== page.mainFrame() && !await (await frame.frameElement()).isVisible()) continue
      if (await frame.getByText(/подтвердите,?\s*что вы не робот|я не робот/i).first().isVisible()) return { stage: 'verification', reason: 'captcha' }
    } catch { /* A provider frame may detach while its next step loads. */ }
  }
  if (!authPage(page)) return { stage: 'verification' }
  if (await page.locator('input[type="tel"][name="login"]:visible').count()) return { stage: 'phone_required' }
  if (await page.locator('input[type="password"]:visible').count()) return { stage: 'verification', reason: 'password' }
  const text = await page.locator('body').innerText()
  const fields = codeFields(page), count = await fields.count()
  // Do not turn an arbitrary VK form into a code/password collector.
  if (/код|цифр/i.test(text) && (count === 1 || (count >= 4 && count <= 8))) {
    const length = count > 1 ? count : Number(await fields.first().getAttribute('maxlength'))
    const channel = /код с телефона/i.test(text) ? 'phone' : /SMS|СМС/i.test(text) ? 'sms' : /звон|последни[ех].*цифр/i.test(text) ? 'call' : /приложени|ВКонтакте/i.test(text) ? 'app' : 'unknown'
    return { stage: 'code_required', channel, codeLength: length >= 4 && length <= 8 ? length : null, invalidCode: /неверный код|неправильный код|код невер|код не подош|код ист[её]к/i.test(text) }
  }
  return { stage: 'verification' }
}
export async function startPhoneLogin(page) {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(APP_LOGIN_START, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.getByText('Войти через VK ID', { exact: true }).first().click({ timeout: 15000 })
  await page.locator('input[type="tel"][name="login"]').waitFor({ state: 'visible', timeout: 15000 })
  return { mode: 'phone', stage: 'phone_required' }
}
export async function enterLoginPhone(page, phone) {
  if (typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('Некорректный номер: укажи код страны, например +7')
  if ((await loginStep(page)).stage !== 'phone_required') throw new Error('VK уже перешёл к следующему шагу. Обнови состояние входа.')
  const field = page.locator('input[type="tel"][name="login"]')
  // VK's masked React input discards a bulk insert. Feed real key events,
  // then verify the formatted value before triggering any authentication request.
  await field.fill('')
  await field.pressSequentially(phone, { delay: 65 })
  await field.press('Tab')
  if ((await field.inputValue()).replace(/\D/g, '') !== phone.slice(1)) throw new Error('VK не принял номер в поле входа. Попробуй ещё раз.')
  try { await page.getByRole('button', { name: 'Продолжить', exact: true }).click({ timeout: 5000 }) }
  catch {
    // The click may have opened a challenge, or a challenge may now cover it.
    // Let status show the real step instead of describing this as a refusal.
    if ((await loginStep(page)).stage !== 'phone_required') return
    throw new Error('Не удалось нажать «Продолжить» в форме VK. Открой проверку VK и посмотри текущий шаг.')
  }
}
export async function enterLoginCode(page, code) {
  const step = await loginStep(page)
  if (step.stage !== 'code_required') throw new Error('VK сейчас не запрашивает код. Обнови состояние входа.')
  if (typeof code !== 'string' || !/^\d{4,8}$/.test(code) || (step.codeLength && code.length !== step.codeLength)) throw new Error('Некорректный код: введи цифры, которые запросил VK')
  const fields = codeFields(page), count = await fields.count()
  for (let i = 0; i < count; i++) await fields.nth(i).fill('')
  await fields.first().focus()
  await page.keyboard.type(code, { delay: 60 })
  // Some VK code forms submit automatically; others have a Continue button.
  const submit = page.getByRole('button', { name: /^(Продолжить|Подтвердить)$/ }).first()
  if (authPage(page) && await submit.isVisible().catch(() => false) && await submit.isEnabled().catch(() => false)) await submit.click({ timeout: 3000 }).catch(() => {})
  return { ok: true }
}
