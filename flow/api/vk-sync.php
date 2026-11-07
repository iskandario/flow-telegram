<?php
declare(strict_types=1);
// Durable jobs live beside the user's library. Only the CLI worker performs VK I/O.
function vk_sync_public(?array $job): array {
    if (!$job) return ['state'=>'idle'];
    return array_intersect_key($job, array_flip(['state','received','total','offset','updated','error','next_at']));
}
function vk_sync_start(int $uid, bool $restart = false): array {
    return with_library($uid, function(array &$lib) use ($restart) {
        $job = $lib['vk_sync'] ?? null;
        if ($job && (in_array($job['state'], ['queued','running','retry'], true) || !$restart && $job['state']==='done')) return vk_sync_public($job);
        if ($job && !$restart && in_array($job['state'],['needs_login','failed'],true)) {
            $lib['vk_sync']=array_merge($job,['state'=>'queued','attempts'=>0,'next_at'=>0,'lease_until'=>0,'error'=>null,'updated'=>time()]);
            return vk_sync_public($lib['vk_sync']);
        }
        $lib['vk_sync']=['id'=>bin2hex(random_bytes(16)), 'state'=>'queued','offset'=>0,'received'=>0,'total'=>null,'seen'=>[], 'attempts'=>0,'next_at'=>0,'updated'=>time()];
        return vk_sync_public($lib['vk_sync']);
    });
}
function vk_sync_cancel(int $uid): void {
    with_library($uid, function(array &$lib) { unset($lib['vk_sync']); });
}
function vk_sync_step(int $uid, callable $rpc): bool {
    if (!user_allowed($uid)) return false;
    // Claim one page under a short lock. Never hold the library lock over network I/O.
    $job = with_library($uid, function(array &$lib) {
        $j=$lib['vk_sync']??null;
        if (!$j || !in_array($j['state'],['queued','running','retry'],true) || ($j['next_at']??0)>time() || ($j['lease_until']??0)>time()) return null;
        $j['state']='running'; $j['lease']=bin2hex(random_bytes(12));$j['lease_until']=time()+240;$j['updated']=time();
        return $lib['vk_sync']=$j;
    });
    if (!$job) return false;
    try {
        $state=$rpc($uid,'status',[]);
        if (empty($state['connected'])) $state=$rpc($uid,'app-login-status',[]);
        if (empty($state['connected'])) throw new RuntimeException('VK требует подтверждения. Открой подключение VK в FLOW.');
        $vkUser=(int)($state['profile']['id']??0);
        if (!$vkUser || isset($job['vk_user']) && $job['vk_user']!==$vkUser) throw new RuntimeException('Аккаунт VK изменился. Запусти синхронизацию заново.');
        $page=$rpc($uid,'list',['kind'=>'my','offset'=>$job['offset']]);
        $next=$page['nextOffset']??null;
        if (!isset($page['items']) || !is_array($page['items']) || $next!==null && (!is_int($next)||$next<=$job['offset'])) throw new RuntimeException('VK вернул некорректную страницу списка.');
        with_library($uid,function(array &$lib) use($job,$page,$next,$vkUser) {
            $current=$lib['vk_sync']??null;
            if (!$current || $current['id']!==$job['id'] || ($current['lease']??null)!==$job['lease']) return;
            $tracks=[];foreach($lib['tracks'] as $t)$tracks[$t['id']]=$t;
            $seen=$job['seen'];
            foreach($page['items'] as $t) {
                if (!is_array($t)||!isset($t['id'],$t['identity'],$t['title'],$t['artist'])||($t['source']??'')!=='vk') continue;
                if (!isset($tracks[$t['id']]) && count($tracks)>=(int)(cfg('max_tracks')?:10000)) throw new RuntimeException('Библиотека заполнена. Освободи место и повтори синхронизацию.');
                $t['vk_provider']='browser';$t['vk_user']=$vkUser;$t['added']=$tracks[$t['id']]['added']??time();
                $t['size']=$t['size']??0;$t['duration']=$t['duration']??0;
                $tracks[$t['id']]=$t;$seen[$t['id']]=true;
            }
            $lib['tracks']=array_values($tracks);
            $lib['vk_sync']=array_merge($job,['state'=>$next===null?'done':'queued','offset'=>$next??$job['offset'],'received'=>count($seen),'seen'=>$seen,'total'=>(int)($page['count']??count($seen)),'vk_user'=>$vkUser,'attempts'=>0,'next_at'=>0,'lease_until'=>0,'updated'=>time(),'error'=>null]);
        });
    } catch(Throwable $e) {
        with_library($uid,function(array &$lib) use($job,$e) {
            $j=$lib['vk_sync']??null;
            if (!$j || $j['id']!==$job['id'] || ($j['lease']??null)!==$job['lease']) return;
            $j['attempts']++;$j['state']=preg_match('/требует подтверждения|Аккаунт VK изменился|подтвердить вход|Пройди проверку/u',$e->getMessage())?'needs_login':($j['attempts']>=8?'failed':'retry');
            $j['next_at']=time()+min(600,30*2**min($j['attempts'],4));$j['lease_until']=0;$j['updated']=time();$j['error']=$e->getMessage();$lib['vk_sync']=$j;
        });
    }
    return true;
}
