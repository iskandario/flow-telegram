<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';
header('Cache-Control: no-store');
$secret = (string) cfg('vk_connector_secret');
$body = file_get_contents('php://input', false, null, 0, 524289);
$time = (string) ($_SERVER['HTTP_X_FLOW_TIME'] ?? '');
$nonce = (string) ($_SERVER['HTTP_X_FLOW_NONCE'] ?? '');
$sig = (string) ($_SERVER['HTTP_X_FLOW_SIGNATURE'] ?? '');
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' || strlen($secret) < 32 || strlen($body) > 524288
    || !preg_match('/^\d{13}$/', $time) || abs(microtime(true) * 1000 - (float) $time) > 60000
    || !preg_match('/^[a-f0-9]{32}$/', $nonce) || !preg_match('/^[a-f0-9]{64}$/', $sig)
    || !hash_equals(hash_hmac('sha256', "flow-state-v1\n$time\n$nonce\n$body", $secret), $sig)) { json_out(401, ['error' => 'Unauthorized']); exit; }
$data = json_decode($body, true);
$uid = (string) ($data['uid'] ?? ''); $op = $data['op'] ?? '';
if (!preg_match('/^\d{1,20}$/', $uid) || !in_array($op, ['read','write','delete'], true) || !user_allowed((int) $uid)) { json_out(400, ['error'=>'Invalid request']); exit; }
$dir = FLOW_DATA . '/vk-state';
if (!is_dir($dir) && !mkdir($dir, 0700, true)) { json_out(503, ['error'=>'Storage unavailable']); exit; }
$lock = fopen("$dir/$uid.lock", 'c');
if (!$lock || !flock($lock, LOCK_EX)) { json_out(503, ['error'=>'Storage unavailable']); exit; }
try {
    $replays = json_decode(@file_get_contents("$dir/$uid.nonces") ?: '[]', true) ?: [];
    $replays = array_filter($replays, fn($t) => $t > time() - 120);
    if (isset($replays[$nonce])) { json_out(409, ['error'=>'Replay']); exit; }
    $replays[$nonce] = time(); file_put_contents("$dir/$uid.nonces", json_encode($replays), LOCK_EX);
    $file = "$dir/$uid.bin";
    if ($op === 'read') { json_out(200, ['data'=>is_file($file)?base64_encode(file_get_contents($file)):null]); }
    elseif ($op === 'delete') { if (is_file($file)) unlink($file); json_out(200, ['ok'=>true]); }
    else {
        $bytes = base64_decode((string) ($data['data'] ?? ''), true);
        if ($bytes === false || strlen($bytes) < 29 || strlen($bytes) > 350000) { json_out(400, ['error'=>'Invalid ciphertext']); exit; }
        if (file_put_contents($file . '.tmp', $bytes, LOCK_EX) === false || !rename($file . '.tmp', $file)) throw new RuntimeException('Storage write failed');
        chmod($file, 0600); json_out(200, ['ok'=>true]);
    }
} catch (Throwable $e) { json_out(503, ['error'=>'Storage unavailable']); }
finally { flock($lock, LOCK_UN); fclose($lock); }
