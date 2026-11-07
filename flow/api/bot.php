<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';

// Telegram webhook. Always answers 200 quickly so Telegram never retries a
// handled update; every message gets a reply.

if (($_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '') !== webhook_secret()) {
    http_response_code(403);
    exit;
}
$update = json_decode((string) file_get_contents('php://input'), true);
http_response_code(200);
header('Content-Type: application/json');
echo '{}';
if (!is_array($update)) exit;
if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();

try {
    if (isset($update['callback_query'])) on_callback($update['callback_query']);
    elseif (isset($update['message'])) on_message($update['message']);
} catch (Throwable $e) {
    error_log('FLOW bot: ' . $e->getMessage());
    $chat = $update['message']['chat']['id'] ?? $update['callback_query']['message']['chat']['id'] ?? null;
    if ($chat) tg('sendMessage', ['chat_id' => $chat, 'text' => '⚠️ Что-то пошло не так, попробуй ещё раз.']);
}

function app_button(string $label = '🎧 Открыть FLOW'): array
{
    return ['inline_keyboard' => [[['text' => $label, 'web_app' => ['url' => base_url() . '/']]]]];
}

function reply(int $chat, string $html, ?array $markup = null): void
{
    $params = ['chat_id' => $chat, 'text' => $html, 'parse_mode' => 'HTML', 'link_preview_options' => ['is_disabled' => true]];
    if ($markup) $params['reply_markup'] = $markup;
    tg('sendMessage', $params);
}

/** Pull audio metadata out of an audio/document message. */
function audio_from(array $m): ?array
{
    $a = $m['audio'] ?? null;
    if (!$a && isset($m['document'])) {
        $d = $m['document'];
        $mime = (string) ($d['mime_type'] ?? '');
        $name = (string) ($d['file_name'] ?? '');
        if (str_starts_with($mime, 'audio/') || preg_match('/\.(mp3|m4a|aac|wav|flac|ogg|opus|aiff?)$/i', $name)) $a = $d;
    }
    if (!$a) return null;
    $file = preg_replace('/\.[^.]+$/', '', (string) ($a['file_name'] ?? 'Трек'));
    $artist = trim((string) ($a['performer'] ?? ''));
    $title = trim((string) ($a['title'] ?? ''));
    if ($title === '') {
        $title = $file;
        if ($artist === '' && preg_match('/^(.+?)\s+[-–—]\s+(.+)$/u', $file, $mm)) {
            [$artist, $title] = [trim($mm[1]), trim($mm[2])];
        }
    }
    return [
        'id' => (string) $a['file_unique_id'],
        'file_id' => (string) $a['file_id'],
        'title' => mb_substr($title, 0, 200),
        'artist' => mb_substr($artist, 0, 200),
        'duration' => (int) ($a['duration'] ?? 0),
        'size' => (int) ($a['file_size'] ?? 0),
        'mime' => (string) ($a['mime_type'] ?? 'audio/mpeg'),
        'added' => time(),
    ];
}

