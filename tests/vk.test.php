<?php
declare(strict_types=1);
const TG_FILE_LIMIT = 20 * 1024 * 1024;
function token(): string { return '123456789:' . str_repeat('a', 35); }
function cfg(string $key) { return $GLOBALS['testConfig'][$key] ?? null; }
require __DIR__ . '/../flow/api/vk.php';
require __DIR__ . '/../flow/api/vk-audio.php';
function check(bool $ok, string $message): void { if (!$ok) throw new RuntimeException($message); }
function rejects(callable $fn, string $message): void {
    try { $fn(); } catch (Throwable $e) { check(str_contains($e->getMessage(), $message), 'Wrong error: ' . $e->getMessage()); return; }
    throw new RuntimeException('Expected rejection: ' . $message);
}
$raw = ['id' => 3, 'owner_id' => -2, 'title' => '<script>Track</script>', 'artist' => 'Artist', 'duration' => 123, 'url' => 'https://a.userapi.com/song.mp3'];
$track = VkMusic::track($raw);
check($track['id'] === 'vk:-2_3' && $track['source'] === 'vk' && !$track['restricted'], 'Track mapping');
check(!isset($track['url']), 'Do not expose expiring URL');
check(VkMusic::track(['id' => 1]) === null, 'Reject malformed track');
check(VkMusic::track(array_replace($raw, ['url' => '']))['restricted'], 'Unavailable tracks must be marked');
$seen = [];
$client = new VkMusic('test-only-token', function ($url, $params) use (&$seen, $raw) {
    $seen[] = [$url, $params];
    return ['response' => ['items' => [$raw, $raw, ['id' => 0]], 'count' => 100]];
});
$page = $client->tracks(['kind' => 'search', 'q' => ' Hello ', 'offset' => 50]);
check(count($page['items']) === 1 && $page['nextOffset'] === 53, 'Pagination uses upstream row count, not deduplicated count');
check(str_ends_with($seen[0][0], '/audio.search') && $seen[0][1]['q'] === 'Hello', 'Search routing');
$client->tracks(['kind' => 'playlist', 'ownerId' => -42, 'playlistId' => 0, 'accessKey' => 'secret']);
check($seen[1][1]['owner_id'] === -42 && $seen[1][1]['album_id'] === 0 && $seen[1][1]['access_key'] === 'secret', 'Playlist identity');
check($client->tracks(['kind' => 'search', 'q' => ' '])['nextOffset'] === null, 'Empty search');
rejects(fn () => $client->tracks(['kind' => 'wrong']), 'Неизвестный');
$get = new VkMusic('test', fn ($url, $params) => ['response' => [$raw]]);
check($get->get(['id' => 3, 'ownerId' => -2])['title'] === $raw['title'], 'Resolve exact identity');
rejects(fn () => $get->get(['id' => 4, 'ownerId' => -2]), 'недоступен');
rejects(fn () => $get->get(['id' => 3, 'ownerId' => -2, 'accessKey' => '../bad']), 'Некорректный');
$denied = new VkMusic('test', fn () => ['error' => ['error_code' => 15, 'error_msg' => 'secret-token']]);
rejects(fn () => $denied->tracks([]), 'не разрешил');
$sealed = vk_seal('private-token');
check(!str_contains($sealed, 'private-token') && vk_unseal($sealed) === 'private-token', 'Credential encryption');
$bytes = base64_decode($sealed); $bytes[30] = chr(ord($bytes[30]) ^ 1);
rejects(fn () => vk_unseal(base64_encode($bytes)), 'заново');
foreach (['http://a.userapi.com/a', 'https://userapi.com.evil.test/a', 'https://user:pass@a.userapi.com/a', 'https://127.0.0.1/a', 'https://a.userapi.com:444/a', 'file:///etc/passwd'] as $url) rejects(fn () => vk_media_url($url), 'неподдерживаемый');
check(vk_media_url('https://cs1.userapi.com/a.mp3') === 'cs1.userapi.com', 'Trusted CDN');
check(vk_relative_url('https://a.userapi.com/path/master.m3u8', 'part.ts') === 'https://a.userapi.com/path/part.ts', 'Relative HLS segment');
rejects(fn () => vk_hls_bytes('https://a.userapi.com/a', "#EXTM3U\nsegment.ts"), 'эфиры');
rejects(fn () => vk_hls_bytes('https://a.userapi.com/a', "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key\"\n#EXT-X-ENDLIST"), 'Защищённый');
echo "PHP VK: all checks passed\n";

// Exercise real ffmpeg against an encrypted synthetic HLS segment when installed.
$ffmpeg = trim((string) shell_exec('command -v ffmpeg'));
if ($ffmpeg && is_executable($ffmpeg)) {
    $GLOBALS['testConfig']['ffmpeg_path'] = $ffmpeg;
    $dir = __DIR__ . '/../work';
    if (!is_dir($dir)) mkdir($dir, 0700, true);
    $fixture = tempnam($dir, 'hls-test-');
    try {
        $p = proc_open([$ffmpeg, '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-c:a', 'aac', '-f', 'mpegts', $fixture], [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
        check(proc_close($p) === 0, 'Generate HLS fixture');
        $key = random_bytes(16); $iv = str_repeat("\0", 16);
        $cipher = openssl_encrypt(file_get_contents($fixture), 'aes-128-cbc', $key, OPENSSL_RAW_DATA, $iv);
        $manifest = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST";
        $result = vk_convert_hls('https://a.userapi.com/music/playlist.m3u8', $manifest, fn ($url, $limit) => str_ends_with($url, '/key') ? $key : $cipher);
        check(strlen($result) > 512 && substr($result, 0, 3) === 'ID3', 'Decrypt HLS and transcode to playable MP3');
        echo "PHP HLS: real ffmpeg conversion passed\n";
    } finally { @unlink($fixture); }
} else echo "PHP HLS: ffmpeg not installed, conversion check skipped\n";
