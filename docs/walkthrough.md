# Отчёт: Выполнение Этапа 3 и Этапа 4

---

## Этап 3: Общий слой ботов + Движок подписок

* Реализован в коммите `07ad6d9`: i18n (`ru.json`, `uz.json`), ссылка-приглашение `/start adm_<код>`, меню администратора, стейт-машин подписок, маскирование контактов, фоновый воркер с Redis lock.
* Все 51 тест пройдены успешно.

---

## Этап 4: Бот LeadCatch (DAG-квизы, Redis FSM, валидация телефона и захват лидов)

Этап 4 полностью реализован, протестирован на реальном кластере (PostgreSQL 18 + Redis 7 Memurai) и зафиксирован в git (`b688aef`).

### 1. Архитектура бота LeadCatch (`apps/server/src/bots/leadcatch`)

#### 1.1 Валидатор ориентированного ациклического графа ([dag-validator.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/bots/leadcatch/dag-validator.ts))
* **Zod-схемы в контрактах:** `QuizConfigSchema`, `QuizNodeSchema`, `QuizOptionSchema`, `QuizAnswerSchema` в `@lcqb/contracts`.
* **Алгоритмы валидации графа `validateQuizDag`:**
  * Уникальность идентификаторов узлов и опций внутри каждого узла.
  * Проверка существования `startNodeId` и ссылок `nextNodeId`.
  * **Поиск циклов (Cycle Detection):** алгоритм DFS с 3 состояниями (0: не посещён, 1: в текущем стеке, 2: завершён). При обнаружении обратного ребра граф отклоняется с указанием траектории цикла (`q1 -> q2 -> q1`).
  * **Проверка достижимости (Reachability):** обнаружение и отклонение изолированных («островных») узлов.
  * **Контроль глубины шагов (Path Length Bounds):** любая ветка от корня до терминального узла обязана содержать строго от 3 до 5 шагов (отклоняются цепочки < 3 и > 5).

#### 1.2 Эталонный квиз по умолчанию ([default-quiz.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/bots/leadcatch/default-quiz.ts))
* 3-шаговый DAG-квиз (выбор услуги → удобное время для звонка → бюджет) с двуязычными текстами (RU / UZ). Подключается автоматически для ботов без кастомного JSON в `Bot.settings.quiz`.

#### 1.3 Парсер и нормализатор телефонных номеров ([phone.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/bots/leadcatch/phone.ts))
* Интеграция `libphonenumber-js`.
* Поддержка всех форматов Узбекистана:
  * Стандартный международный: `+998901234567`, `+998 90 123 45 67`, `+998 (90) 123-45-67`.
  * Локальный мобильный: `90 123 45 67`, `901234567` → нормализуется в `+998901234567`.
  * Устаревший префикс СНГ `8`: `8 90 123 45 67`, `8901234567` → нормализуется в `+998901234567`.
  * Городские номера Ташкента: `+998 71 200 00 00`, `71 200 00 00`.
  * Международные номера: Россия (`+7`), США (`+1`), ОАЭ (`+971`), Великобритания (`+44`).
* Строгая фильтрация мусора, невалидных префиксов и посторонних символов.

#### 1.4 Движок FSM и обработка лидов ([quiz-flow.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/bots/leadcatch/quiz-flow.ts) и [index.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/bots/leadcatch/index.ts))
* **Сессия в Redis с TTL 1 час:**
  * Хранение текущего шага `currentNodeId`, количества шагов `stepCount` и истории ответов `answers`.
  * Автоматический сброс: если клиент бездействует 1 час, сессия сгорает в Redis, и при следующем `/start` квиз начинается заново с 1-го вопроса.
* **Двойной сбор контакта:**
  * Нативная кнопка Telegram `requestContact` (`message:contact`).
  * Текстовый ввод (`message:text`) с валидацией через `parseAndNormalizePhone`. При некорректном вводе бот вежливо просит повторить.
* **Сохранение лида и уведомление:**
  * Запись в PostgreSQL `Lead` с полным номером `phoneRaw` и ответами.
  * Вызов `notifyAdmins`: открытый номер при `TRIAL/ACTIVE`, динамически маскированный (`+998 90 *** ** 43`, `***`) с алертом об оплате при `EXPIRED`.
  * Клиент всегда получает вежливое «Спасибо! Ваша заявка принята» без технических ошибок.
