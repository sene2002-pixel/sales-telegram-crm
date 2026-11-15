# Бесплатный ngrok для Telegram CRM

CRM использует отдельный домен `slaw-disallow-unlaced.ngrok-free.dev`. Агент направляет запросы на `host.docker.internal:3000`, где приложение доступно через порт Windows `127.0.0.1:3000`.

- Для обновления приложения из корня CRM используй `docker compose -f compose.yaml up -d --build app`. Туннель определён во внешнем Compose-файле, поэтому обычный запуск приложения не создаёт туннель заново.
- Для управления туннелем используй те же Compose-файлы, с которыми он был создан. Точные пути покажет `docker inspect sales-telegram-crm-tunnel-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'`. Если файлы доступны, передай оба через `-f` и используй `up -d tunnel`.
- Проверяй сначала локальный порт `3000`, затем публичный адрес и авторизацию внутри Telegram. Для диагностики используй `docker logs --tail 50 sales-telegram-crm-tunnel-1`.
- Храни учётные данные ngrok локально. Используй домен CRM для CRM. При `ERR_NGROK_334` проверь, какой endpoint уже обслуживает этот домен.
