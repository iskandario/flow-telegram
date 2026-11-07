# FLOW на Cloudflare (бесплатно)

Бот, API и мини-апп в одном Cloudflare Worker. Библиотека — в Workers KV.
Нужен только Node.js (есть на маке) и бесплатный аккаунт Cloudflare.

## Запуск
```bash
cd telegram/cloudflare
./deploy.sh flow.torg-lot.ru   # со своим поддоменом (рекомендую)
# или
./deploy.sh                    # на адресе *.workers.dev
```
Скрипт сам: соберёт мини-апп → попросит войти в Cloudflare (браузер) → создаст хранилище →
задеплоит → спросит токен бота (ввод скрыт) → откроет страницу настройки бота.
На ней должно быть «✅ FLOW готов».

Ссылка мини-аппа для BotFather (Bot Settings → Configure Mini App): `https://flow.torg-lot.ru/`

## Обновление
Просто снова `./deploy.sh flow.torg-lot.ru`.

## Только для себя
Cloudflare → Workers → flow → Settings → Variables → добавить `ALLOWED_USERS` = твой ID (команда /id в боте).

## Лимиты бесплатного тарифа
100 000 запросов и 1 000 записей в KV в день — для личного бота с запасом.
