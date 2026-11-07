<?php
declare(strict_types=1);

/** VK credentials never reach the Mini App or the audio cache. */
function vk_seal(string $value): string
{
    $iv = random_bytes(12);
    $encrypted = openssl_encrypt($value, 'aes-256-gcm', hash('sha256', 'flow-vk|' . token(), true), OPENSSL_RAW_DATA, $iv, $tag);
    if ($encrypted === false) throw new RuntimeException('Не удалось сохранить подключение VK');
    return base64_encode($iv . $tag . $encrypted);
}

function vk_unseal(string $value): string
{
    $raw = base64_decode($value, true);
    if ($raw === false || strlen($raw) < 29) throw new RuntimeException('Подключи VK заново');
    $plain = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', hash('sha256', 'flow-vk|' . token(), true), OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16));
    if ($plain === false) throw new RuntimeException('Подключи VK заново');
    return $plain;
}

function vk_configured(): bool
{
    return (bool) (cfg('vk_client_id') && cfg('vk_client_secret') && cfg('vk_redirect_uri'));
}

function vk_request(string $url, array $params): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => http_build_query($params),
        CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 30,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_FOLLOWLOCATION => false]);
    $raw = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    unset($ch);
    if ($raw === false || $code !== 200) throw new RuntimeException('VK недоступен. Попробуй ещё раз.');
    $data = json_decode($raw, true);
    if (!is_array($data)) throw new RuntimeException('VK вернул неожиданный ответ');
    return $data;
}

final class VkMusic
{
    private $transport;
    public function __construct(private string $accessToken, ?callable $transport = null)
    {
        $this->transport = $transport ?? 'vk_request';
    }
    public function call(string $method, array $params = []): array
    {
        $data = ($this->transport)('https://api.vk.com/method/' . $method,
            $params + ['access_token' => $this->accessToken, 'v' => '5.199']);
        if (isset($data['error'])) {
            $code = (int) ($data['error']['error_code'] ?? 0);
            $messages = [
                5 => 'Сессия VK истекла. Подключи VK заново.',
                6 => 'Слишком много запросов к VK. Подожди немного.',
                9 => 'VK временно ограничил запросы. Попробуй позже.',
                14 => 'VK просит проверку. Открой VK в браузере, пройди её и повтори.',
                17 => 'Подтверди вход на сайте VK и подключи аккаунт заново.',
                7 => 'VK не разрешил доступ к музыке этому приложению.',
                15 => 'VK не разрешил доступ к музыке этому приложению.',
                20 => 'Тип приложения VK не поддерживает доступ к музыке.',
                23 => 'VK отключил этот метод для приложения.',
                201 => 'VK не разрешил доступ к этой музыке.',
            ];
            throw new RuntimeException($messages[$code] ?? 'Ошибка VK. Попробуй позже.', $code);
        }
        if (!isset($data['response']) || !is_array($data['response'])) throw new RuntimeException('VK вернул неожиданный ответ');
        return $data['response'];
    }
    public static function track(array $raw): ?array
    {
        $id = (int) ($raw['id'] ?? 0);
        $owner = (int) ($raw['owner_id'] ?? 0);
        if ($id <= 0 || !$owner || empty($raw['title'])) return null;
        return ['id' => "vk:$owner" . "_$id", 'source' => 'vk',
            'title' => mb_substr((string) $raw['title'], 0, 200), 'artist' => mb_substr((string) ($raw['artist'] ?? ''), 0, 200),
            'duration' => max(0, (int) ($raw['duration'] ?? 0)), 'size' => 0,
            'identity' => ['id' => $id, 'ownerId' => $owner, 'accessKey' => substr((string) ($raw['access_key'] ?? ''), 0, 200)],
            'restricted' => empty($raw['url']) || !empty($raw['content_restricted'])];
    }
    public function tracks(array $query): array
    {
        $offset = max(0, min(10000, (int) ($query['offset'] ?? 0)));
        $count = 50;
        $params = ['offset' => $offset, 'count' => $count];
        $kind = $query['kind'] ?? 'my';
        if ($kind === 'search') {
            $q = mb_substr(trim((string) ($query['q'] ?? '')), 0, 200);
            if ($q === '') return ['items' => [], 'count' => 0, 'nextOffset' => null];
            $response = $this->call('audio.search', $params + ['q' => $q, 'auto_complete' => 1]);
        } elseif ($kind === 'playlist') {
            $owner = (int) ($query['ownerId'] ?? 0);
            $id = (int) ($query['playlistId'] ?? 0);
            if (!$owner || $id < 0) throw new InvalidArgumentException('Некорректный плейлист');
            $response = $this->call('audio.get', $params + ['owner_id' => $owner, 'album_id' => $id,
                'access_key' => substr((string) ($query['accessKey'] ?? ''), 0, 200)]);
        } elseif ($kind === 'my') {
            $response = $this->call('audio.get', $params);
        } else throw new InvalidArgumentException('Неизвестный раздел VK');
        $raw = $response['items'] ?? [];
        $items = [];
        foreach ($raw as $item) if (is_array($item) && ($t = self::track($item))) $items[$t['id']] = $t;
        $total = max(0, (int) ($response['count'] ?? count($raw)));
        $next = $offset + count($raw);
        return ['items' => array_values($items), 'count' => $total, 'nextOffset' => $raw && $next < $total ? $next : null];
    }
    public function playlists(int $offset): array
    {
        $response = $this->call('audio.getPlaylists', ['offset' => max(0, min(10000, $offset)), 'count' => 50]);
        $items = [];
        foreach ($response['items'] ?? [] as $p) {
            if (empty($p['owner_id']) || !isset($p['id'])) continue;
            $items[] = ['id' => (int) $p['id'], 'ownerId' => (int) $p['owner_id'],
                'accessKey' => substr((string) ($p['access_key'] ?? ''), 0, 200),
                'title' => mb_substr((string) ($p['title'] ?? 'Плейлист'), 0, 200), 'count' => (int) ($p['count'] ?? 0)];
        }
        $next = $offset + count($response['items'] ?? []);
        return ['items' => $items, 'nextOffset' => $next < (int) ($response['count'] ?? 0) && $items ? $next : null];
    }
    public function get(array $identity): array
    {
        $id = (int) ($identity['id'] ?? 0);
        $owner = (int) ($identity['ownerId'] ?? 0);
        $key = (string) ($identity['accessKey'] ?? '');
        if ($id <= 0 || !$owner || !preg_match('/^[a-zA-Z0-9_-]{0,200}$/', $key)) throw new InvalidArgumentException('Некорректный трек VK');
        $data = $this->call('audio.getById', ['audios' => $owner . '_' . $id . ($key !== '' ? '_' . $key : '')]);
        $raw = ($data['items'] ?? $data)[0] ?? null;
        if (!is_array($raw) || (int) ($raw['id'] ?? 0) !== $id || (int) ($raw['owner_id'] ?? 0) !== $owner) throw new RuntimeException('Трек удалён или недоступен в VK');
        return $raw;
    }
}

