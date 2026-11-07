<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';

// One-time setup: open https://ТВОЙ-САЙТ/flow/api/setup.php in a browser.
// Points the bot's webhook here and adds the FLOW button next to the chat input.
// Safe to open again — it only re-applies the same settings.

header('Content-Type: text/html; charset=utf-8');
$rows = [];
$ok = true;
$check = function (string $label, bool $pass, string $detail = '') use (&$rows, &$ok) {
    $rows[] = [$label, $pass, $detail];
    if (!$pass) $ok = false;
};

try {
    $check('PHP 8+', PHP_VERSION_ID >= 80000, PHP_VERSION);
    $check('curl', function_exists('curl_init'));
    $base = base_url();
    $check('HTTPS', str_starts_with($base, 'https://'), $base . ' — Telegram открывает мини-аппы только по https');
    if (!is_dir(FLOW_DATA)) @mkdir(FLOW_DATA, 0750, true);
    $check('Папка data доступна для записи', is_writable(FLOW_DATA));

    $me = tg('getMe');
    $check('Токен бота', !empty($me['ok']), !empty($me['ok']) ? '@' . $me['result']['username'] : ($me['description'] ?? 'Telegram отклонил токен'));

    if ($ok) {
        $hook = tg('setWebhook', [
            'url' => $base . '/api/bot.php',
            'secret_token' => webhook_secret(),
            'allowed_updates' => ['message', 'callback_query'],
            'drop_pending_updates' => true,
            'max_connections' => 20,
        ]);
        $check('Webhook', !empty($hook['ok']), $base . '/api/bot.php');

        $menu = tg('setChatMenuButton', ['menu_button' => [
            'type' => 'web_app', 'text' => 'FLOW', 'web_app' => ['url' => $base . '/'],
        ]]);
        $check('Кнопка FLOW у поля ввода', !empty($menu['ok']));

        tg('setMyCommands', ['commands' => [
            ['command' => 'mix', 'description' => 'Открыть микшер'],
            ['command' => 'list', 'description' => 'Моя библиотека'],
            ['command' => 'clear', 'description' => 'Очистить библиотеку'],
            ['command' => 'id', 'description' => 'Мой Telegram ID'],
        ]]);
        tg('setMyDescription', ['description' => 'FLOW — карманный диджей. Присылай треки, а я сведу их в сет: автомикс по темпу, мэшапы и светомузыка.']);
        tg('setMyShortDescription', ['short_description' => 'Автомикс, мэшапы и светомузыка из твоих треков 🎧']);

        $info = tg('getWebhookInfo');
        $last = $info['result']['last_error_message'] ?? '';
        $check('Telegram видит сервер', $last === '', $last ?: 'ок');
    }
} catch (Throwable $e) {
    $check('Настройка', false, $e->getMessage());
}
?>
<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLOW · установка</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#101219;color:#f2f2f7;max-width:640px;margin:40px auto;padding:0 18px}
li{list-style:none;padding:10px 0;border-bottom:1px solid #2a2d38}small{color:#9aa0b4;display:block}b.y{color:#c4f66c}b.n{color:#ff6b7a}h1{letter-spacing:-1px}</style>
<h1><?= $ok ? '✅ FLOW готов' : '⚠️ Нужно поправить' ?></h1>
<ul><?php foreach ($rows as [$label, $pass, $detail]): ?>
<li><b class="<?= $pass ? 'y' : 'n' ?>"><?= $pass ? '✓' : '✗' ?></b> <?= esc($label) ?><small><?= esc($detail) ?></small></li>
<?php endforeach ?></ul>
<?php if ($ok && !empty($me['result']['username'])): ?>
<p>Открой <a style="color:#c4f66c" href="https://t.me/<?= esc($me['result']['username']) ?>">@<?= esc($me['result']['username']) ?></a>, нажми «Start» и пришли пару треков.</p>
<?php endif ?>
