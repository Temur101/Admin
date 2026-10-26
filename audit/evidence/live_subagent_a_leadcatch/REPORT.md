# Живая E2E-верификация Бизнеса А (LeadCatch бот `@leadcatchteset_bot`)

- **Дата и время проверки**: `2026-10-19T16:24:01Z`
- **Тенант (Клиент А)**: `Клиент А — Студия маркетинга LeadPro` (`id: 882160ca-c589-49f7-a01c-79759a0f3541`)
- **Бот 1 (`LEADCATCH`)**: `@leadcatchteset_bot` (`id: b3462648-55a6-42d1-baac-f855448652d6`)
- **Шлюз вебхуков**: `POST http://127.0.0.1:8000/api/v1/tg/webhook/7fdc908b7d3ab6d9f3f43015739c18f1354e2c83943cd98f6ae6ccda5aef47d1`
- **Секрет вебхука (`x-telegram-bot-api-secret-token`)**: `5d3a31d092841f0c24a5cf1facf698534cb5c3ff58ddc3967cd024913a47e335`
- **Инвайт-код админа Бота 1**: `d81d9c0bd197b6a1d487e89b5405bd3a`
- **Режим транспорта живого сервера**: `USE_MOCK_TELEGRAM=false` (реальный `https://api.telegram.org`)

---

## 1. Конфигурация Бота 1 в PostgreSQL (`leadcatch_quickbook_test`)

Из таблицы `bots` прочитана живая запись Бота 1 (без чтения/вывода `botTokenEnc`):
- `botType`: `LEADCATCH`
- `isActive`: `true`
- `subscription.status`: `TRIAL` (до `2026-10-26T16:07:30.049Z`)
- `settings` (шаблон `education_center`, 5 узлов DAG):
  1. `q1_subject` («Какое направление вас интересует?») -> `opt_it`, `opt_lang`, `opt_math` -> `q2_level`
  2. `q2_level` («Ваш текущий уровень знаний?») -> `opt_beginner`, `opt_middle` -> `q3_schedule`
  3. `q3_schedule` («В какое время вам удобно учиться?») -> `opt_morning`, `opt_evening` -> `q4_goal`
  4. `q4_goal` («Ваша главная цель обучения?») -> `opt_job`, `opt_hobby` -> `q5_phone`
  5. `q5_phone` («Оставьте контактный номер для связи с куратором:») -> `opt_phone_finish` -> `nextNodeId: null` (переход в `__contact__`)

---

## 2. Результаты проверок через живой HTTP-шлюз

### Шаг А — Регистрация админа бизнеса (`tgId = 700001001`)
- Отправлен апдейт `update_id = 920001`: `/start adm_d81d9c0bd197b6a1d487e89b5405bd3a` и `update_id = 920002`: `callback_query` `set_lang:RU`.
- Ответ шлюза: `HTTP 200 {"ok":true}`.
- Запись в PostgreSQL (`bot_users`):
  - `id`: `7e79e727-9c86-403d-84f6-1907be165b02`
  - `botId`: `b3462648-55a6-42d1-baac-f855448652d6`
  - `tgId`: `700001001`
  - `firstName`: `"Тимур Админ А"`, `username`: `"leadpro_owner"`
  - `lang`: `"RU"`
  - `isAdmin`: **`true`** (права администратора Бота 1 выданы корректно).

### Шаг Б — Негативный тест межтенантовой изоляции инвайта (`tgId = 700001099`)
- Пользователь `tgId = 700001099` отправил в Бот 1 чужой инвайт от Бота 2 (`update_id = 920003`, `/start adm_d84c658f4e7f0f530330bcc9267c147d`).
- Ответ шлюза: `HTTP 200 {"ok":true}`.
- Запись в PostgreSQL (`bot_users`):
  - `id`: `f02fbb46-9bbc-4f7d-8cec-c97f10acfb2a`
  - `botId`: `b3462648-55a6-42d1-baac-f855448652d6`
  - `tgId`: `700001099`
  - `isAdmin`: **`false`** (изоляция подтверждена, чужой инвайт-код отвергнут).

