import test from 'node:test'
import assert from 'node:assert/strict'
import {Sessions} from '../vk-connector/sessions.mjs'
import {list} from '../vk-connector/music.mjs'
test('catalog retries reuse successful pages, after checking authorization, and remain user isolated',async()=>{
 const sessions=new Sessions({secret:'test',directory:'/unused'});let calls=0,connected=true
 const states=new Map()
 sessions.ensure=async uid=>{if(!states.has(uid))states.set(uid,{page:{url:()=> 'https://vk.com/audio',evaluate:async()=>{calls++;return {ok:true,response:{items:[],count:0}}}}});return states.get(uid)}
 sessions.profile=async()=>({connected})
 await sessions.call('1','audio.get',{offset:0,count:200})
 await sessions.call('1','audio.get',{offset:0,count:200});assert.equal(calls,1)
 await sessions.call('2','audio.get',{offset:0,count:200});assert.equal(calls,2)
 connected=false;await assert.rejects(()=>sessions.call('1','audio.get',{offset:0,count:200}),/Войди/)
})
test('larger metadata requests advance by actual raw rows, not requested count',async()=>{
 const page=await list(async(method,args)=>{assert.equal(args.count,200);return {count:1156,items:Array.from({length:49},(_,i)=>({id:i+1,owner_id:7,title:'track',url:'https://example.test'}))}},{kind:'my',offset:49})
 assert.equal(page.nextOffset,98)
})
