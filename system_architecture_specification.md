# Техническая архитектура платформы LeadCatch & QuickBook

## 1. Концепция и ресурсные ограничения
Система строится по модели **Multi-tenant Core**: единый бэкенд и база данных обслуживают произвольное количество ботов двух типов (LeadCatch и QuickBook) под управлением единой React-панели.
*   **Хостинг:** VPS (1-2 vCPU, 2 GB RAM, 20-40 GB NVMe).
*   **Бюджет:** $3–$5/мес.
*   **Стек ядра:** 
    *   Бэкенд: **Node.js (Fastify + grammY)** ИЛИ **Python (FastAPI + aiogram 3)** в асинхронном режиме. Fastify/grammY предпочтительнее для жесткой экономии RAM ($< 150$ MB под нагрузкой).
    *   База данных: **PostgreSQL 16** (строгие транзакции, реляционные связи, JSONB для динамических анкет).
    *   Кэш и очереди: **Redis 7** (хранение FSM-состояний сессий, распределенные блокировки слотов, буфер очередей).
    *   Фронтенд: **React (Vite + Tailwind CSS + Lucide Icons)**. Статический билд раздается через **Nginx**.
    *   Обратный прокси и SSL: **Nginx + Let's Encrypt**.

---

## 2. Архитектура Multi-Tenant Webhook Gateway

Запуск отдельных процессов или Long Polling под каждого бота на VPS за $3 приведет к мгновенному падению сервера по памяти (OOM Killer). Решение — **единый шлюз вебхуков**.

```
[Пользователь Telegram] 
        │
        ▼ (HTTPS POST)
[Nginx Reverse Proxy] (:443)
        │
        ▼ (Proxy Pass http://127.0.0.1:8000)
[Webhook Gateway Router]
        │
        ├──> POST /api/v1/tg/webhook/{bot_token_hash}
        │
        ├── 1. Извлечение bot_token_hash -> поиск tenant_id в Redis Cache (< 2ms)
        ├── 2. Определение типа бота (LEADCATCH vs QUICKBOOK)
        ├── 3. Проверка статуса подписки (ACTIVE / TRIAL / GRACE_PERIOD / SUSPENDED)
        ├── 4. Передача Update в изолированный FSM-пайплайн соответствующего бота
        │
        └──> Немедленный возврат HTTP 200 OK в Telegram API
```

---

## 3. Спецификация ботов и бизнес-механик

### Бот 1: LeadCatch (Квиз-захват)
*   **Механика:** Динамический опросник (DAG) на 3–5 шагов с ветвлением. Конфигурация вопросов хранится в формате JSONB в БД.
*   **Сбор контакта:** Двойной режим — кнопка `request_contact` (смартфоны) + текстовый парсер (Telegram Desktop) со строгой валидацией телефонных масок.
*   **Подписочный гейт (Shadow Lead):**
    *   Статус `ACTIVE` или `TRIAL`: номер телефона отправляется менеджеру открытым текстом (`+998901234567`).
    *   Статус `EXPIRED` / `GRACE_PERIOD`: номер маскируется (`+998 90 *** ** 67`), создается карточка упущенной выгоды с кнопкой «Оплатить подписку для открытия контакта».
    *   Бот для конечных клиентов **никогда не останавливается** и не показывает ошибок.

### Бот 2: QuickBook (Запись и мини-витрина)
*   **Механика слотов:** Выбор услуги -> сотрудника/ресурса -> даты -> свободного временного слота.
*   **Защита от состояния гонки (Race Condition / Double Booking):**
    *   Перед подтверждением бронирования вызывается распределенная блокировка в Redis:
        `SET lock:slot:{bot_id}:{service_id}:{timestamp} {user_id} NX EX 60`
    *   Если слот занят в процессе оформления другим клиентом, пользователю мягко предлагается выбрать соседнее окно.
*   **Планировщик напоминаний:** Фоновый процесс (Cron / Redis ZSET), проверяющий записи за 2 часа до начала. Отправляет пуш с кнопками «Подтверждаю» / «Отменить».
*   **Подписочный гейт:** При истечении оплаты клиенты видят сообщение о технических работах или ограничение на глубину записи, а владельцу шлется уведомление с реквизитами.

---

## 4. Схема Базы Данных (PostgreSQL)

