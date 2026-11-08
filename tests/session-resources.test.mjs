import test from 'node:test'
import assert from 'node:assert/strict'
import {Sessions,skipMusicAsset} from '../vk-connector/sessions.mjs'
test('music decorations are skipped while verification assets and API requests remain available',()=>{
 const request=(type,url,page='https://vk.com/audio',child=false)=>({resourceType:()=>type,url:()=>url,frame:()=>({url:()=>page,parentFrame:()=>child?{}:null})})
 assert.equal(skipMusicAsset(request('image','https://sun.userapi.com/cover.jpg')),true)
 assert.equal(skipMusicAsset(request('image','https://sun.userapi.com/captcha.jpg','https://vk.com/challenge')),false)
 assert.equal(skipMusicAsset(request('image','https://sun.userapi.com/captcha.jpg',undefined,true)),false)
 assert.equal(skipMusicAsset(request('script','https://vk.com/code.js')),false)
 assert.equal(skipMusicAsset(request('xhr','https://api.vk.com/method/audio.get')),false)
})
test('snapshot keeps restored origins and updates current storage without opening pages',async()=>{
 let encrypted
 const sessions=new Sessions({secret:'test',directory:'/unused',store:{write:async(_,data)=>{encrypted=data},read:async()=>encrypted}})
 const retained={origin:'https://id.vk.ru',localStorage:[{name:'auth',value:'fixture'}]}
 const current={origin:'https://vk.com',localStorage:[{name:'session',value:'new'}]}
 const session={connected:true,storageOrigins:[retained],context:{cookies:async()=>[],pages:()=>[{isClosed:()=>false,url:()=>current.origin,evaluate:async()=>current}]}}
 await sessions.save('7',session)
 assert.deepEqual((await sessions.saved('7')).origins,[retained,current])
})