### Шаг В — Полное прохождение квиза клиентом 1 (`tgId = 700002001`, `first_name: "Азиз"`)
- Пройден весь маршрут (`update_id` `920004`..`920011`):
  1. `/start` -> создан `BotUser` (`tgId = 700002001`, `firstName = "Азиз"`, `isAdmin = false`).
  2. `set_lang:RU` -> в БД установлен язык `lang = "RU"`, инициализирована FSM-сессия в Redis (`sess:b3462648-55a6-42d1-baac-f855448652d6:700002001`, `attemptId = 55b69942-f5f6-40d5-a19f-ed9ebfda3709`).
  3. Узлы квиза через `callback_query` (`lc:ans:<tag>:<nodeHash>:<optHash>`):
     - `q1_subject` -> `opt_it` («💻 Программирование / IT») -> переход в `q2_level`
     - `q2_level` -> `opt_beginner` («🌱 Начинающий (с нуля)») -> переход в `q3_schedule`
     - `q3_schedule` -> `opt_evening` («🌙 Вечер (18:00 - 21:00)») -> переход в `q4_goal`
     - `q4_goal` -> `opt_job` («💼 Трудоустройство / Карьера») -> переход в `q5_phone`
     - `q5_phone` -> `opt_phone_finish` («📱 Отправить заявку») -> переход в `__contact__`
  4. На шаге `__contact__` отправлен телефон `+998901234567` (`update_id = 920011`).
  5. Живой сервер выполнил `prisma.lead.upsert()` и сохранил заявку `Lead` (`id: 55b69942-f5f6-40d5-a19f-ed9ebfda3709`) со всеми 5 ответами в PostgreSQL.

### Шаг Г — Параллельный диалог двух клиентов (`700002002` и `700002003`) + невалидный телефон + идемпотентность
- **Параллельные сессии**:
  - Клиент 2 (`tgId = 700002002`, `first_name: "Мадина"`, язык `RU`, `attemptId: 50ca5bfb-45b4-422d-b8c3-0dea040b6dd2`) шла по ветке: `opt_lang` -> `opt_middle` -> `opt_morning` -> `opt_hobby` -> `opt_phone_finish`.
  - Клиент 3 (`tgId = 700002003`, `first_name: "Сардор"`, язык `UZ`, `attemptId: 833906ce-3d20-456f-bd0d-f18045d178e6`) одновременно шёл по узбекской ветке: `opt_math` -> `opt_beginner` -> `opt_evening` -> `opt_job` -> `opt_phone_finish`.
  - На каждом из 5 шагов проверены дампы Redis `sess:b3462648-55a6-42d1-baac-f855448652d6:700002002` и `sess:b3462648-55a6-42d1-baac-f855448652d6:700002003` (`sessionsIsolated: true`, ответы и языки не смешались).
- **Невалидный телефон**:
  - Клиент 2 на шаге `__contact__` отправила текст `"не телефон"` (`update_id = 920026`).
  - `parseAndNormalizePhone("не телефон")` вернул `isValid: false`; проверено в PostgreSQL: `leadInDbAfterInvalidInput = null` (заявка не создана, сессия осталась на шаге `__contact__`).
- **Завершение валидным телефоном**:
  - Клиент 2 отправила `+998907776655` (`update_id = 920027`), Клиент 3 отправил `+998903334455` (`update_id = 920028`).
  - Обе заявки созданы живым сервером в PostgreSQL (`50ca5bfb-45b4-422d-b8c3-0dea040b6dd2` и `833906ce-3d20-456f-bd0d-f18045d178e6`).
- **Идемпотентность (`duplicate: true`)**:
  - Повторная отправка `update_id = 920027` вернула `HTTP 200 {"ok":true,"duplicate":true}`.
  - Количество заявок Бота 1 в БД до и после повтора: `3` -> `3` (дубль не создан как на уровне `WebhookInbox` unique constraint `(botId, updateId)`, так и на уровне `prisma.lead.upsert({ where: { id: attemptId } })`).

### Шаг Д — Кабинет админа в боте (`tgId = 700001001`)
- Проверены вызовы от админа `700001001`:
  - `/start` (`update_id = 920029`)
  - Reply-кнопка админ-меню `"📋 Заявки/Записи"` (`update_id = 920030`) — вызывает `fetchRecentEntriesText(prisma, ctx.botMeta, lang)` и формирует список из 3 созданных заявок:
    ```text
    Последние заявки/записи (до 20):

    1. [19.10.2026] Сардор | +998903334455
    2. [19.10.2026] Мадина | +998907776655
    3. [19.10.2026] Азиз | +998901234567
    ```
  - Inline-кнопка `admin:leads` (`update_id = 920031`) и неиспользуемый legacy callback `adm:leads:0` (`update_id = 920032`).

---

## 3. Честный технический нюанс: поведение живого сервера (`USE_MOCK_TELEGRAM=false`) с синтетическими `tgId`

При тестировании через живой HTTP-шлюз работающего сервера (`USE_MOCK_TELEGRAM=false`) с фейковыми `tgId` (`700001001`, `700001099`, `700002001`..`700002003`) зафиксирована точная цепочка работы всех слоёв:

