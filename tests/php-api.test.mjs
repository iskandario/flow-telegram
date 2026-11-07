import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createHmac } from 'node:crypto'
const token = '123456789:' + 'a'.repeat(35)
function auth(id) {
  const p = new URLSearchParams({ user: JSON.stringify({ id, first_name: 'Test' }), auth_date: String(Math.floor(Date.now() / 1000)) })
  const text = [...p].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  p.set('hash', createHmac('sha256', secret).update(text).digest('hex')); return p.toString()
}
test('PHP real HTTP routes enforce Telegram identity, methods and OAuth state', async () => {
  await mkdir('work', { recursive: true })
  const dir = await mkdtemp(resolve('work/php-api-'))
  let php
  try {
    await cp('flow/api', dir + '/api', { recursive: true })
    await mkdir(dir + '/data')
    await writeFile(dir + '/api/config.local.php', `<?php return ['bot_token'=>'${token}','allowed_users'=>[],'vk_client_id'=>'123','vk_client_secret'=>'test-secret','vk_redirect_uri'=>'https://example.test/api/vk-callback.php'];`)
    await writeFile(dir + '/data/u42.json', JSON.stringify({ tracks: [{ id: 'secret-track', title: 'Private', artist: 'User42', duration: 12, size: 1024, file_id: 'not-exposed' }] }))
    const probe = createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise((r) => probe.close(r))
    php = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', dir], { stdio: 'ignore' })
    const origin = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 40; i++) {
      try { await fetch(origin + '/api/app.php'); ready = true; break } catch { await new Promise((r) => setTimeout(r, 50)) }
    }
    assert.ok(ready, 'PHP server starts')
    const call = (action, uid = 42, method = 'GET', extra = '') => fetch(`${origin}/api/app.php?a=${action}${extra}`, { method, headers: uid ? { 'X-Telegram-Init-Data': auth(uid) } : {} })
    assert.equal((await call('list', 0)).status, 401)
    const own = await (await call('list')).json()
    assert.equal(own.tracks.length, 1); assert.equal(own.tracks[0].file_id, undefined); assert.equal(own.tracks[0].source, 'telegram')
    assert.equal((await (await call('list', 99)).json()).tracks.length, 0)
    assert.equal((await call('file', 99, 'GET', '&id=secret-track')).status, 404)
    assert.equal((await call('delete')).status, 405)
    assert.equal((await call('vk-login')).status, 405)
    const login = await (await call('vk-login', 42, 'POST')).json()
    const state = new URL(login.url).searchParams.get('state')
    assert.match(state, /^42\.[a-f0-9]{64}$/)
    const stored = JSON.parse(await readFile(dir + '/data/u42.json', 'utf8'))
    assert.ok(!JSON.stringify(stored).includes(state.split('.')[1]), 'Only hash of state is stored')
    assert.equal((await fetch(origin + '/api/vk-callback.php?state=42.bad&code=bad')).status, 400)
    assert.equal((await fetch(origin + '/api/vk-callback.php?state=' + state + '&error=access_denied')).status, 400)
    assert.equal((await fetch(origin + '/api/vk-callback.php?state=' + state + '&code=replayed')).status, 400)
    assert.equal((await call('vk-logout', 42, 'POST')).status, 200)
    const loggedOut = JSON.parse(await readFile(dir + '/data/u42.json', 'utf8'))
    assert.equal(loggedOut.vk_pending, undefined); assert.equal(loggedOut.vk_exchange, undefined)
    assert.equal(loggedOut.tracks.length, 1, 'Telegram tracks survive disconnect')
  } finally { if (php) { php.kill(); await new Promise((r) => php.once('exit', r)) }; await rm(dir, { recursive: true, force: true }) }
})
