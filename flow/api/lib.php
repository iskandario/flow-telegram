<?php
declare(strict_types=1);

// Shared helpers for the FLOW bot (webhook) and mini app API.

const FLOW_DATA = __DIR__ . '/../data';
const TG_FILE_LIMIT = 20 * 1024 * 1024; // Bot API getFile can't fetch bigger files.

function cfg(string $key)
{
    static $config = null;
    if ($config === null) {
        $local = __DIR__ . '/config.local.php';
        $config = require (is_file($local) ? $local : __DIR__ . '/config.php');
    }
    return $config[$key] ?? null;
}

function token(): string
{
    $token = (string) cfg('bot_token');
    if (!preg_match('/^\d+:[A-Za-z0-9_-]{30,}$/', $token)) {
        throw new RuntimeException('В api/config.php не вставлен токен бота');
    }
    return $token;
}

/** Secret Telegram sends with every webhook call, derived from the token. */
function webhook_secret(): string
{
    return substr(hash('sha256', 'flow-webhook|' . token()), 0, 48);
}

function base_url(): string
{
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $dir = rtrim(str_replace('\\', '/', dirname(dirname($_SERVER['SCRIPT_NAME'] ?? '/api/x.php'))), '/');
    return ($https ? 'https' : 'http') . '://' . $host . $dir;
}

function http_post_json(string $url, array $params, int $timeout = 25): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($params, JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    $body = curl_exec($ch);
    $error = curl_error($ch);
    curl_close($ch);
    if ($body === false) throw new RuntimeException('Telegram недоступен: ' . $error);
    $data = json_decode((string) $body, true);
    return is_array($data) ? $data : ['ok' => false, 'description' => 'Bad response'];
}

function tg(string $method, array $params = []): array
{
    $response = http_post_json(cfg('api_base') . '/bot' . token() . '/' . $method, $params);
    if (empty($response['ok'])) {
        error_log('FLOW tg ' . $method . ': ' . ($response['description'] ?? 'error'));
    }
    return $response;
}

// ---------- Storage (one JSON file per user, flock-protected) ----------

function user_file(int $userId): string
{
    if (!is_dir(FLOW_DATA)) mkdir(FLOW_DATA, 0750, true);
    return FLOW_DATA . '/u' . $userId . '.json';
}

/** Read-modify-write a user's library under an exclusive lock. */
function with_library(int $userId, callable $fn)
{
    $fh = fopen(user_file($userId), 'c+');
    if (!$fh) throw new RuntimeException('Хранилище недоступно');
    try {
        flock($fh, LOCK_EX);
        $raw = stream_get_contents($fh);
        $lib = json_decode($raw ?: '', true);
        if (!is_array($lib) || !isset($lib['tracks'])) $lib = ['tracks' => []];
        $result = $fn($lib);
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, json_encode($lib, JSON_UNESCAPED_UNICODE));
        fflush($fh);
        return $result;
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

function read_library(int $userId): array
{
    $file = user_file($userId);
    if (!is_file($file)) return ['tracks' => []];
    $lib = json_decode((string) file_get_contents($file), true);
    return is_array($lib) && isset($lib['tracks']) ? $lib : ['tracks' => []];
}

function user_allowed(int $userId): bool
{
    $allowed = cfg('allowed_users') ?: [];
    return !$allowed || in_array($userId, array_map('intval', $allowed), true);
}

// ---------- Mini app auth ----------

/**
 * Validate Telegram WebApp initData (HMAC per core.telegram.org/bots/webapps).
 * Returns the Telegram user or null.
 */
function verify_init_data(string $initData, int $maxAge = 86400): ?array
{
    if ($initData === '') return null;
    parse_str($initData, $fields);
    $hash = $fields['hash'] ?? '';
    if (!is_string($hash) || $hash === '') return null;
    unset($fields['hash']);
    ksort($fields);
    $lines = [];
    foreach ($fields as $k => $v) $lines[] = $k . '=' . $v;
    $secret = hash_hmac('sha256', token(), 'WebAppData', true);
    $calc = hash_hmac('sha256', implode("\n", $lines), $secret);
    if (!hash_equals($calc, $hash)) return null;
    if ((int) ($fields['auth_date'] ?? 0) < time() - $maxAge) return null;
    $user = json_decode((string) ($fields['user'] ?? ''), true);
    return is_array($user) && isset($user['id']) ? $user : null;
}

function json_out(int $status, array $data): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
}

/** Pretty "Artist — Title" from a stored track. */
function track_label(array $t): string
{
    $artist = trim((string) ($t['artist'] ?? ''));
    $title = trim((string) ($t['title'] ?? ''));
    return $artist !== '' ? "$artist — $title" : $title;
}

function esc(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
}