1. **Исходящие вызовы в реальный `api.telegram.org`**:
   - Поскольку `USE_MOCK_TELEGRAM=false`, `RealTelegramTransport` не перехватывает запросы, и любой вызов `ctx.api.sendMessage(chatId, ...)` или `ctx.answerCallbackQuery()` отправляет реальный HTTPS-запрос в `https://api.telegram.org/bot<TOKEN>/...`.
   - Для несуществующих в Telegram чатов `700002001`..`700002003` Telegram Bot API возвращает `400: Bad Request: chat not found` (а для синтетического `callback_query.id` в `answerCallbackQuery` — `400: Bad Request: query is too old...`).
2. **Влияние на PostgreSQL (`BotUser` и `Lead`)**:
   - В обработчиках `/start` (`upsertBotUser`), `set_lang:RU|UZ` (`setUserLanguage`) и приёма контакта (`handleLeadCatchContact` -> `prisma.lead.upsert`) запись в PostgreSQL выполняется **ДО** финального вызова `await ctx.api.sendMessage(...)`!
   - Кроме того, в `handleLeadCatchContact` отправка уведомлений админам (`await notifyAdmins(...)`) обёрнута в собственный `try / catch`, поэтому ошибка `400: chat not found` при отправке пуша админу `700001001` перехватывается и логируется, не прерывая сохранение лида.
   - В результате записи `BotUser` (включая `isAdmin: true/false` и `lang: "RU"|"UZ"`) и `Lead` (со всеми ответами квиза и нормализованным телефоном) **на 100% сохраняются живым сервером в PostgreSQL**.
3. **Влияние на Redis FSM (`grammY` `session()` middleware)**:
   - В `grammY` (`convenience/session.js`, функция `strictSingleSession`) код устроен так:
     ```js
     await propSession.init(key, { custom, lazy: false });
     await next(); // no catch: do not write back if middleware throws
     await propSession.finish();
     ```
   - Когда финальный `await ctx.api.sendMessage(...)` внутри хендлера выбрасывает `GrammyError (400: chat not found)`, исключение прерывает `await next()`, и `grammY` намеренно **не вызывает `await propSession.finish()`** (то есть не сбрасывает изменённый в памяти `ctx.session` обратно в Redis). Кроме того, в `navigation-handlers.ts` (`set_lang` и `enter`) вызов `await displayMenu(...)` стоит перед `await opts.onClientStart?.(ctx)`, поэтому при падении `displayMenu` с 400 автозапуск `startLeadCatchQuiz` не достигается.
   - При этом чтение из Redis (`await propSession.init(key)`) в начале каждого апдейта работает штатно: когда состояние шага находится в `sess:<botId>:<tgId>`, живой сервер считывает его из Redis, валидирует `attemptTag` и `callbackId`, а на шаге `__contact__` валидирует телефон и сам сохраняет `Lead` в PostgreSQL.
4. **Влияние на `WebhookInbox` и дедупликацию**:
   - Так как `bot.handleUpdate` пробрасывает `GrammyError` в `WebhookInboxService.processItem`, запись в `webhook_inbox` переходит в `status: "RECEIVED"`, `attempts: 1`, `lastError: "GrammyError in middleware: Call to 'sendMessage' failed! (400: Bad Request: chat not found)"` (и фоновый воркер `recoverPending` повторяет её до `maxAttempts = 3`, после чего ставит `status: "FAILED"`).
   - При этом дедупликация повторных `update_id` работает безотказно: `inboxService.enqueue()` ловит `P2002` (unique constraint на `(botId, updateId)`) и возвращает `DUPLICATE`, а HTTP-шлюз отвечает `200 {"ok":true,"duplicate":true}`. А благодаря детерминированному первичному ключу `lead.id = quizAttemptId(ctx)` и `prisma.lead.upsert`, даже повторные попытки воркера `recoverPending` не создают дубликатов лидов.
5. **Нюанс в `admin:leads` (`apps/server/src/bots/shared/handlers.ts`)**:
   - В `leadcatch/index.ts` и `navigation-handlers.ts` вызов `await ctx.answerCallbackQuery().catch(() => {})` защищён `.catch(() => {})`, тогда как в `shared/handlers.ts` (строка 47, `bot.callbackQuery("admin:leads")`) написано `await ctx.answerCallbackQuery();` без `.catch()`. Поэтому при синтетическом `callback_query.id` выполнение `admin:leads` прерывается на `answerCallbackQuery`, тогда как текстовая кнопка Reply-клавиатуры админа `"📋 Заявки/Записи"` (`bot.hears(...)`) не вызывает `answerCallbackQuery` и успешно выполняет `fetchRecentEntriesText` из БД.
