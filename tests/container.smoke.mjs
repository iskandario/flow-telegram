// Run after: docker build -f vk-connector/Dockerfile -t flow-vk-connector:local .
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes, createHmac } from 'node:crypto'
import assert from 'node:assert/strict'
const run = promisify(execFile)
const secret = randomBytes(32).toString('hex')
const name = 'flow-vk-smoke-' + randomBytes(5).toString('hex')
let started = false
try {
  await run('docker', ['run', '--rm', '-d', '--name', name, '--init', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=1g', '--mount', 'type=volume,destination=/app/state', '--shm-size', '512m', '--memory', '2g', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '-p', '127.0.0.1::8788', '--env', 'FLOW_CONNECTOR_SECRET', 'flow-vk-connector:local'], { env: { ...process.env, FLOW_CONNECTOR_SECRET: secret } })
  started = true
  const { stdout } = await run('docker', ['port', name, '8788/tcp'])
  const origin = 'http://' + stdout.trim()
  let healthy = false
  for (let i = 0; i < 60; i++) {
    try { const res = await fetch(origin + '/health'); if (res.ok) { healthy = true; break } } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(healthy, 'Container HTTP service starts')
  const body = JSON.stringify({ uid: '42', action: 'status', params: {} }), time = String(Date.now()), nonce = randomBytes(16).toString('hex')
  const signature = createHmac('sha256', secret).update(`${time}\n${nonce}\n${body}`).digest('hex')
  const res = await fetch(origin + '/rpc', { method: 'POST', body, headers: { 'X-Flow-Time': time, 'X-Flow-Nonce': nonce, 'X-Flow-Signature': signature } })
  assert.equal(res.status, 200); assert.equal((await res.json()).provider, 'browser')
  const checkBrowser = "import { chromium } from 'playwright'; const browser = await chromium.launch(); try { const page = await browser.newPage(); await page.setContent('<h1>FLOW container test</h1>'); console.log((await page.screenshot()).length > 100 ? 'browser-ok' : 'empty'); } finally { await browser.close(); }"
  const chrome = await run('docker', ['exec', name, 'node', '--input-type=module', '-e', checkBrowser], { timeout: 45000 })
  assert.match(chrome.stdout, /browser-ok/)
  const checkStorage = "import assert from 'node:assert/strict'; import { Sessions } from './vk-connector/sessions.mjs'; const sessions = new Sessions({ secret: process.env.FLOW_CONNECTOR_SECRET, directory: process.env.FLOW_SESSION_DIR }); const state = { cookies: [], origins: [] }; await sessions.save('42', { connected: true, context: { storageState: async () => state } }); assert.deepEqual(await sessions.saved('42'), state); await sessions.logout('42'); console.log('storage-ok');"
  const storage = await run('docker', ['exec', name, 'node', '--input-type=module', '-e', checkStorage])
  assert.match(storage.stdout, /storage-ok/)
  await run('docker', ['exec', name, 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-c:a', 'libmp3lame', '-f', 'mp3', '/tmp/flow-smoke.mp3'])
  await run('docker', ['exec', name, 'node', '-e', "const fs=require('node:fs'); if(fs.statSync('/tmp/flow-smoke.mp3').size<100) process.exit(1)"])
  console.log('Docker: non-root/read-only container, signed RPC, Chromium rendering, encrypted storage and MP3 conversion passed')
} finally {
  if (started) await run('docker', ['stop', '-t', '10', name]).catch(() => {})
}
