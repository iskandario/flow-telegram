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
test('playback resolves a playable catalog entry without another VK API request',async()=>{
 const sessions=new Sessions({secret:'test',directory:'/unused'});let calls=0
 const raw={id:3,owner_id:7,title:'Track',url:'https://a.userapi.com/a.mp3'}
 const session={catalogCache:new Map([[JSON.stringify([7,'audio.get',{}]),{at:Date.now(),response:{items:[raw]}}]]),page:{url:()=> 'https://vk.com/audio',evaluate:async()=>{calls++;return {ok:true,response:[]}}}}
 sessions.ensure=async()=>session;sessions.profile=async()=>({connected:true,profile:{id:7}})
 assert.deepEqual(await sessions.call('7','audio.getById',{audios:'7_3'}),[raw]);assert.equal(calls,0)
 sessions.profile=async()=>({connected:true,profile:{id:8}})
 assert.deepEqual(await sessions.call('7','audio.getById',{audios:'7_3'}),[]);assert.equal(calls,1)
})
test('background audio preparation scans all 1156 tracks in bounded pages, without downloading audio',async()=>{
 const sessions=new Sessions({secret:'test',directory:'/unused'}),session={},offsets=[]
 sessions.sessions.set('7',session)
 sessions.call=async(uid,method,args)=>{
   assert.equal(method,'audio.get');assert.equal(args.count,200);offsets.push(args.offset)
   const items=Array.from({length:Math.min(200,1156-args.offset)},(_,i)=>({id:args.offset+i+1,owner_id:7,url:'https://a.userapi.com/a.mp3'}))
   const response={count:1156,items};sessions.rememberAudio(session,7,response);return response
 }
 sessions.warmCatalog('7',session);await session.warming
 assert.deepEqual(offsets,[0,200,400,600,800,1000]);assert.equal(session.audioUrls.size,1156)
 assert.equal(session.audioScanCount,1156);assert.equal(session.audioScanTotal,1156)
})
test('a slow or failed session backup cannot delay playback authorization',async()=>{
 const sessions=new Sessions({secret:'test',directory:'/unused'})
 let rejectSave
 sessions.save=()=>new Promise((_,reject)=>{rejectSave=reject})
 sessions.warmCatalog=()=>{}
 const session={musicVerified:true,lastSave:0,page:{url:()=> 'https://vk.com/audio',evaluate:async()=>({id:7,api:true,name:'VK'})}}
 const state=await sessions.profile('7',session)
 assert.equal(state.connected,true)
 assert.ok(session.saving)
 rejectSave(new TypeError('fetch failed'));await session.saving
 assert.equal((await sessions.profile('7',session)).connected,true)
})
