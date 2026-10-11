# Implementation Plan — Stage 4: LeadCatch Bot (DAG Quiz, Redis FSM & Lead Capture)

## Goal Description
Реализовать сценарий бота **LeadCatch** (сбор заявок и лидогенерация) в рамках монорепозитория:
1. Строгая Zod-схема и валидатор графа квиза (**DAG**, Directed Acyclic Graph) на 3–5 шагов без циклов с двуязычными текстами (RU/UZ).
2. FSM-движок на базе Redis сессий (`PlatformBotSession`) со временем жизни (TTL) 1 час.
3. Двойной сбор контакта: нативная кнопка Telegram `request_contact` + текстовый парсер на базе `libphonenumber-js` со строгой нормализацией в E.164 (`+998...`).
4. Сохранение лида в PostgreSQL (`Lead`) с полным `phoneRaw` и ответами.
5. Интеграция с движком уведомлений `notifyAdmins`:
   - При `TRIAL/ACTIVE` — полный номер и имя администраторам.
   - При `EXPIRED/GRACE_PERIOD/BLOCKED` — маскированные контакты (`+998 90 *** ** 67`, `***`) и кнопка «Оплатить».
   - Для клиента — всегда безупречный UX без ошибок и намёков на неоплаченную подписку владельца.
6. Отказоустойчивый `bot.catch` — защита от падений.

---

## User Review Required

> [!IMPORTANT]
> **Установка внешней зависимости `libphonenumber-js`:**
> Для парсинга телефонных номеров требуется пакет `libphonenumber-js`. Он будет добавлен в `apps/server/package.json`. Пакет легковесный, без нативных бинарников, стандарт де-факто для валидации номеров в Node.js.

> [!NOTE]
> **Дефолтный квиз бота:**
> Если в настройках бота (`bot.settings.quiz`) конфигурация квиза не задана, LeadCatch автоматически запускает предустановленный эталонный 3-шаговый DAG-квиз (выбор услуги → удобное время для связи → бюджет/комментарий), переведенный на русский и узбекский языки.

---

## Proposed Changes

```mermaid
flowchart TD
    A["Клиент: /start"] --> B{"Язык выбран?"}
    B -->|Нет| C["Выбор 🇷🇺 / 🇺🇿"]
    B -->|Да| D["Старт LeadCatch FSM"]
    C --> D
    D --> E["Отображение Вопроса 1 (Inline Buttons)"]
    E --> F["Клиент жмет кнопку ответа"]
    F --> G["Запись в Redis FSM (TTL 1ч)"]
    G --> H{"Есть следующий узел?"}
    H -->|Да| I["Отображение Вопроса 2..N"]
    I --> F
    H -->|Нет (финал DAG)| J["Запрос контакта (кнопка + текст)"]
    J --> K{"Отправлен контакт?"}
    K -->|Кнопка Telegram| L["Извлечение phone"]
    K -->|Текстовое сообщение| M["Парсинг через libphonenumber-js"]
    M -->|Невалидный| N["Вежливая подсказка + повтор"]
    N --> J
    L --> O["Нормализация E.164 (+998...)"]
    M -->|Валидный| O
    O --> P["Сохранение в PostgreSQL: table Lead"]
    P --> Q["notifyAdmins(botId, LEAD, status)"]
    Q --> R["Клиенту: 'Спасибо! Скоро свяжемся'"]
    P --> S["Очистка FSM в Redis"]
```

---

### 1. Контракты DTO (`packages/contracts`)

#### [MODIFY] `packages/contracts/src/index.ts`
Добавление Zod-схем структуры DAG-квиза:
- `QuizOptionSchema`: `{ id: string, text: { ru: string, uz: string }, nextNodeId?: string | null }`
- `QuizNodeSchema`: `{ id: string, title: { ru: string, uz: string }, options: QuizOption[] }`
- `QuizConfigSchema`: `{ startNodeId: string, nodes: QuizNode[] }`
- `QuizAnswerSchema`: `{ question: string, answer: string, optionId?: string }`

---

### 2. Серверная часть (`apps/server`)

#### [MODIFY] `apps/server/package.json`
Добавление зависимости `libphonenumber-js`.

#### [NEW] `apps/server/src/bots/leadcatch/dag-validator.ts`
- `validateQuizDag(config: QuizConfig): { valid: boolean; errors: string[] }`:
  - Проверка уникальности идентификаторов узлов и опций.
  - Поиск циклов в ориентированном графе (DFS с белым/серым/черным окрашиванием).
  - Проверка длины цепочек: любая траектория от `startNodeId` до терминального узла обязана содержать от 3 до 5 шагов.
  - Проверка достижимости: все объявленные узлы должны быть достижимы из `startNodeId`.

