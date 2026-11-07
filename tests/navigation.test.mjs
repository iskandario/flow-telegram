import test from 'node:test'
import assert from 'node:assert/strict'
import {allowNavigation} from '../vk-connector/sessions.mjs'
test('VK popup navigation before frame creation is safe and cannot escape trusted origins',()=>{
 const request=(url,frame)=>({url:()=>url,isNavigationRequest:()=>true,frame})
 const unavailable=()=>{throw Error('Frame not yet created')}
 assert.equal(allowNavigation(request('https://vk.com/audio',unavailable)),true)
 assert.equal(allowNavigation(request('https://example.com/',unavailable)),false)
 assert.equal(allowNavigation(request('https://vk.com.evil.test/',unavailable)),false)
 assert.equal(allowNavigation(request('https://example.com/',()=>({parentFrame:()=>null}))),false)
 assert.equal(allowNavigation(request('https://example.com/',()=>({parentFrame:()=>({})}))),true)
 assert.equal(allowNavigation({isNavigationRequest:()=>false}),true)
})
