import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm}from'node:fs/promises'
import{spawn}from'node:child_process'
import{once}from'node:events'
import{createServer}from'node:net'
import{createHmac,randomBytes}from'node:crypto'
import{RemoteState}from'../vk-connector/remote-state.mjs'
import{Sessions}from'../vk-connector/sessions.mjs'
test('PHP durable session storage survives a fresh connector, protects ciphertext and rejects replay',async()=>{
 const root=await mkdtemp('work/state-test-');await mkdir(root+'/api');await mkdir(root+'/data');
 for(const f of ['lib.php','vk-state.php'])await copyFile('flow/api/'+f,root+'/api/'+f)
 const secret='test-remote-state-secret-'.repeat(3);await writeFile(root+'/api/config.php',`<?php return ['vk_connector_secret'=>'${secret}','allowed_users'=>[]];`)
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn('php',['-S',`127.0.0.1:${port}`,'-t',root],{stdio:'ignore'});const url=`http://127.0.0.1:${port}/api/vk-state.php`
 try{
  for(let i=0;i<50;i++){try{await fetch(url);break}catch{await new Promise(r=>setTimeout(r,20))}}
  assert.equal((await fetch(url)).status,401)
  const store=new RemoteState(url,secret),sessions=new Sessions({secret,directory:root,store});
  const state={cookies:[{name:'session',value:'PRIVATE-VK-SESSION'}],origins:[]}
  await sessions.save('7',{connected:true,context:{storageState:async()=>state}})
  assert.equal((await readFile(root+'/data/vk-state/7.bin')).includes(Buffer.from('PRIVATE-VK-SESSION')),false)
  assert.deepEqual(await new Sessions({secret,directory:root,store}).saved('7'),state)
  assert.equal(await sessions.saved('8'),undefined)
  const body=JSON.stringify({uid:'7',op:'read'}),time=String(Date.now()),nonce=randomBytes(16).toString('hex');
  const signature=createHmac('sha256',secret).update(`flow-state-v1\n${time}\n${nonce}\n${body}`).digest('hex');const init={method:'POST',body,headers:{'X-Flow-Time':time,'X-Flow-Nonce':nonce,'X-Flow-Signature':signature}};
  assert.equal((await fetch(url,init)).status,200);assert.equal((await fetch(url,init)).status,409)
  await sessions.logout('7');assert.equal(await sessions.saved('7'),undefined)
  await assert.rejects(()=>new RemoteState(url,'incorrect').read('7'),/хранилище/)
  await assert.rejects(()=>store.read('../7'),/Invalid/)
 }finally{const stopped=once(child,'exit');child.kill();await stopped;await rm(root,{recursive:true,force:true})}
})
