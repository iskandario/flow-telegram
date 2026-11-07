import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,copyFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
test('durable catalog jobs resume, deduplicate, isolate users, and reject commits after logout',async()=>{
 const root=await mkdtemp(tmpdir()+'/flow-sync-')
 try{
 await mkdir(root+'/api');await mkdir(root+'/data')
 for(const f of ['lib.php','vk-sync.php'])await copyFile('flow/api/'+f,root+'/api/'+f)
 await writeFile(root+'/api/config.php',"<?php return ['allowed_users'=>[], 'max_tracks'=>10000];")
 await writeFile(root+'/test.php',`<?php
 require __DIR__.'/api/lib.php';require __DIR__.'/api/vk-sync.php';
 function check($v,$s){if(!$v)throw new Exception($s);}
 function row($id){return ['id'=>'vk:7_'.$id,'identity'=>['id'=>$id,'ownerId'=>7,'accessKey'=>''],'title'=>'Track','artist'=>'Artist','source'=>'vk'];}
 $rpc=function($u,$a,$p){if($a==='status')return ['connected'=>true,'profile'=>['id'=>7]];return ['items'=>$p['offset']===0?[row(1),row(2)]:[row(2),row(3)],'count'=>4,'nextOffset'=>$p['offset']===0?2:null];};
 vk_sync_start(42);$id=read_library(42)['vk_sync']['id'];vk_sync_start(42);check(read_library(42)['vk_sync']['id']===$id,'start idempotency');
 vk_sync_step(42,$rpc);check(count(read_library(42)['tracks'])===2,'first page committed');
 // The next step reads persisted state, without a client request or in-memory job object.
 vk_sync_step(42,$rpc);check(count(read_library(42)['tracks'])===3,'dedupe');check(read_library(42)['vk_sync']['state']==='done','completion');check(count(read_library(43)['tracks'])===0,'isolation');
 vk_sync_start(42,true);vk_sync_step(42,function(){throw new Exception('temporary network error');});check(read_library(42)['vk_sync']['state']==='retry','retry saved');check(!vk_sync_step(42,$rpc),'backoff enforced');
 with_library(42,function(&$l){$l['vk_sync']['next_at']=0;});
 vk_sync_step(42,function($u,$a,$p){if($a==='status')return ['connected'=>true,'profile'=>['id'=>7]];vk_sync_cancel($u);return ['items'=>[row(999)],'count'=>1,'nextOffset'=>null];});
 check(!isset(read_library(42)['vk_sync']),'logout cancelled job');check(count(read_library(42)['tracks'])===3,'late page discarded');
 vk_sync_start(44);vk_sync_step(44,fn()=>['connected'=>false]);check(read_library(44)['vk_sync']['state']==='needs_login','human verification pauses work');
 echo 'durable jobs passed';`)
 assert.match(execFileSync('php',[root+'/test.php'],{encoding:'utf8'}),/durable jobs passed/)
 }finally{await rm(root,{recursive:true,force:true})}
})
