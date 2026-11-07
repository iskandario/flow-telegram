import test from 'node:test'
import assert from 'node:assert/strict'
import {audioResponse} from '../vk-connector/audio-response.mjs'
function run(range,method='GET'){const headers={};let body;const res={statusCode:200,setHeader:(k,v)=>headers[k]=v,end:b=>body=b};audioResponse({method,headers:{range}},res,Buffer.from('0123456789'));return{status:res.statusCode,headers,body:body?.toString()}}
test('native audio byte ranges support iOS probes, seeking, suffixes and HEAD',()=>{
 assert.deepEqual(run('bytes=0-1'),{status:206,headers:{'Content-Type':'audio/mpeg','Accept-Ranges':'bytes','Content-Range':'bytes 0-1/10','Content-Length':2},body:'01'})
 assert.equal(run('bytes=5-').body,'56789');assert.equal(run('bytes=-3').body,'789')
 assert.equal(run('bytes=8-99').body,'89');assert.equal(run(undefined).body,'0123456789')
 assert.equal(run('bytes=0-1','HEAD').body,undefined)
 for(const range of ['bytes=10-','bytes=3-2','bytes=-0','bytes=1-2,5-6','garbage'])assert.equal(run(range).status,416)
})
