<?php
declare(strict_types=1);
require_once __DIR__ . "/vk-sync.php";

function vk_connector_configured(): bool
{
    return (bool) (cfg('vk_connector_url') && strlen((string) cfg('vk_connector_secret')) >= 32);
}

/** Signed backend-to-backend request. Telegram users never see this shared secret. */
function vk_connector_request(int $uid, string $action, array $params = [], bool $binary = false, bool $ranged = false, bool $passthrough = false)
{
    if (!vk_connector_configured()) throw new RuntimeException('Серверное окно VK не настроено');
    $base = rtrim((string) cfg('vk_connector_url'), '/');
    $url = parse_url($base);
    $host = strtolower($url['host'] ?? '');
    $private = in_array($host, ['127.0.0.1', '[::1]', 'localhost', 'vk-connector'], true)
        || preg_match('/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/', $host) && filter_var($host, FILTER_VALIDATE_IP);
    if (!is_array($url) || isset($url['user']) || isset($url['pass']) || isset($url['query']) || isset($url['fragment'])
        || (($url['scheme'] ?? '') !== 'https' && !(($url['scheme'] ?? '') === 'http' && $private))) {
        throw new RuntimeException('Для сервера VK нужен HTTPS или адрес в приватной сети');
    }
    $body = json_encode(['uid' => (string) $uid, 'action' => $action, 'params' => (object) $params], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $time = (string) (int) floor(microtime(true) * 1000);
    $nonce = bin2hex(random_bytes(16));
    $signature = hash_hmac('sha256', "$time\n$nonce\n$body", (string) cfg('vk_connector_secret'));
    $ch = curl_init($base . '/rpc');
    $response = ''; $oversized = false; $upstreamHeaders = []; $received = 0; $upstreamCode = 0; $forwarded = false;
    $requestHeaders = ['Content-Type: application/json', 'X-Flow-Time: ' . $time, 'X-Flow-Nonce: ' . $nonce, 'X-Flow-Signature: ' . $signature];
    if ($ranged && isset($_SERVER['HTTP_RANGE'])) $requestHeaders[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => in_array($action, ['file','stream'], true) ? 280 : 65,
        CURLOPT_HTTPHEADER => $requestHeaders,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$upstreamHeaders, &$upstreamCode, &$forwarded, $passthrough) {
            if (preg_match('#^HTTP/\S+ (\d+)#', $line, $status)) { $upstreamCode = (int) $status[1]; $upstreamHeaders = []; }
            if ($passthrough && trim($line) === '' && in_array($upstreamCode, [200,206,416], true)) {
                @ini_set('zlib.output_compression', '0');
                while (ob_get_level() > 0) { if (!@ob_end_clean()) break; }
                http_response_code($upstreamCode);
                foreach ($upstreamHeaders as $name => $value) header($name . ': ' . $value);
                header('Cache-Control: no-store'); header('X-Accel-Buffering: no'); header('X-Content-Type-Options: nosniff');
                $forwarded = true;
            }
            if (preg_match('/^(Content-Type|Content-Length|Content-Range|Accept-Ranges):\s*(.*)$/i', trim($line), $m)) $upstreamHeaders[strtolower($m[1])] = $m[2];
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$response, &$oversized, &$received, &$forwarded, $binary) {
            $received += strlen($chunk);
            if ($forwarded) {
                if ($received > 40 * 1024 * 1024 || connection_aborted()) return 0;
                if ($_SERVER['REQUEST_METHOD'] !== 'HEAD') { echo $chunk; flush(); }
                return strlen($chunk);
            }
            if (strlen($response) + strlen($chunk) > ($binary ? TG_FILE_LIMIT : 2 * 1024 * 1024)) { $oversized = true; return 0; }
            $response .= $chunk; return strlen($chunk);
        }]);
    $ok = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE); unset($ch);
    if ($forwarded) return null; // Never append JSON to an interrupted audio response.
    if ($oversized) throw new RuntimeException('Ответ сервера VK слишком большой');
    if ($ok === false) throw new RuntimeException('Не удалось дождаться ответа сервера FLOW. Он может запускаться после простоя. Повтори проверку подключения перед новым вводом номера.');
    if ($ranged && in_array($code, [200,206,416], true)) return ['body'=>$response,'status'=>$code,'headers'=>$upstreamHeaders];
    if (in_array($code, [502,503,504], true)) throw new RuntimeException('Сервер FLOW временно не отвечает. Подожди около минуты и проверь подключение; не отправляй номер или SMS повторно.');
    if ($code !== 200) {
        $data = json_decode($response, true);
        throw new RuntimeException((string) ($data['error'] ?? 'Серверное окно VK не ответило'));
    }
    if ($binary) return $response;
    $data = json_decode($response, true);
    if (!is_array($data)) throw new RuntimeException('Некорректный ответ сервера VK');
    return $data;
}