#### [NEW] `apps/server/src/bots/leadcatch/default-quiz.ts`
- Дефолтная конфигурация DAG-квиза (3 шага) на русском и узбекском языках для ботов без кастомного JSON в `settings`.

#### [NEW] `apps/server/src/bots/leadcatch/phone.ts`
- `parseAndNormalizePhone(raw: string, defaultCountry = "UZ"): { isValid: boolean; normalized?: string; error?: string }`:
  - Нормализация локальных номеров Узбекистана (`90 123 45 67`, `8 90 123 45 67`, `+998 90 123-45-67`).
  - Поддержка международных номеров.
  - Отсечение мусора и некорректных длин.

#### [NEW] `apps/server/src/bots/leadcatch/quiz-flow.ts`
- Функции рендеринга и обработки FSM:
  - `startLeadCatchQuiz(ctx, prisma)`: сброс/инициализация FSM-сессии, отправка первого вопроса.
  - `handleQuizAnswer(ctx, prisma, optionId)`: переход к следующему узлу, обновление сессии в Redis.
  - `handleContactReceived(ctx, prisma, phoneRaw)`: запись лида в PostgreSQL, вызов `notifyAdmins`, отправка клиенту сообщения «Спасибо».

#### [MODIFY] `apps/server/src/gateway/types.ts`
- Типизация сессии: расширение `PlatformBotSession` полями `quiz?: QuizSessionState`.

#### [MODIFY] `apps/server/src/bots/leadcatch/index.ts`
- Полноценная регистрация обработчиков LeadCatch:
  - Регистрация callback-query `lc:opt:<nodeId>:<optId>`.
  - Регистрация слушателя `message:contact` (нативная кнопка Telegram).
  - Регистрация текстового парсера `message:text` для ввода телефона и перезапуска квиза.
  - `bot.catch()` с безопасным логированием и защитой от падений.

#### [MODIFY] `apps/server/src/gateway/bot-pool.ts`
- Передача `this.prisma` в `registerLeadCatchBot(bot, this.prisma)`.

---

## Verification Plan

### Automated Tests
1. **Тесты валидатора DAG-квиза (`test/leadcatch-dag.test.ts`):**
   - Корректный 3-шаговый и 4-шаговый граф → `valid: true`.
   - Граф с циклом (Node A → Node B → Node A) → отклонён с понятной ошибкой.
   - Недостижимый «островной» узел → отклонён.
   - Слишком короткий путь (< 3 шагов) или слишком длинный (> 5 шагов) → отклонён.
2. **Табличный тест парсера телефонов (`test/leadcatch-phone.test.ts`):**
   - 30+ тестовых форматов:
     - `+998901234567`, `+998 90 123 45 67`, `901234567`, `90 123 45 67`, `8 90 123 45 67`, `(90) 123-45-67`.
     - Международные: `+7 999 123 45 67`, `+1 202 555 0123`.
     - Невалидные: `"привет"`, `"123"`, `"998"`, `"abcdef"`, `""`, `"0000000000"`.
3. **E2E-тесты полного диалога (`test/leadcatch.integration.test.ts`):**
   - Прогон на реальном PostgreSQL 18 и Redis 7 Memurai.
   - Сценарий 1: `/start` → выбор языка → ответы на 3 вопроса → отправка контакта кнопкой → запись лида в базу → админ получает открытый контакт (`TRIAL`).
   - Сценарий 2: Тот же сценарий при `EXPIRED` подписке → лид сохраняется в БД с полным номером, админ получает замаскированный номер (`+998 90 *** ** 67`) с алертом об оплате, клиент получает чистое «Спасибо».
   - Сценарий 3: Клиент пишет телефон текстом (`"90 123 45 67"`).
   - Сценарий 4: Клиент вводит некорректный текст ("бла-бла") на шаге телефона → бот вежливо просит повторить.
   - Сценарий 5: Истечение FSM-сессии в Redis (симуляция 1 часа неактивности) → повторный `/start` начинает квиз заново с 1 вопроса.
4. **Quality Gate:**
   - `pnpm verify` (typecheck, lint, depcruise, knip, check-mocks, test, build) со 100% успехом.

### Manual Verification
- Возможность запустить бота локально с реальным `DEV_LEADCATCH_TOKEN` из `.env` и пройти квиз в Telegram со смартфона или десктопа.
