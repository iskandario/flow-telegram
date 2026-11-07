<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__.'/lib.php';require __DIR__.'/vk-connector.php';require_once __DIR__.'/vk-sync.php';
if (!vk_connector_configured()) exit;
$lock=fopen(FLOW_DATA.'/vk-sync-worker.lock','c');
if (!$lock || !flock($lock,LOCK_EX|LOCK_NB)) exit;
$end=microtime(true)+45;
do {
    $worked=false;
    foreach(glob(FLOW_DATA.'/u*.json') as $file) {
        if (!preg_match('/^u(\d+)\.json$/',basename($file),$m))continue;
        $worked=vk_sync_step((int)$m[1],'vk_connector_request')||$worked;
        if (microtime(true)>=$end)break;
    }
    if ($worked && microtime(true)<$end)usleep(350000);
} while($worked && microtime(true)<$end);
flock($lock,LOCK_UN);fclose($lock);