function vk_connector_stream(int $uid, array $track): void
{
    try {
        @set_time_limit(300);
        $native = ($_GET['stream'] ?? '') === '1';
        $params = ['identity' => $track['identity'], 'vk_user' => $track['vk_user'], 'track_id' => $track['id']];
        if ($native && isset($_GET['resource'])) {
            if (!preg_match('/^[a-f0-9]{40}$/D', (string) $_GET['resource'])) throw new RuntimeException('Некорректный адрес потока');
            $params['resource'] = $_GET['resource'];
        }
        vk_connector_request($uid, $native ? 'stream' : 'file', $params, true, true, true);
    } catch (RuntimeException $e) { json_out(422, ['error' => $e->getMessage()]); }
}

function vk_connector_api(int $uid, string $action): void
{
    if (in_array($action, ['vk-sync-start', 'vk-login', 'vk-app-login', 'vk-app-login-code', 'vk-phone-login', 'vk-login-phone', 'vk-logout', 'vk-add', 'vk-browser-open', 'vk-browser-input'], true) && $_SERVER['REQUEST_METHOD'] !== 'POST') { json_out(405, ['error' => 'POST only']); return; }
    try {
        if ($action === 'vk-sync-status') json_out(200, vk_sync_public(read_library($uid)['vk_sync'] ?? null));
        elseif ($action === 'vk-sync-start') json_out(200, vk_sync_start($uid, ($_GET['restart'] ?? '') === '1'));
        elseif ($action === 'vk-status') json_out(200, array_merge(vk_connector_request($uid, 'status'), ['syncAvailable'=>true]));
        elseif ($action === 'vk-app-login') json_out(200, vk_connector_request($uid, 'app-login'));
        elseif ($action === 'vk-app-login-status') json_out(200, vk_connector_request($uid, 'app-login-status'));
        elseif ($action === 'vk-login' || $action === 'vk-browser-open') json_out(200, vk_connector_request($uid, 'open'));
        elseif ($action === 'vk-browser-frame') {
            $bytes = vk_connector_request($uid, 'frame', [], true);
            header('Content-Type: image/jpeg'); header('Cache-Control: no-store'); header('X-Content-Type-Options: nosniff'); echo $bytes;
        } elseif ($action === 'vk-browser-input' || $action === 'vk-app-login-code' || $action === 'vk-phone-login' || $action === 'vk-login-phone' || $action === 'vk-add') {
            $body = file_get_contents('php://input', false, null, 0, 4097);
            if (strlen($body) > 4096) { json_out(413, ['error' => 'Слишком большой запрос']); return; }
            $input = json_decode($body, true);
            if (!is_array($input)) throw new RuntimeException('Некорректный запрос');
            if ($action === 'vk-phone-login') { json_out(200, vk_connector_request($uid, 'phone-login', ['restart' => ($input['restart'] ?? false) === true])); return; }
            if ($action === 'vk-login-phone') { json_out(200, vk_connector_request($uid, 'login-phone', ['phone' => $input['phone'] ?? null])); return; }
            if ($action === 'vk-app-login-code') { json_out(200, vk_connector_request($uid, 'app-login-code', ['code' => $input['code'] ?? null])); return; }
            if ($action === 'vk-browser-input') { json_out(200, vk_connector_request($uid, 'input', $input)); return; }
            $data = vk_connector_request($uid, 'track', $input);
            $track = $data['track'];
            $track['vk_provider'] = 'browser'; $track['vk_user'] = $data['profile']['id']; $track['added'] = time();
            with_library($uid, function (array &$lib) use ($track) {
                foreach ($lib['tracks'] as &$existing) if ($existing['id'] === $track['id']) { $existing = $track; return; }
                unset($existing);
                if (count($lib['tracks']) >= (int) (cfg('max_tracks') ?: 10000)) throw new RuntimeException('Библиотека заполнена. Удали ненужные треки.');
                array_unshift($lib['tracks'], $track);
            });
            unset($track['identity'], $track['vk_user'], $track['vk_provider'], $track['added']);
            json_out(200, ['track' => $track]);
        } elseif ($action === 'vk-list') json_out(200, vk_connector_request($uid, 'list', $_GET));
        elseif ($action === 'vk-playlists') json_out(200, vk_connector_request($uid, 'playlists', $_GET));
        elseif ($action === 'vk-logout') {
            vk_sync_cancel($uid);
            vk_connector_request($uid, 'logout');
            with_library($uid, function (array &$lib) {
                unset($lib['vk'], $lib['vk_pending'], $lib['vk_exchange']);
                $lib['tracks'] = array_values(array_filter($lib['tracks'], fn ($t) => ($t['source'] ?? '') !== 'vk'));
            });
            json_out(200, ['ok' => true]);
        } else json_out(404, ['error' => 'Unknown action']);
    } catch (RuntimeException $e) { json_out(422, ['error' => $e->getMessage()]); }
}
