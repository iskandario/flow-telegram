<?php
declare(strict_types=1);
function media_cookie_user(): ?array {
    $value = (string) ($_COOKIE['flow_media'] ?? '');
    if (!preg_match('/^(\d{1,20})\.(\d{10})\.([a-f0-9]{64})$/', $value, $m) || (int) $m[2] < time()) return null;
    if (!hash_equals(hash_hmac('sha256', 'flow-media|' . $m[1] . '.' . $m[2], token()), $m[3])) return null;
    return ['id'=>(int)$m[1]];
}
function media_cookie_issue(int $uid): void {
    $value = $uid . '.' . (time() + 3600);
    $value .= '.' . hash_hmac('sha256', 'flow-media|' . $value, token());
    setcookie('flow_media', $value, ['expires'=>time()+3600,'path'=>dirname($_SERVER['SCRIPT_NAME']) . '/app.php','secure'=>(!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https','httponly'=>true,'samesite'=>'Strict']);
}