* **Глобальный перехватчик `bot.catch`:** защита от сбоев, клиент никогда не видит трассировок ошибок.

---

### 2. Результаты тестирования

Тестирование проводилось на **реальных экземплярах PostgreSQL 18 и Redis 7 Memurai**:

```text
✓ apps/server/test/gateway.test.ts (9 tests)
✓ apps/server/test/database.integration.test.ts (3 tests)
✓ apps/server/test/bot-onboarding.integration.test.ts (5 tests)
✓ apps/server/test/leadcatch.integration.test.ts (4 tests)
✓ apps/server/test/health.test.ts (1 test)
✓ apps/server/test/subscription-worker.integration.test.ts (2 tests)
✓ apps/server/test/leadcatch-phone.test.ts (39 tests)
✓ apps/server/test/leadcatch-dag.test.ts (11 tests)
✓ apps/server/test/core.test.ts (11 tests)
✓ apps/server/test/i18n.test.ts (4 tests)
✓ apps/server/test/subscription.test.ts (16 tests)

Test Files  11 passed (11)
Tests       105 passed (105)
```

### Детали добавленных тестов:
1. **[leadcatch-dag.test.ts](file:///f:/Рабочий%20стол/AAA/apps/server/test/leadcatch-dag.test.ts) (11 тестов):**
   * Валидация дефолтного квиза, 4- и 5-шаговых ветвящихся графов.
   * Выявление циклов (`q1 -> q2 -> q3 -> q1`), самозацикливаний (`q1 -> q1`).
   * Выявление изолированных узлов, невалидных `startNodeId`, дубликатов ID и битых ссылок.
   * Контроль длины: отказ для графов из 2 шагов и 6 шагов.
2. **[leadcatch-phone.test.ts](file:///f:/Рабочий%20стол/AAA/apps/server/test/leadcatch-phone.test.ts) (39 тестов):**
   * Табличное тестирование на 39 реальных и граничных форматах телефонов Узбекистана, международных номерах и мусорных строках.
3. **[leadcatch.integration.test.ts](file:///f:/Рабочий%20стол/AAA/apps/server/test/leadcatch.integration.test.ts) (4 E2E-теста):**
   * **Happy path на TRIAL:** клиент проходит квиз, отправляет контакт кнопкой → лид в базе с нормализованным номером `+998901234567` → администратор получает открытый контакт и ответы на русском.
   * **Сценарий EXPIRED:** подписка истекла → клиент вводит номер текстом `90 987 65 43` → лид сохраняется в базе с полным номером → админ получает замаскированный номер `+998 90 *** ** 43`, имя `***`, алерт об оплате и кнопку «Оплатить» → клиент получает обычное «Спасибо».
   * **Валидация телефона:** клиент вводит невалидный текст `не скажу` → бот вежливо просит повторить → затем валидный `8 90 123 45 67` → лид создаётся.
   * **Брошенный диалог / TTL:** клиент начинает квиз → через 1 час ключ в Redis сгорает → повторный `/start` чисто начинает квиз с первого вопроса.

---

### 3. Результаты Quality Gate (`pnpm verify`)

```text
$ pnpm verify
✔ Typecheck: contracts, server, admin — 0 errors
✔ ESLint: 0 errors, 0 warnings
✔ Dependency-cruiser: 0 violations (163 modules, 369 dependencies cruised)
✔ Knip: 0 dead code issues
✔ Anti-Mock: 0 violations
✔ Vitest: 105 tests passed across 11 test suites
✔ Build: contracts, server, admin (Vite production bundle)
```

Фиксация в Git: `feat(bots): implement LeadCatch DAG quiz, Redis FSM, phone parser and lead capture (stage 4)` (`b688aef`).

---

## Этап 5: Бот QuickBook (Онлайн-запись, слоты, Redis-локи и воркер напоминаний)

Этап 5 полностью реализован, покрыт тестами на реальных PostgreSQL 18 и Redis 7 Memurai и зафиксирован в git (`af4bc8e`).

### 1. Архитектура и реализованные компоненты

1. **Контракты и типизация ([packages/contracts](file:///f:/Рабочий%20стол/AAA/packages/contracts/src/index.ts)):**
   * Zod-схемы `QuickBookConfigSchema`, `QuickBookServiceSchema`, `QuickBookResourceSchema`, `ResourceTypeSchema`.
   * Поддержка кастомизации типов ресурсов (`STAFF` | `TABLE` | `ROOM`) с локализованными лейблами (`resourceLabel`).
2. **Конфигурация по умолчанию ([default-config.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/bots/quickbook/default-config.ts)):**
   * Реализован отраслевой шаблон «Барбершоп»: 3 услуги (Стрижка 45 мин, Борода 30 мин, Комплекс 60 мин) и 2 мастера (Алишер, Жасур) с индивидуальными графиками и перерывами.
3. **Генератор слотов ([slot-generator.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/bots/quickbook/slot-generator.ts)):**
   * Расчёт расписания по часовому поясу `Asia/Tashkent` (UTC+5).
   * Вычитание выходных дней мастеров, рабочих окон и обеденных перерывов.
   * Контроль длительности: слоты, превышающие остаток рабочего дня или пересекающие перерыв, исключаются.
   * Скрытие прошедших слотов за сегодняшний день.
   * Вычитание активных броней из базы данных и временных Redis-блокировок.
   * Алгоритм подбора альтернативных слотов `getAlternativeSlots` при занятости.
4. **Распределённые блокировки слотов ([slot-lock.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/bots/quickbook/slot-lock.ts)):**
   * Атомарный захват слота: `SET lock:slot:{bot}:{staff}:{ts} {user} NX EX 60`.
   * Безопасное снятие через Lua-скрипт с валидацией владельца: чужой лок снять невозможно.
5. **Сервис бронирования ([booking-service.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/bots/quickbook/booking-service.ts)):**
   * Интерактивная транзакция Prisma `$transaction` со страховкой частичным уникальным SQL-индексом `booking_slot_active_uq`.
   * Автоматическое планирование напоминания за 2 часа в Redis ZSET (`booking:reminders`).
   * Мгновенное оповещение админов через `notifyAdmins`: открытые контакты при активной подписке, маскированные при `EXPIRED`.
6. **Фоновый воркер напоминаний за 2 часа ([booking-reminder-worker.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/workers/booking-reminder-worker.ts)):**
   * Запуск по расписанию под распределенным Redis-локом.
   * Выборка наступивших напоминаний (`ZRANGEBYSCORE booking:reminders 0 now`).
   * Отправка сообщений клиентам с кнопками «✅ Подтверждаю» / «❌ Отменить запись».
   * Гарантия однократной отправки (`reminderSent=true`) и исключение отмененных броней.
7. **Интерактивный диалоговый слой grammY ([quickbook-composer.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/bots/quickbook/quickbook-composer.ts)):**
   * Полная цепочка инлайн-кнопок: Услуга → Специалист/Столик → Дата → Слот → Телефон (кнопкой или текстом) → Подтверждение.
   * Обработка колбэков подтверждения и отмены записи.

---

### 2. Результаты тестирования

Все 121 тест в 16 тест-сьютах успешно пройдены:
```text
✓ apps/server/test/gateway.test.ts (9 tests)
✓ apps/server/test/quickbook.integration.test.ts (3 tests)
✓ apps/server/test/quickbook-race.test.ts (1 test)
✓ apps/server/test/bot-onboarding.integration.test.ts (5 tests)
✓ apps/server/test/leadcatch.integration.test.ts (4 tests)
✓ apps/server/test/health.test.ts (1 test)
✓ apps/server/test/database.integration.test.ts (3 tests)
✓ apps/server/test/subscription-worker.integration.test.ts (2 tests)
✓ apps/server/test/quickbook-reminder.test.ts (1 test)
✓ apps/server/test/leadcatch-phone.test.ts (39 tests)
✓ apps/server/test/quickbook-lock.test.ts (4 tests)
✓ apps/server/test/core.test.ts (11 tests)
✓ apps/server/test/subscription.test.ts (16 tests)
✓ apps/server/test/quickbook-slots.test.ts (7 tests)
✓ apps/server/test/leadcatch-dag.test.ts (11 tests)
✓ apps/server/test/i18n.test.ts (4 tests)

Test Files  16 passed (16)
Tests       121 passed (121)
```

**Ключевые верификации:**
1. **Тест гонки (50 параллельных броней одного слота):**
   * Ровно 1 запись создана в БД, 49 получили вежливое уведомление о занятости и список альтернативных слотов.
2. **Безопасность локов:**
   * Попытка другого пользователя снять чужой лок отклонена Lua-скриптом.
3. **Генератор слотов:**
   * Проверены выходные, перерывы, конец смены, фильтрация прошедших слотов и вычитание броней.
4. **Воркер напоминаний:**
   * Сообщение отправляется ровно в 12:00 при брони на 14:00, строго один раз; для отмененных броней не отправляется.
5. **Маскирование при EXPIRED:**
   * Клиент успешно записывается без технических сбоев; админ получает замаскированный номер и кнопку оплаты.

---

### 3. Результаты Quality Gate (`pnpm verify`)

```text
$ pnpm verify
✔ Typecheck: contracts, server, admin — 0 errors
✔ ESLint: 0 errors, 0 warnings
✔ Dependency-cruiser: 0 violations (194 modules, 500 dependencies cruised)
✔ Knip: 0 dead code issues
✔ Anti-Mock: 0 violations
✔ Vitest: 121 tests passed across 16 test suites
✔ Build: contracts, server, admin (Vite bundle < 75 KB gzip)
```

Фиксация в Git: `feat(bots): implement QuickBook booking engine, slot generator, Redis locks, and 2-hour reminders (stage 5)` (`af4bc8e`).

---

## Этап 6: Оплата и чеки (Billing, Receipts, Rollback, Security)

Этап 6 полностью реализован, протестирован на реальном кластере (PostgreSQL 18 + Redis 7 Memurai) и зафиксирован в git (`1672403`).

### 1. Архитектура слоя оплаты и верификации чеков

#### 1.1 Безопасность загрузки и хранение файлов ([receipt-storage.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/bots/shared/receipt-storage.ts))
* **Валидация по Magic Bytes (`validateImageBuffer`):**
  * Проверка бинарной сигнатуры буфера (PNG `89 50 4E 47`, JPEG `FF D8 FF`, WEBP `RIFF...WEBP`).
  * Файлы `.exe` (сигнатура PE/DOS `4D 5A`) или вредоносные скрипты с расширением `.png` немедленно отклоняются (`invalid_magic_bytes`).
  * Файлы PDF (сигнатура `%PDF` `25 50 44 46`) отклоняются с явной ошибкой `pdf_unsupported` и подсказкой «пришлите фото или текст».
* **Защита хранилища (`saveReceiptImage`):**
  * Файлы сохраняются в директорию `UPLOAD_DIR` с уникальным именем `uuidv4.<ext>`.
  * Проверка `path.resolve(baseDir, fileName).startsWith(baseDir)` исключает уязвимости Path Traversal.

#### 1.2 Сервисы управления чеками и подпиской ([payment-service.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/bots/shared/payment-service.ts))
* **Точное добавление месяцев (`addMonths` в `subscription.ts`):**
  * Расчёт в UTC с фиксацией конца месяца (`setUTCDate(0)` при превышении числа дней, например 31 января + 1 месяц = 28/29 февраля).
* **Оптимистичное продление (`submitPaymentReceipt`):**
  * Выполняется в транзакции Prisma.
  * Продление заранее: если у бота уже есть действующий `paidUntil > now`, новый срок вычисляется как `paidUntil + months` (например, оставалось 10 дней + 1 месяц = 10 дней + 1 месяц).
  * Фиксация снимка `prevPaidUntil` и `prevStatus` в записи `PaymentReceipt` (для гарантированного отката).
  * Статус подписки переключается в `ACTIVE`.
  * Инвалидация кэша метаданных бота в Redis (`bot:hash:...`).
* **Одобрение чека (`approveReceipt`):**
  * Перевод статуса чека в `APPROVED`, сброс счётчика `failedReceiptAttempts = 0`.
  * Идемпотентность: повторные и параллельные вызовы не вызывают дублирования.
  * Оповещение администраторов бота через Telegram API (`receipt_approved_push`).
* **Отклонение чека (`rejectReceipt`):**
  * Перевод статуса чека в `REJECTED` с сохранением `rejectionReason`.
  * Откат подписки: `paidUntil = prevPaidUntil`.
  * Инкремент счётчика отклонённых чеков `failedReceiptAttempts`.
  * Стейт-машина:
    * Если предыдущий оплаченный период ещё действует в будущем (`prevPaidUntil > now`) → статус остаётся `ACTIVE`.
    * Если истёк и попытка 1 → статус `GRACE_PERIOD` (осталась 1 попытка).
    * Если попытка 2 → статус `BLOCKED` (блокировка, кнопка оплаты скрывается, отображается контакт поддержки).
  * Отправка пуш-уведомлений администраторам на выбранном ими языке (RU или UZ).
  * Последовательный откат цепочки чеков (два чека подряд откатываются корректно шаг за шагом).

#### 1.3 Обработчики бота и интерактивный диалог ([receipt-handlers.ts](file:///f:/Рабочий%20стол/AAA/apps/server/src/bots/shared/receipt-handlers.ts))
* `admin:pay`: проверка на `BLOCKED` (при блокировке выводится `sub_blocked_alert` с контактом поддержки) → выбор тарифа (1, 6, 12 месяцев).
* `pay:tariff:(\d+)`: фиксация параметров оплаты в сессии (`ctx.session.payment = { months, amountUzs }`), вывод суммы и реквизитов из `PlatformSettings`.
* `message:photo` / `message:document`:
  * Проверка `file_size ≤ 5 MB` **до** загрузки (при превышении бот сразу сообщает об ошибке).
  * Загрузка файла через адаптер транспорта.
  * Валидация сигнатуры magic bytes.
  * Вызов `submitPaymentReceipt`, сброс сессии, подтверждение администратору с датой окончания по ташкентскому времени (UTC+5).
* `message:text`:
  * Проверка длины: минимум 10 символов, максимум 1000 символов.
  * Создание записи `PaymentReceipt` с `kind: TEXT`.
* Кнопки меню админа (📋, 💳, 🌐) и команда `/start` корректно сбрасывают состояние ожидания чека при возврате в меню.

---

### 2. Результаты тестирования

Все тесты выполнены на **реальных PostgreSQL 18 и Redis 7 Memurai**:

```text
✓ apps/server/test/payment-receipt.test.ts (11 tests)
  ✓ Stage 6: Payment and Receipts Integration Tests > File Validation & Magic Bytes Security > should reject .exe file disguised as .png
  ✓ Stage 6: Payment and Receipts Integration Tests > File Validation & Magic Bytes Security > should reject PDF file with pdf_unsupported error
  ✓ Stage 6: Payment and Receipts Integration Tests > File Validation & Magic Bytes Security > should successfully validate genuine PNG, JPEG, and WEBP buffers
  ✓ Stage 6: Payment and Receipts Integration Tests > Bot Payment Flow (Dialog & Inputs) > should reject file > 5 MB before processing
  ✓ Stage 6: Payment and Receipts Integration Tests > Bot Payment Flow (Dialog & Inputs) > should reject .exe file sent as document with invalid format message
  ✓ Stage 6: Payment and Receipts Integration Tests > Bot Payment Flow (Dialog & Inputs) > should reject text receipt < 10 characters and accept valid text receipt
  ✓ Stage 6: Payment and Receipts Integration Tests > Bot Payment Flow (Dialog & Inputs) > should accept valid photo receipt and activate subscription
  ✓ Stage 6: Payment and Receipts Integration Tests > Advance Renewal Logic > should extend from future paidUntil date (+10 days + 1 month)
  ✓ Stage 6: Payment and Receipts Integration Tests > Subscription Lifecycle Scenario: 6m -> reject -> GRACE -> 6m -> reject -> BLOCKED > should follow the complete transition path with RU and UZ text checks
  ✓ Stage 6: Payment and Receipts Integration Tests > Concurrency & Multiple Sequential Receipts > should handle parallel approve calls idempotently (applied once)
  ✓ Stage 6: Payment and Receipts Integration Tests > Concurrency & Multiple Sequential Receipts > should roll back sequential receipts correctly

Test Files  17 passed (17)
Tests       132 passed (132)
```

---

### 3. Результаты Quality Gate (`pnpm verify`)

```text
✔ Typecheck: contracts, server, admin — 0 errors
✔ ESLint: 0 errors, 0 warnings (файлы строго < 300 строк)
✔ Dependency-cruiser: 0 violations (235 modules, 646 dependencies cruised)
✔ Knip: 0 dead code issues
✔ Anti-Mock: 0 violations
✔ Vitest: 132 tests passed across 17 test suites
✔ Build: contracts, server, admin (Vite bundle < 75 KB gzip)
```

Фиксация в Git: `feat(billing): implement payment receipt submission, verification, and subscription rollback (stage 6)` (`1672403`).