```sql
-- Тенанты (клиенты платформы)
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_name VARCHAR(255) NOT NULL,
    contact_phone VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Боты, привязанные к тенантам
CREATE TYPE bot_type_enum AS ENUM ('LEADCATCH', 'QUICKBOOK');
CREATE TYPE subscription_status_enum AS ENUM ('TRIAL', 'ACTIVE', 'GRACE_PERIOD', 'BLOCKED');

CREATE TABLE bots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    bot_type bot_type_enum NOT NULL,
    bot_token VARCHAR(255) NOT NULL UNIQUE,
    bot_token_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256 токена для безопасного url вебхука
    bot_username VARCHAR(100),
    settings JSONB NOT NULL DEFAULT '{}', -- вопросы квиза, каталог, расписание
    notification_chat_id BIGINT, -- ID группы менеджеров
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Подписки и биллинг
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID REFERENCES bots(id) ON DELETE CASCADE,
    status subscription_status_enum NOT NULL DEFAULT 'TRIAL',
    trial_ends_at TIMESTAMP WITH TIME ZONE NOT NULL,
    paid_until TIMESTAMP WITH TIME ZONE,
    failed_receipt_attempts INT DEFAULT 0, -- счетчик фейковых чеков (лимит: 2)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Чеки об оплате (верификация)
CREATE TYPE receipt_status_enum AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE payment_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID REFERENCES bots(id) ON DELETE CASCADE,
    image_path VARCHAR(500) NOT NULL,
    telegram_file_id VARCHAR(255) NOT NULL,
    status receipt_status_enum NOT NULL DEFAULT 'PENDING',
    rejection_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    reviewed_at TIMESTAMP WITH TIME ZONE
);

-- Лиды (LeadCatch)
CREATE TABLE leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID REFERENCES bots(id) ON DELETE CASCADE,
    customer_tg_id BIGINT NOT NULL,
    customer_name VARCHAR(255),
    customer_username VARCHAR(100),
    phone_raw VARCHAR(50) NOT NULL,
    answers JSONB NOT NULL,
    is_masked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Записи и Заказы (QuickBook)
CREATE TYPE booking_status_enum AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED');

CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID REFERENCES bots(id) ON DELETE CASCADE,
    customer_tg_id BIGINT NOT NULL,
    customer_phone VARCHAR(50) NOT NULL,
    service_name VARCHAR(255) NOT NULL,
    slot_time TIMESTAMP WITH TIME ZONE NOT NULL,
    status booking_status_enum DEFAULT 'PENDING',
    reminder_sent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

---

## 5. Пайплайн верификации чеков и защита от мошенничества

```
                    [Подписка истекла / Запрос на продление]
                                       │
                                       ▼
                     Бот отправляет реквизиты карты + Payme/Click
                                       │
                                       ▼
                   Клиент загружает скриншот чека в бота
                                       │
             ┌─────────────────────────┴─────────────────────────┐
             ▼                                                   ▼
Файл сохраняется локально (/uploads)              Статус подписки временно -> ACTIVE
В админку летит карточка чека                     (Grace Access: клиент не паникует)
             │
             ▼
Администратор в React-панели сверяет выписку банка со скриншотом:
             │
     ┌───────┴───────────────────────────────────────┐
     ▼ [Подтвердить]                                 ▼ [Отклонить чек]
Подписка продлевается на 30 дней.           failed_receipt_attempts += 1
Клиенту отправляется пуш:                    │
"Оплата подтверждена! Спасибо."              ├── Если attempts == 1:
                                             │   Клиенту пуш: "Чек не найден в выписке. 
                                             │   У вас осталась 1 попытка прислать корректный чек."
                                             │   Статус возвращается в GRACE_PERIOD.
                                             │
                                             └── Если attempts >= 2:
                                                 Статус подписки -> BLOCKED.
                                                 Клиенту пуш: "Аккаунт заблокирован из-за 
                                                 повторного некорректного чека. 
                                                 Свяжитесь с поддержкой: @admin".
```

---

## 6. Архитектура React Админ-панели

Приложение состоит из двух базовых модулей с защитой по JWT-авторизации:

1.  **Страница управления ботами и тенантами (`/tenants`):**
    *   Форма быстрого создания: Имя клиента -> Выбор типа бота (LeadCatch / QuickBook) -> Токен бота -> Выбор длительности триала (по умолчанию 3 дня).
    *   Редактор конфигурации (JSON-схема или визуальный конструктор вопросов для LeadCatch; прайс-лист и слоты для QuickBook).
    *   Статус бота (Active / Trial / Expired / Blocked) и счетчик лидов/записей за месяц.
2.  **Страница верификации платежей (`/receipts`):**
    *   Лента ожидающих подтверждения чеков (`PENDING`) с отображением превью скриншота, даты загрузки, имени клиента и суммы.
    *   Быстрые действия: кнопка «Одобрить» (в 1 клик продлевает `paid_until` на +30 дней) и «Отклонить» (с выбором причины).