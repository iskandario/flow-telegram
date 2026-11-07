import test from 'node:test'
import assert from 'node:assert/strict'
import {Sessions} from '../vk-connector/sessions.mjs'
test('Manual reload reloads the current page, never navigates away to audio',async()=>{
 const sessions=new Sessions({secret:'test-secret',directory:'/unused'})
 let reloaded=0
 sessions.ensure=async()=>({page:{reload:async()=>{reloaded++},goto:()=>assert.fail('Must preserve current URL')}})
 assert.deepEqual(await sessions.input('42',{type:'reload'}),{ok:true})
 assert.equal(reloaded,1)
})
test('Screenshot timeout is recoverable and does not reset or navigate the page',async()=>{
 const sessions=new Sessions({secret:'test-secret',directory:'/unused'})
 sessions.ensure=async()=>({page:{screenshot:async options=>{assert.equal(options.animations,'allow');throw Object.assign(new Error('Timeout'),{name:'TimeoutError'})}}})
 await assert.rejects(()=>sessions.frame('42'),/обновить изображение/)
})
