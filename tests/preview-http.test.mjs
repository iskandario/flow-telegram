import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

test('phone preview diagnostics are authenticated and never retain submitted values', async () => {
  const key = 'a'.repeat(64)
  const child = spawn(process.execPath, ['vk-connector/phone-preview.mjs'], {
    env: { ...process.env, PORT: '0', FLOW_PREVIEW_KEY: key }, stdio: ['ignore', 'pipe', 'ignore']
  })
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Preview did not start')), 8000)
      child.once('error', reject)
      child.stdout.on('data', data => { const match = String(data).match(/preview port: (\d+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
    })
    const base = `http://127.0.0.1:${port}/api/app.php?a=`
    const headers = { 'X-Flow-Preview-Key': key, 'Content-Type': 'application/json' }
    assert.equal((await fetch(base + 'preview-diagnostics')).status, 401)
    const id = 'b'.repeat(32)
    const response = await fetch(base + 'vk-login-phone', { method: 'POST', headers: { ...headers, 'X-Flow-Request-Id': id }, body: JSON.stringify({ phone: 'PRIVATE-NUMBER-SENT-BY-USER', code: 'PRIVATE-CODE' }) })
    assert.equal(response.status, 202, 'Login work is accepted without waiting for a browser operation')
    assert.equal(response.headers.get('X-Flow-Request-Id'), id)
    let diagnosticText
    for (let i = 0; i < 50; i++) {
      diagnosticText = await (await fetch(base + 'preview-diagnostics', { headers })).text()
      if (JSON.parse(diagnosticText).requests[0]?.phase === 'provider_error') break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(!diagnosticText.includes('PRIVATE'))
    const { requests } = JSON.parse(diagnosticText)
    assert.equal(requests.length, 1)
    assert.deepEqual({ ...requests[0], at: 0 }, { id, action: 'vk-login-phone', at: 0, phase: 'provider_error', status: 202 })
    const state = await (await fetch(base + 'vk-app-login-status', { headers })).json()
    assert.match(state.login.error, /VK/)
    const noAction = await fetch(base + 'vk-login-phone', { headers })
    assert.equal(noAction.status, 405)
    assert.equal((await (await fetch(base + 'preview-diagnostics', { headers })).json()).requests.length, 1)
  } finally {
    const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed
  }
})
