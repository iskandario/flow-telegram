import test from 'node:test'
import assert from 'node:assert/strict'
import { appLoginLink, reachedAccount, isAuthCodeResponse } from '../vk-connector/app-login.mjs'

test('VK app handoff only accepts official one-time login URLs', () => {
  assert.equal(appLoginLink('https://qr.vk.ru/ca?q=abcdef'), 'https://qr.vk.ru/ca?q=abcdef')
  for (const url of ['https://qr.vk.ru.evil.test/ca?q=abcdef', 'https://evil.test/ca?q=abcdef', 'http://qr.vk.ru/ca?q=abcdef', 'https://name@qr.vk.ru/ca?q=abcdef', 'https://qr.vk.ru:444/ca?q=abcdef', 'https://qr.vk.ru/ca?q=abcdef&redirect=https://evil.test', 'https://qr.vk.ru/ca?q=abcdef&q=other', 'https://qr.vk.ru/ca?q=abcdef#other', 'javascript:alert(1)']) assert.equal(appLoginLink(url), null)
  assert.ok(reachedAccount('https://id.vk.ru/account?flow_service=vkid_landing'))
  assert.equal(reachedAccount('https://id.vk.ru.evil.test/account'), false)
  assert.equal(reachedAccount('https://id.vk.ru/auth'), false)
  assert.equal(reachedAccount('https://id.vk.ru/accounting'), false)
  assert.ok(isAuthCodeResponse({ url: () => 'https://api.vk.ru/method/auth.getAuthCode?v=5.204' }))
  assert.equal(isAuthCodeResponse({ url: () => 'https://evil.test/method/auth.getAuthCode' }), false)
})
