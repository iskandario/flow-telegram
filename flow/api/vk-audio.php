<?php
declare(strict_types=1);

/** Only VK media CDN HTTPS URLs are accepted; never arbitrary user URLs. */
function vk_media_url(string $url): string
{
    $p = parse_url($url);
    $host = strtolower($p['host'] ?? '');
    if (($p['scheme'] ?? '') !== 'https' || isset($p['user']) || isset($p['pass']) || (isset($p['port']) && $p['port'] !== 443)
        || !preg_match('/(^|\.)(userapi\.com|vkuseraudio\.(net|com|ru)|vk-cdn\.net|vkcdn\.ru|vk\.com|vk\.ru|mycdn\.me|okcdn\.ru)$/D', $host)) {
        throw new RuntimeException('VK вернул неподдерживаемый адрес аудио');
    }
    return $host;
}

function vk_media_fetch(string $url, int $limit, int $redirects = 0): string
{
    $host = vk_media_url($url);
    $addresses = gethostbynamel($host) ?: [];
    if (!$addresses) throw new RuntimeException('Аудиосервер VK недоступен');
    foreach ($addresses as $ip) {
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) throw new RuntimeException('Недопустимый адрес аудиосервера');
    }
    $ch = curl_init($url);
    $body = ''; $location = ''; $tooBig = false;
    curl_setopt_array($ch, [CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 60, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_FOLLOWLOCATION => false, CURLOPT_RESOLVE => ["$host:443:" . $addresses[0]],
        CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$location) {
            if (stripos($line, 'Location:') === 0) $location = trim(substr($line, 9));
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$body, &$tooBig, $limit) {
            if (strlen($body) + strlen($chunk) > $limit) { $tooBig = true; return 0; }
            $body .= $chunk; return strlen($chunk);
        }]);
    $ok = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    unset($ch);
    if ($tooBig) throw new RuntimeException('Трек слишком большой для телефона (лимит 20 МБ)');
    if ($status >= 300 && $status < 400 && $location && $redirects < 3) return vk_media_fetch(vk_relative_url($url, $location), $limit, $redirects + 1);
    if (!$ok || $status !== 200) throw new RuntimeException('VK не отдал аудио. Повтори загрузку трека.');
    return $body;
}

function vk_relative_url(string $base, string $relative): string
{
    if (preg_match('#^https?://#i', $relative)) return $relative;
    if (str_starts_with($relative, '//')) return 'https:' . $relative;
    $p = parse_url($base);
    $path = str_starts_with($relative, '/') ? $relative : dirname($p['path'] ?? '/') . '/' . $relative;
    return 'https://' . $p['host'] . '/' . ltrim($path, '/');
}

/** Resolve media playlists before ffmpeg: the converter never has network access. */
function vk_hls_bytes(string $url, string $manifest, int $depth = 0, ?callable $fetch = null): string
{
    $fetch ??= 'vk_media_fetch';
    if ($depth > 3) throw new RuntimeException('Некорректный HLS-плейлист VK');
    $lines = preg_split('/\r?\n/', trim($manifest));
    $variant = false; $bytes = ''; $segments = 0; $sequence = 0; $key = null; $iv = null;
    if (!str_contains($manifest, '#EXT-X-ENDLIST') && !str_contains($manifest, '#EXT-X-STREAM-INF')) throw new RuntimeException('Прямые эфиры не поддерживаются');
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '') continue;
        if (str_starts_with($line, '#EXT-X-STREAM-INF:')) { $variant = true; continue; }
        if (str_starts_with($line, '#EXT-X-MEDIA-SEQUENCE:')) $sequence = (int) substr($line, 22);
        if (str_starts_with($line, '#EXT-X-BYTERANGE') || str_starts_with($line, '#EXT-X-MAP')) throw new RuntimeException('Этот формат HLS пока не поддерживается');
        if (str_starts_with($line, '#EXT-X-KEY:')) {
            if (preg_match('/METHOD=NONE(?:,|$)/', $line)) { $key = $iv = null; continue; }
            if (!preg_match('/METHOD=AES-128(?:,|$)/', $line) || !preg_match('/URI="([^"]+)"/', $line, $m)) throw new RuntimeException('Защищённый поток VK не поддерживается');
            $key = $fetch(vk_relative_url($url, $m[1]), 16);
            if (strlen($key) !== 16) throw new RuntimeException('Некорректный ключ HLS');
            $iv = preg_match('/IV=0x([a-fA-F0-9]{32})(?:,|$)/', $line, $m) ? hex2bin($m[1]) : null;
        }
        if ($line[0] === '#') continue;
        $partUrl = vk_relative_url($url, $line);
        if ($variant) return vk_hls_bytes($partUrl, $fetch($partUrl, 1024 * 1024), $depth + 1, $fetch);
        if (++$segments > 600) throw new RuntimeException('Слишком длинный HLS-трек');
        $remaining = 40 * 1024 * 1024 - strlen($bytes);
        if ($remaining <= 0) throw new RuntimeException('Трек слишком большой');
        $part = $fetch($partUrl, min(8 * 1024 * 1024, $remaining));
        if ($key !== null) {
            $part = openssl_decrypt($part, 'aes-128-cbc', $key, OPENSSL_RAW_DATA, $iv ?? (str_repeat("\0", 8) . pack('N2', 0, $sequence)));
            if ($part === false) throw new RuntimeException('Не удалось прочитать HLS-аудио');
        }
        $bytes .= $part;
        $sequence++;
    }
    if (!$segments) throw new RuntimeException('Пустой HLS-плейлист');
    return $bytes;
}

