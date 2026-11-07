<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';
require __DIR__ . '/vk.php';
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
$message = 'VK подключён. Вернись в FLOW в Telegram и нажми «Обновить подключение».';
$ok = false;
try {
    if (!vk_configured()) throw new RuntimeException('Подключение VK не настроено.');
    if (!preg_match('/^(\d+)\.([a-f0-9]{64})$/', (string) ($_GET['state'] ?? ''), $match)) throw new RuntimeException('Ссылка входа недействительна. Начни подключение из FLOW.');
    $uid = (int) $match[1];
    if (!user_allowed($uid)) throw new RuntimeException('Это личный бот.');
    // Consume state under lock before exchanging the code (single use, ten minutes).
    with_library($uid, function (array &$lib) use ($match) {
        $pending = $lib['vk_pending'] ?? [];
        if (($pending['expires'] ?? 0) < time() || !hash_equals($pending['hash'] ?? '', hash('sha256', $match[2]))) throw new RuntimeException('Ссылка входа истекла. Подключи VK из FLOW заново.');
        unset($lib['vk_pending']);
        $lib['vk_exchange'] = hash('sha256', $match[2]);
    });
    if (isset($_GET['error'])) throw new RuntimeException('Вход отменён. Можно вернуться в FLOW и попробовать снова.');
    $code = (string) ($_GET['code'] ?? '');
    if ($code === '' || strlen($code) > 2048) throw new RuntimeException('VK не подтвердил вход.');
    $auth = vk_request('https://oauth.vk.com/access_token', ['client_id' => cfg('vk_client_id'), 'client_secret' => cfg('vk_client_secret'),
        'redirect_uri' => cfg('vk_redirect_uri'), 'code' => $code]);
    if (empty($auth['access_token']) || empty($auth['user_id'])) throw new RuntimeException('VK не выдал разрешение. Проверь настройки приложения VK.');
    $client = new VkMusic((string) $auth['access_token']);
    // Do not claim success for a VK ID token that cannot access music.
    $client->call('audio.get', ['count' => 1]);
    $profile = $client->call('users.get')[0] ?? [];
    $session = ['id' => (int) $auth['user_id'], 'name' => trim(($profile['first_name'] ?? '') . ' ' . ($profile['last_name'] ?? '')) ?: 'VK',
        'token' => vk_seal((string) $auth['access_token']), 'expires' => empty($auth['expires_in']) ? 0 : time() + (int) $auth['expires_in']];
    with_library($uid, function (array &$lib) use ($session, $match) {
        // Logging out while the exchange was in flight must not reconnect an account.
        if (!hash_equals($lib['vk_exchange'] ?? '', hash('sha256', $match[2]))) throw new RuntimeException('Начат новый вход. Заверши последнее подключение.');
        $lib['tracks'] = array_values(array_filter($lib['tracks'], fn ($t) => ($t['source'] ?? '') !== 'vk' || ($t['vk_user'] ?? null) === $session['id']));
        unset($lib['vk_exchange']);
        $lib['vk'] = $session;
    });
    $ok = true;
} catch (Throwable $e) {
    http_response_code(400);
    $message = $e instanceof RuntimeException ? $e->getMessage() : 'Не удалось подключить VK. Попробуй ещё раз из FLOW.';
}
?>
<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLOW · VK</title>
<style>body{font:17px/1.6 system-ui;background:#0e1016;color:#f4f4f8;max-width:480px;margin:15vh auto;padding:24px}h1{color:#c6f76d}</style>
<h1><?= $ok ? 'VK подключён' : 'Не удалось подключить VK' ?></h1><p><?= esc($message) ?></p></html>