function vk_client(int $uid): VkMusic
{
    $session = read_library($uid)['vk'] ?? null;
    if (!$session || ($session['expires'] && $session['expires'] <= time())) throw new RuntimeException('Подключи VK заново');
    return new VkMusic(vk_unseal($session['token']));
}

function vk_api(int $uid, string $action): void
{
    if (in_array($action, ['vk-login', 'vk-logout', 'vk-add'], true) && $_SERVER['REQUEST_METHOD'] !== 'POST') {
        json_out(405, ['error' => 'POST only']); return;
    }
    try {
        if ($action === 'vk-status') {
            $s = read_library($uid)['vk'] ?? null;
            json_out(200, ['configured' => vk_configured(), 'connected' => (bool) ($s && (!$s['expires'] || $s['expires'] > time())),
                'profile' => $s ? ['name' => $s['name'], 'id' => $s['id']] : null]);
        } elseif ($action === 'vk-login') {
            if (!vk_configured()) { json_out(503, ['error' => 'Подключение VK ещё не настроено владельцем FLOW.']); return; }
            $nonce = bin2hex(random_bytes(32));
            with_library($uid, function (array &$lib) use ($nonce) { unset($lib['vk_exchange']); $lib['vk_pending'] = ['hash' => hash('sha256', $nonce), 'expires' => time() + 600]; });
            $url = 'https://oauth.vk.com/authorize?' . http_build_query(['client_id' => cfg('vk_client_id'),
                'redirect_uri' => cfg('vk_redirect_uri'), 'display' => 'mobile', 'scope' => 'audio,offline',
                'response_type' => 'code', 'v' => '5.199', 'state' => $uid . '.' . $nonce]);
            json_out(200, ['url' => $url]);
        } elseif ($action === 'vk-logout') {
            with_library($uid, function (array &$lib) {
                unset($lib['vk'], $lib['vk_pending'], $lib['vk_exchange']);
                $lib['tracks'] = array_values(array_filter($lib['tracks'], fn ($t) => ($t['source'] ?? '') !== 'vk'));
            });
            json_out(200, ['ok' => true]);
        } elseif ($action === 'vk-list') {
            json_out(200, vk_client($uid)->tracks($_GET));
        } elseif ($action === 'vk-playlists') {
            json_out(200, vk_client($uid)->playlists(max(0, (int) ($_GET['offset'] ?? 0))));
        } elseif ($action === 'vk-add') {
            $body = file_get_contents('php://input', false, null, 0, 4097);
            if (strlen($body) > 4096) { json_out(413, ['error' => 'Слишком большой запрос']); return; }
            $input = json_decode($body, true);
            if (!is_array($input)) throw new InvalidArgumentException('Некорректный запрос');
            $session = read_library($uid)['vk'] ?? null;
            $raw = vk_client($uid)->get($input);
            $track = VkMusic::track($raw);
            if (!$track || $track['restricted']) throw new RuntimeException('VK не разрешает воспроизвести этот трек');
            if ($track['duration'] > 720) throw new RuntimeException('Для сета выбери трек короче 12 минут');
            $track['vk_user'] = $session['id'];
            $track['added'] = time();
            with_library($uid, function (array &$lib) use ($track, $session) {
                if (($lib['vk']['id'] ?? null) !== $session['id']) throw new RuntimeException('Аккаунт VK изменился. Повтори добавление.');
                foreach ($lib['tracks'] as $t) if ($t['id'] === $track['id']) return;
                if (count($lib['tracks']) >= (int) (cfg('max_tracks') ?: 10000)) throw new RuntimeException('Библиотека заполнена. Удали ненужные треки.');
                array_unshift($lib['tracks'], $track);
            });
            unset($track['vk_user'], $track['added'], $track['identity']);
            json_out(200, ['track' => $track]);
        } else json_out(404, ['error' => 'Unknown action']);
    } catch (InvalidArgumentException $e) { json_out(400, ['error' => $e->getMessage()]);
    } catch (RuntimeException $e) { json_out(422, ['error' => $e->getMessage()]); }
}