function vk_convert_hls(string $url, string $manifest, ?callable $fetch = null): string
{
    $ffmpeg = (string) cfg('ffmpeg_path');
    if (!$ffmpeg || !is_executable($ffmpeg) || !function_exists('proc_open')) throw new RuntimeException('Для этого трека нужен ffmpeg на сервере FLOW. Обратись к владельцу приложения.');
    $input = tempnam(sys_get_temp_dir(), 'flow-vk-');
    if ($input === false) throw new RuntimeException('Временное хранилище недоступно');
    $output = $input . '.mp3';
    $process = null;
    try {
        file_put_contents($input, vk_hls_bytes($url, $manifest, 0, $fetch));
        $process = proc_open([$ffmpeg, '-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', $input,
            '-vn', '-t', '720', '-c:a', 'libmp3lame', '-b:a', '192k', '-fs', (string) TG_FILE_LIMIT, '-f', 'mp3', $output],
            [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
        if (!is_resource($process)) throw new RuntimeException('Не удалось запустить обработку аудио');
        $deadline = microtime(true) + 90;
        do {
            $state = proc_get_status($process);
            if (!$state['running']) break;
            if (microtime(true) > $deadline) { proc_terminate($process, 9); throw new RuntimeException('Обработка аудио заняла слишком много времени'); }
            usleep(100000);
        } while (true);
        if ($state['exitcode'] !== 0 || !is_file($output) || filesize($output) < 512) throw new RuntimeException('Не удалось обработать аудиопоток VK');
        return (string) file_get_contents($output);
    } finally {
        if (is_resource($process)) { proc_terminate($process); proc_close($process); }
        @unlink($input); @unlink($output);
    }
}

function vk_stream(int $uid, array $track): void
{
    try {
        $session = read_library($uid)['vk'] ?? null;
        if (!$session || ($track['vk_user'] ?? null) !== $session['id']) throw new RuntimeException('Подключи тот аккаунт VK, из которого добавлен трек');
        $raw = vk_client($uid)->get($track['identity']);
        if (empty($raw['url']) || !empty($raw['content_restricted'])) throw new RuntimeException('VK не разрешает воспроизвести этот трек');
        @set_time_limit(300);
        $url = (string) $raw['url'];
        $isHls = preg_match('/\.m3u8(?:[?#]|$)/i', $url);
        $bytes = vk_media_fetch($url, $isHls ? 1024 * 1024 : TG_FILE_LIMIT);
        if ($isHls || str_starts_with(ltrim($bytes), '#EXTM3U')) $bytes = vk_convert_hls($url, $bytes);
        if (strlen($bytes) < 512) throw new RuntimeException('VK вернул пустое аудио');
        header('Content-Type: audio/mpeg');
        header('Content-Length: ' . strlen($bytes));
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        echo $bytes;
    } catch (RuntimeException $e) { json_out(422, ['error' => $e->getMessage()]); }
}