function on_message(array $m): void
{
    $chat = (int) $m['chat']['id'];
    $uid = (int) ($m['from']['id'] ?? 0);
    if (($m['chat']['type'] ?? '') !== 'private') return;
    $text = trim((string) ($m['text'] ?? ''));

    if (!user_allowed($uid)) {
        reply($chat, "Это личный бот FLOW 🔒\nТвой ID: <code>$uid</code>");
        return;
    }

    if ($track = audio_from($m)) {
        if ($track['size'] > TG_FILE_LIMIT) {
            reply($chat, '😕 Файл больше 20 МБ — Telegram не отдаёт такие ботам. Пришли mp3 поменьше (320 kbps ≈ 8 МБ на 3 минуты).');
            return;
        }
        $max = (int) (cfg('max_tracks') ?: 500);
        [$added, $count] = with_library($uid, function (array &$lib) use ($track, $max) {
            foreach ($lib['tracks'] as $t) if ($t['id'] === $track['id']) return [false, count($lib['tracks'])];
            array_unshift($lib['tracks'], $track);
            $lib['tracks'] = array_slice($lib['tracks'], 0, $max);
            return [true, count($lib['tracks'])];
        });
        $label = esc(track_label($track));
        reply($chat, $added
            ? "✅ <b>$label</b>\nВ библиотеке: $count " . plural($count, 'трек', 'трека', 'треков')
            : "Уже есть в библиотеке: <b>$label</b>", app_button('🎧 Микс'));
        return;
    }

    if (isset($m['voice']) || isset($m['video_note']) || isset($m['video'])) {
        reply($chat, 'Голосовые и видео я не микширую 🙂 Пришли трек как музыку или файлом (mp3, m4a, wav, flac).');
        return;
    }

    $cmd = strtolower(preg_replace('/@\w+$/', '', strtok($text, ' ') ?: ''));
    switch ($cmd) {
        case '/start':
            $name = esc((string) ($m['from']['first_name'] ?? 'бро'));
            reply($chat,
                "Йо, $name! Я <b>FLOW</b> — карманный диджей 🎧\n\n" .
                "1. Кидай мне треки (музыкой или файлом, до 20 МБ).\n" .
                "2. Жми «Открыть FLOW» — соберу из них сет: подберу порядок по темпу, сведу на фразах, а в режиме «Мэшап» положу вокал одного трека на бит следующего.\n" .
                "3. Есть Home Assistant? Подключи лампы в настройках — будут мигать в бит.\n\n" .
                "/list — библиотека · /clear — очистить · /id — твой ID",
                app_button());
            return;
        case '/app':
        case '/mix':
            reply($chat, 'Погнали 👇', app_button());
            return;
        case '/id':
            reply($chat, "Твой Telegram ID: <code>$uid</code>");
            return;
        case '/list':
            $tracks = read_library($uid)['tracks'];
            if (!$tracks) {
                reply($chat, 'Библиотека пустая. Пришли мне пару треков 🎶');
                return;
            }
            $lines = [];
            foreach (array_slice($tracks, 0, 30) as $i => $t) $lines[] = ($i + 1) . '. ' . esc(track_label($t));
            $more = count($tracks) > 30 ? "\n…и ещё " . (count($tracks) - 30) : '';
            reply($chat, "<b>Твоя библиотека</b> (" . count($tracks) . ")\n" . implode("\n", $lines) . $more, app_button());
            return;
        case '/clear':
            reply($chat, 'Точно удалить всю библиотеку? Сами файлы в чате останутся.', ['inline_keyboard' => [[
                ['text' => '🗑 Да, очистить', 'callback_data' => 'clear:yes'],
                ['text' => 'Отмена', 'callback_data' => 'clear:no'],
            ]]]);
            return;
        case '/help':
        default:
            $count = count(read_library($uid)['tracks']);
            reply($chat, $count
                ? "Я на связи 🤙 В библиотеке $count " . plural($count, 'трек', 'трека', 'треков') . ". Кидай ещё музыку или открывай микс."
                : "Я на связи 🤙 Пришли мне треки — и запускай микс.",
                app_button());
    }
}

function on_callback(array $q): void
{
    $uid = (int) $q['from']['id'];
    $chat = (int) ($q['message']['chat']['id'] ?? $uid);
    $msg = (int) ($q['message']['message_id'] ?? 0);
    if (($q['data'] ?? '') === 'clear:yes' && user_allowed($uid)) {
        with_library($uid, function (array &$lib) { $lib['tracks'] = []; });
        tg('answerCallbackQuery', ['callback_query_id' => $q['id'], 'text' => 'Очищено']);
        if ($msg) tg('editMessageText', ['chat_id' => $chat, 'message_id' => $msg, 'text' => '🗑 Библиотека очищена.']);
        return;
    }
    tg('answerCallbackQuery', ['callback_query_id' => $q['id']]);
    if ($msg) tg('editMessageText', ['chat_id' => $chat, 'message_id' => $msg, 'text' => 'Ок, ничего не трогаю 👌']);
}

function plural(int $n, string $one, string $few, string $many): string
{
    $n = abs($n) % 100;
    $n1 = $n % 10;
    if ($n > 10 && $n < 20) return $many;
    if ($n1 > 1 && $n1 < 5) return $few;
    if ($n1 === 1) return $one;
    return $many;
}
