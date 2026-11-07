<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';

// Mini app API. Every call carries Telegram initData, which proves who the
// user is; nobody can read or play someone else's library.

try {
    $user = verify_init_data((string) ($_SERVER['HTTP_X_TELEGRAM_INIT_DATA'] ?? ''));
} catch (Throwable $e) {
    json_out(500, ['error' => $e->getMessage()]);
    exit;
}
if (!$user) {
    json_out(401, ['error' => 'Открой FLOW через кнопку в боте']);
    exit;
}
$uid = (int) $user['id'];
if (!user_allowed($uid)) {
    json_out(403, ['error' => 'Это личный бот']);
    exit;
}

$action = (string) ($_GET['a'] ?? '');
try {
    switch ($action) {
        case 'list':
            $tracks = array_map(fn ($t) => [
                'id' => $t['id'],
                'title' => $t['title'],
                'artist' => $t['artist'],
                'duration' => $t['duration'],
                'size' => $t['size'],
            ], read_library($uid)['tracks']);
            json_out(200, ['tracks' => $tracks, 'user' => ['id' => $uid, 'name' => $user['first_name'] ?? '']]);
            break;

        case 'file':
            stream_track($uid, (string) ($_GET['id'] ?? ''));
            break;

        case 'delete':
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                json_out(405, ['error' => 'POST only']);
                break;
            }
            $id = (string) ($_GET['id'] ?? '');
            $left = with_library($uid, function (array &$lib) use ($id) {
                $lib['tracks'] = array_values(array_filter($lib['tracks'], fn ($t) => $t['id'] !== $id));
                return count($lib['tracks']);
            });
            json_out(200, ['ok' => true, 'count' => $left]);
            break;

        default:
            json_out(404, ['error' => 'Unknown action']);
    }
} catch (Throwable $e) {
    error_log('FLOW app: ' . $e->getMessage());
    if (!headers_sent()) json_out(502, ['error' => 'Сервер не смог ответить, попробуй ещё раз']);
}

/** Proxy the audio from Telegram's file storage without buffering it in PHP. */
function stream_track(int $uid, string $id): void
{
    $track = null;
    foreach (read_library($uid)['tracks'] as $t) if ($t['id'] === $id) { $track = $t; break; }
    if (!$track) {
        json_out(404, ['error' => 'Трека нет в библиотеке']);
        return;
    }
    $file = tg('getFile', ['file_id' => $track['file_id']]);
    $path = $file['result']['file_path'] ?? '';
    if (!$path) {
        json_out(410, ['error' => 'Telegram не отдал файл. Пришли трек боту ещё раз.']);
        return;
    }
    @set_time_limit(300);
    while (ob_get_level()) ob_end_clean();
    $url = cfg('api_base') . '/file/bot' . token() . '/' . $path;
    $ch = curl_init($url);
    $headersSent = false;
    curl_setopt_array($ch, [
        CURLOPT_TIMEOUT => 280,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$headersSent, $track, $file) {
            if (!$headersSent) {
                $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
                if ($code !== 200) return -1;
                header('Content-Type: ' . ($track['mime'] ?: 'audio/mpeg'));
                if (!empty($file['result']['file_size'])) header('Content-Length: ' . (int) $file['result']['file_size']);
                header('Cache-Control: private, max-age=604800, immutable');
                header('X-Content-Type-Options: nosniff');
                $headersSent = true;
            }
            echo $chunk;
            flush();
            return strlen($chunk);
        },
    ]);
    $ok = curl_exec($ch);
    curl_close($ch);
    if (!$ok && !$headersSent) json_out(502, ['error' => 'Не удалось скачать трек из Telegram']);
}
