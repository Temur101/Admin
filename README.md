# LeadCatch & QuickBook Platform

Мультитенантная платформа для управления Telegram-ботами двух типов (LeadCatch — квиз-захват лидов, QuickBook — онлайн-запись на услуги) под управлением единой React-панели.

## Стек технологий
* **Backend:** Node.js (Fastify, grammY, Prisma)
* **Database:** PostgreSQL 18
* **Cache & Locks:** Redis 7 (Memurai Developer)
* **Frontend:** React 19 (Vite, Tailwind CSS, Lucide Icons)
* **Monorepo:** pnpm workspaces, TypeScript strict

---

## Локальное окружение (Windows)

### 1. Запуск сервисов
Сервисы запускаются локально без конфликтов и без прав администратора:

* **PostgreSQL 18** работает на порту `5433`:
  ```powershell
  # Запуск сервера БД вручную (если остановлен):
  & "F:\Postgres\bin\postgres.exe" -D "f:\Рабочий стол\AAA\.local_data\postgres"
  ```
* **Redis / Memurai 7** работает на порту `6379`:
  ```powershell
  # Запуск Redis:
  & "f:\Рабочий стол\AAA\tools\memurai\Memurai\memurai.exe" --port 6379 --maxmemory 64mb
  ```

### 2. Подключение к БД через терминал
```powershell
# Подключение к dev-базе под пользователем приложения lcqb_app:
$env:PGPASSWORD = "<пароль_из_.env>"
& "F:\Postgres\bin\psql.exe" -U lcqb_app -h 127.0.0.1 -p 5433 -d leadcatch_quickbook_dev

# Проверка Redis:
& "f:\Рабочий стол\AAA\tools\memurai\Memurai\memurai-cli.exe" ping
# Ответ: PONG
```

---

## Скрипты разработки и сборки

### Проверенные версии окружения
- **Node.js:** `>= 20` (проверено на `v24.15.0`)
- **pnpm:** `>= 9` (проверено на `v9.15.4`)
- **PostgreSQL:** `>= 16` (проверено на `v18.0` с расширением `btree_gist`)
- **Redis:** `>= 7.0` (проверено на Memurai `v4.1.4 / Redis 7.0`)

### Порядок генерации, сборки и запуска
```bash
# 1. Установка зависимостей
pnpm install

# 2. Генерация Prisma Client
pnpm --filter @lcqb/server exec prisma generate

# 3. Применение миграций БД
pnpm --filter @lcqb/server exec prisma migrate deploy

# 4. Проверка качества всего репозитория
pnpm verify

# 5. Сборка всех пакетов (contracts, server, admin)
pnpm build

# 6. Запуск сервера в production режиме
pnpm --filter @lcqb/server start
```

### Dev-режим
```bash
# Запуск бэкенда в dev-режиме
pnpm dev:server

# Запуск React админки в dev-режиме
pnpm dev:admin
```
