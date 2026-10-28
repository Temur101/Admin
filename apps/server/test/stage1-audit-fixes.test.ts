import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GrammyError } from "grammy";
import {
  connectRedis,
  encryptSecret,
  sha256Hex,
  MockTelegramTransport,
  BotPool,
  notifyAdmins,
  logger,
  type Redis,
  type ResolvedBot,
} from "../src/index.js";
import { env } from "../src/core/env.js";
import {
  can,
  createBotAdminInvite,
  revokeBotAdminRights,
} from "../src/bots/shared/permissions.js";
import {
  classifyTelegramError,
  handleBotTelegramError,
} from "../src/bots/shared/telegram-errors.js";
import { DEFAULT_LEADCATCH_QUIZ } from "../src/bots/leadcatch/default-quiz.js";
import { callbackId } from "../src/bots/shared/callback-id.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();
let redis: Redis;

function lastMsgTo(transport: MockTelegramTransport, chatId: number) {
  const calls = transport
    .callsOf("sendMessage")
    .filter((c) => Number(c.payload.chat_id) === chatId);
  return calls.at(-1)?.payload;
}

function inlineButtons(transport: MockTelegramTransport, chatId: number) {
  const markup = lastMsgTo(transport, chatId)?.reply_markup as
    | { inline_keyboard?: { text: string; callback_data?: string }[][] }
    | undefined;
  return markup?.inline_keyboard?.flat() ?? [];
}

describe("Stage 1 Audit Fixes: Roles, Invites, Error Classification, Quiz UX & Lead Assignment", () => {
  let transport: MockTelegramTransport;
  let botPool: BotPool;
  let botId: string;
  let resolvedBot: ResolvedBot;

  const BOT_TOKEN = "777888999:Stage1AuditFixesBotToken";
  const OWNER_TG_ID = 1001001;
  const STAFF_TG_ID = 1001002;
  const STAFF2_TG_ID = 1001003;
  const CLIENT_TG_ID = 2002001;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-stage1-audit");
    await connectRedis(redis);
    transport = new MockTelegramTransport();
  });

  afterAll(async () => {
    if (redis && redis.status !== "end") {
      await redis.quit();
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    transport.clear();
    await safeCleanTestRedis(redis);
    await safeCleanTestDb(prisma);

    const tenant = await prisma.tenant.create({
      data: { clientName: "Stage 1 Tenant", contactPhone: "+998901234567" },
    });

    const quiz = structuredClone(DEFAULT_LEADCATCH_QUIZ);
    // Add alternate 3-step branch: q1_service -> q2_alt -> q3_budget to test branch cleanup on Back
    quiz.nodes.push({
      id: "q2_alt",
      title: { ru: "Какой формат предпочитаете?", uz: "Qaysi formatni afzal ko'rasiz?" },
      options: [
        {
          id: "opt_online",
          text: { ru: "Онлайн", uz: "Onlayn" },
          nextNodeId: "q3_budget",
        },
      ],
    });
    quiz.nodes[0]!.options.push({
      id: "opt_alt_branch",
      text: { ru: "Другая ветка", uz: "Boshqa yo'налиш" },
      nextNodeId: "q2_alt",
    });

    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "LEADCATCH",
        botTokenEnc: encryptSecret(BOT_TOKEN, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: sha256Hex(BOT_TOKEN),
        webhookSecret: "stage1_secret",
        botUsername: "stage1_test_bot",
        settings: quiz,
        subscription: {
          create: {
            status: "ACTIVE",
            trialEndsAt: new Date(Date.now() + 86400000 * 7),
            paidUntil: new Date(Date.now() + 86400000 * 30),
          },
        },
      },
      include: { subscription: true },
    });
    botId = bot.id;

    resolvedBot = {
      id: bot.id,
      tenantId: bot.tenantId,
      botType: bot.botType,
      botTokenEnc: bot.botTokenEnc,
      botTokenHash: bot.botTokenHash,
      webhookSecret: bot.webhookSecret,
      botUsername: "stage1_test_bot",
      settings: quiz,
      subscriptionStatus: "ACTIVE",
      trialEndsAt: bot.subscription!.trialEndsAt.toISOString(),
      paidUntil: bot.subscription!.paidUntil!.toISOString(),
    };

    botPool = new BotPool({
      capacity: 20,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      transport,
      redis,
      sessionTtlSec: 3600,
      logger,
      prisma,
    });
  });

  it("1.1 Roles, single-use 24h invites, revocation & OWNER receivesLeads toggle", async () => {
    expect(can({ isAdmin: true, role: "OWNER" }, "PAY_SUBSCRIPTION")).toBe(true);
    expect(can({ isAdmin: true, role: "OWNER" }, "TOGGLE_RECEIVES_LEADS")).toBe(true);
    expect(can({ isAdmin: true, role: "STAFF" }, "PAY_SUBSCRIPTION")).toBe(false);
    expect(can({ isAdmin: true, role: "STAFF" }, "TOGGLE_RECEIVES_LEADS")).toBe(false);
    expect(can({ isAdmin: true, role: "STAFF" }, "VIEW_LEADS")).toBe(true);
    expect(can({ isAdmin: true, role: "STAFF" }, "TAKE_LEAD")).toBe(true);
    expect(can({ isAdmin: false, role: "OWNER" }, "VIEW_LEADS")).toBe(false);

    const bot = botPool.getOrCreateBot(resolvedBot);

    const { rawCode, invite } = await createBotAdminInvite(prisma, {
      botId,
      role: "STAFF",
    });
    expect(invite.role).toBe("STAFF");

    // First user uses the invite -> becomes STAFF admin
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1700000000,
        chat: { id: STAFF_TG_ID, type: "private", first_name: "StaffOne" },
        from: { id: STAFF_TG_ID, is_bot: false, first_name: "StaffOne" },
        text: `/start adm_${rawCode}`,
      },
    });

    const staffInDb = await prisma.botUser.findUnique({
      where: { botId_tgId: { botId, tgId: BigInt(STAFF_TG_ID) } },
    });
    expect(staffInDb?.isAdmin).toBe(true);
    expect(staffInDb?.role).toBe("STAFF");

    // Second user tries the SAME single-use invite -> rejected!
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: 1700000000,
        chat: { id: STAFF2_TG_ID, type: "private", first_name: "Intruder" },
        from: { id: STAFF2_TG_ID, is_bot: false, first_name: "Intruder" },
        text: `/start adm_${rawCode}`,
      },
    });

    const intruderInDb = await prisma.botUser.findUnique({
      where: { botId_tgId: { botId, tgId: BigInt(STAFF2_TG_ID) } },
    });
    expect(intruderInDb?.isAdmin).toBe(false);

    // STAFF tries to access payment callback -> forbidden alert
    transport.clear();
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb_staff_pay",
        from: { id: STAFF_TG_ID, is_bot: false, first_name: "StaffOne" },
        chat_instance: "ci_1",
        data: "admin:pay",
      },
    });
    const payAlert = transport
      .callsOf("answerCallbackQuery")
      .find((c) => c.payload.callback_query_id === "cb_staff_pay");
    expect(payAlert?.payload.show_alert).toBe(true);

    // Revoke STAFF_TG_ID -> clears Redis session, sets isAdmin=false, revokes invites
    await redis.set(`sess:${botId}:${STAFF_TG_ID}`, JSON.stringify({ lang: "RU" }));
    await revokeBotAdminRights(prisma, {
      botId,
      tgId: BigInt(STAFF_TG_ID),
      redis,
    });
    expect(await redis.get(`sess:${botId}:${STAFF_TG_ID}`)).toBeNull();

    // Revoked admin cannot re-use old link
    await bot.handleUpdate({
      update_id: 4,
      message: {
        message_id: 4,
        date: 1700000000,
        chat: { id: STAFF_TG_ID, type: "private", first_name: "StaffOne" },
        from: { id: STAFF_TG_ID, is_bot: false, first_name: "StaffOne" },
        text: `/start adm_${rawCode}`,
      },
    });
    const afterRejoinAttempt = await prisma.botUser.findUnique({
      where: { botId_tgId: { botId, tgId: BigInt(STAFF_TG_ID) } },
    });
    expect(afterRejoinAttempt?.isAdmin).toBe(false);

    // Create OWNER and test receivesLeads toggle
    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(OWNER_TG_ID),
        firstName: "OwnerBoss",
        isAdmin: true,
        role: "OWNER",
        receivesLeads: true,
        lang: "RU",
      },
    });

    await bot.handleUpdate({
      update_id: 5,
      callback_query: {
        id: "cb_toggle_leads",
        from: { id: OWNER_TG_ID, is_bot: false, first_name: "OwnerBoss" },
        chat_instance: "ci_owner",
        data: "admin:toggle_leads",
      },
    });

    const ownerUpdated = await prisma.botUser.findUnique({
      where: { botId_tgId: { botId, tgId: BigInt(OWNER_TG_ID) } },
    });
    expect(ownerUpdated?.receivesLeads).toBe(false);

    // When receivesLeads is false, notifyAdmins skips OWNER for LEAD notifications
    transport.clear();
    const sentCount = await notifyAdmins(
      botId,
      {
        kind: "LEAD",
        name: "Client",
        phone: "+998901234567",
        username: null,
        answers: { Q1: "A1" },
      },
      { prisma, transport, logger },
    );
    expect(sentCount).toBe(0);
  });

  it("1.2 Telegram error classification & handling (401 INVALID_TOKEN, 403 BLOCKED_BY_USER, 429 RATE_LIMITED)", async () => {
    const err401 = new GrammyError(
      "Call to 'getUpdates' failed! (401: Unauthorized)",
      { ok: false, error_code: 401, description: "Unauthorized" },
      "getUpdates",
      {},
    );
    const c401 = classifyTelegramError(err401);
    expect(c401.kind).toBe("INVALID_TOKEN");
    expect(c401.retryable).toBe(false);
    expect(c401.statusCode).toBe(401);

    await handleBotTelegramError({ prisma, botId, classified: c401, logger, transport });
    const botAfter401 = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
    expect(botAfter401.healthStatus).toBe("NEEDS_ATTENTION");
    expect(botAfter401.lastErrorCode).toBe("INVALID_TOKEN");

    // 403 Blocked by user -> marks user unreachableAt
    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(CLIENT_TG_ID),
        firstName: "Blocker",
        isAdmin: false,
        lang: "RU",
      },
    });
    const err403 = new GrammyError(
      "Forbidden: bot was blocked by the user",
      { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
      "sendMessage",
      {},
    );
    const c403 = classifyTelegramError(err403);
    expect(c403.kind).toBe("BLOCKED_BY_USER");
    expect(c403.retryable).toBe(false);

    await handleBotTelegramError({
      prisma,
      botId,
      recipientTgId: BigInt(CLIENT_TG_ID),
      classified: c403,
      logger,
      transport,
    });
    const userAfter403 = await prisma.botUser.findUniqueOrThrow({
      where: { botId_tgId: { botId, tgId: BigInt(CLIENT_TG_ID) } },
    });
    expect(userAfter403.unreachableAt).not.toBeNull();

    // When user writes to the bot again, unreachableAt is cleared automatically
    const bot = botPool.getOrCreateBot(resolvedBot);
    await bot.handleUpdate({
      update_id: 20,
      message: {
        message_id: 20,
        date: 1700000000,
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Blocker" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Blocker" },
        text: "/start",
      },
    });
    const userAfterReturn = await prisma.botUser.findUniqueOrThrow({
      where: { botId_tgId: { botId, tgId: BigInt(CLIENT_TG_ID) } },
    });
    expect(userAfterReturn.unreachableAt).toBeNull();

    // 429 Rate Limited
    const err429 = new GrammyError(
      "Too Many Requests: retry after 9",
      {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 9",
        parameters: { retry_after: 9 },
      },
      "sendMessage",
      {},
    );
    const c429 = classifyTelegramError(err429);
    expect(c429.kind).toBe("RATE_LIMITED");
    expect(c429.retryAfterMs).toBe(9000);
    expect(c429.retryable).toBe(true);
  });

  it("1.3 Quiz UX: Back navigation with branch cleanup, unexpected input, contact ownership & summary edit", async () => {
    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(CLIENT_TG_ID),
        firstName: "Азиз",
        isAdmin: false,
        lang: "RU",
      },
    });

    const bot = botPool.getOrCreateBot(resolvedBot);

    // 1. Start quiz -> Q1
    await bot.handleUpdate({
      update_id: 30,
      message: {
        message_id: 30,
        date: 1700000000,
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Азиз" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Азиз" },
        text: "/start",
      },
    });
    expect(String(lastMsgTo(transport, CLIENT_TG_ID)?.text)).toContain("Какая услуга вас интересует?");

    // 2. Unexpected text when inline button is expected -> keeps step and replies with hint
    await bot.handleUpdate({
      update_id: 31,
      message: {
        message_id: 31,
        date: 1700000000,
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Азиз" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Азиз" },
        text: "Просто какой-то текст вместо кнопки",
      },
    });
    expect(String(lastMsgTo(transport, CLIENT_TG_ID)?.text)).toContain(
      "Выберите вариант с помощью кнопок",
    );

    const q1Markup = transport
      .callsOf("sendMessage")
      .find((c) => String(c.payload.text).includes("Какая услуга вас интересует?"))
      ?.payload.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] };
    const q1Btn = q1Markup.inline_keyboard
      .flat()
      .find((b) =>
        b.callback_data?.endsWith(`:${callbackId("q1_service")}:${callbackId("opt_consult")}`),
      )!;

    // 3. Answer Q1 -> opt_consult -> moves to Q2 (q2_time)
    await bot.handleUpdate({
      update_id: 32,
      callback_query: {
        id: "cb_q1",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Азиз" },
        chat_instance: "ci_q",
        data: q1Btn.callback_data!,
      },
    });
    expect(String(lastMsgTo(transport, CLIENT_TG_ID)?.text)).toContain(
      "Когда вам удобно обсудить детали?",
    );

    // 4. Answer Q2 -> opt_morning -> moves to Q3 (q3_budget)
    const q2Btn = inlineButtons(transport, CLIENT_TG_ID).find((b) =>
      b.callback_data?.endsWith(`:${callbackId("q2_time")}:${callbackId("opt_morning")}`),
    )!;
    await bot.handleUpdate({
      update_id: 33,
      callback_query: {
        id: "cb_q2",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Азиз" },
        chat_instance: "ci_q",
        data: q2Btn.callback_data!,
      },
    });
    expect(String(lastMsgTo(transport, CLIENT_TG_ID)?.text)).toContain(
      "Укажите ориентировочный бюджет:",
    );

    // 5. Click Back twice (Q3 -> Q2 -> Q1) and choose the alternate branch (opt_direct_q3 -> skips Q2!)
    const backFromQ3 = inlineButtons(transport, CLIENT_TG_ID).find((b) =>
      b.callback_data?.startsWith("lc:prev:"),
    )!;
    await bot.handleUpdate({
      update_id: 34,
      callback_query: {
        id: "cb_back_1",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Азиз" },
        chat_instance: "ci_q",
        data: backFromQ3.callback_data!,
      },
    });
    expect(String(lastMsgTo(transport, CLIENT_TG_ID)?.text)).toContain(
      "Когда вам удобно обсудить детали?",
    );

    const backFromQ2 = inlineButtons(transport, CLIENT_TG_ID).find((b) =>
      b.callback_data?.startsWith("lc:prev:"),
    )!;
    await bot.handleUpdate({
      update_id: 35,
      callback_query: {
        id: "cb_back_2",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Азиз" },
        chat_instance: "ci_q",
        data: backFromQ2.callback_data!,
      },
    });
    expect(String(lastMsgTo(transport, CLIENT_TG_ID)?.text)).toContain("Какая услуга вас интересует?");

    // Choose opt_alt_branch on Q1 -> goes to q2_alt, and q2_time's old answer MUST be cleaned up!
    const altBranchBtn = inlineButtons(transport, CLIENT_TG_ID).find((b) =>
      b.callback_data?.endsWith(`:${callbackId("q1_service")}:${callbackId("opt_alt_branch")}`),
    )!;
    await bot.handleUpdate({
      update_id: 36,
      callback_query: {
        id: "cb_q1_alt",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Азиз" },
        chat_instance: "ci_q",
        data: altBranchBtn.callback_data!,
      },
    });
    const sessAfterBranchChange = JSON.parse(
      (await redis.get(`sess:${botId}:${CLIENT_TG_ID}`)) ?? "{}",
    );
    expect(sessAfterBranchChange.quiz.answers.q2_time).toBeUndefined();
    expect(String(lastMsgTo(transport, CLIENT_TG_ID)?.text)).toContain("Какой формат предпочитаете?");

    // Answer q2_alt -> moves to q3_budget
    const q2AltBtn = inlineButtons(transport, CLIENT_TG_ID).find((b) =>
      b.callback_data?.endsWith(`:${callbackId("q2_alt")}:${callbackId("opt_online")}`),
    )!;
    await bot.handleUpdate({
      update_id: 365,
      callback_query: {
        id: "cb_q2_alt",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Азиз" },
        chat_instance: "ci_q",
        data: q2AltBtn.callback_data!,
      },
    });

    // Answer Q3 -> moves to __contact__
    const q3Btn = inlineButtons(transport, CLIENT_TG_ID).find((b) =>
      b.callback_data?.endsWith(`:${callbackId("q3_budget")}:${callbackId("opt_budget_base")}`),
    )!;
    await bot.handleUpdate({
      update_id: 37,
      callback_query: {
        id: "cb_q3",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Азиз" },
        chat_instance: "ci_q",
        data: q3Btn.callback_data!,
      },
    });
    expect(String(lastMsgTo(transport, CLIENT_TG_ID)?.text)).toContain("номер телефона");

    // 6. Foreign contact (user_id !== CLIENT_TG_ID) -> rejected!
    await bot.handleUpdate({
      update_id: 38,
      message: {
        message_id: 38,
        date: 1700000000,
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Азиз" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Азиз" },
        contact: {
          phone_number: "+998909998877",
          first_name: "Чужой",
          user_id: 999999999,
        },
      },
    });
    expect(String(lastMsgTo(transport, CLIENT_TG_ID)?.text)).toContain("собственный контакт");

    // 7. Own contact (user_id === CLIENT_TG_ID) -> accepted -> moves to __summary__
    await bot.handleUpdate({
      update_id: 39,
      message: {
        message_id: 39,
        date: 1700000000,
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Азиз" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Азиз" },
        contact: {
          phone_number: "+998901234567",
          first_name: "Азиз",
          user_id: CLIENT_TG_ID,
        },
      },
    });
    const summaryText = String(lastMsgTo(transport, CLIENT_TG_ID)?.text);
    expect(summaryText).toContain("Проверьте данные вашей заявки");
    expect(summaryText).toContain("Другая ветка");
    expect(summaryText).toContain("Онлайн");
    expect(summaryText).not.toContain("В первой половине дня");

    // Confirm summary -> Lead saved with phoneVerified: true and without q2_time
    const confirmBtn = inlineButtons(transport, CLIENT_TG_ID).find((b) =>
      b.callback_data?.startsWith("lc:confirm:"),
    )!;
    await bot.handleUpdate({
      update_id: 40,
      callback_query: {
        id: "cb_confirm",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Азиз" },
        chat_instance: "ci_q",
        data: confirmBtn.callback_data!,
      },
    });

    const savedLead = await prisma.lead.findFirstOrThrow({ where: { botId } });
    expect(savedLead.phoneVerified).toBe(true);
    expect(savedLead.answers).not.toHaveProperty("q2_time");
  });

  it("1.4 Lead assignment: atomic race between two admins & status workflow permissions", async () => {
    await prisma.botUser.createMany({
      data: [
        {
          botId,
          tgId: BigInt(OWNER_TG_ID),
          firstName: "Owner",
          isAdmin: true,
          role: "OWNER",
          lang: "RU",
        },
        {
          botId,
          tgId: BigInt(STAFF_TG_ID),
          firstName: "Staff 1",
          isAdmin: true,
          role: "STAFF",
          lang: "RU",
        },
        {
          botId,
          tgId: BigInt(STAFF2_TG_ID),
          firstName: "Staff 2",
          isAdmin: true,
          role: "STAFF",
          lang: "RU",
        },
      ],
    });

    const lead = await prisma.lead.create({
      data: {
        botId,
        customerTgId: BigInt(CLIENT_TG_ID),
        customerName: "Клиент Гонка",
        phoneRaw: "+998901112233",
        phoneVerified: true,
        answers: {},
      },
    });

    const bot = botPool.getOrCreateBot(resolvedBot);

    // Two STAFF admins concurrently click "Взять в работу" (`lead:take:<id>`)
    await Promise.all([
      bot.handleUpdate({
        update_id: 50,
        callback_query: {
          id: "cb_take_1",
          from: { id: STAFF_TG_ID, is_bot: false, first_name: "Staff 1" },
          chat_instance: "ci_race_1",
          data: `lead:take:${lead.id}`,
        },
      }),
      bot.handleUpdate({
        update_id: 51,
        callback_query: {
          id: "cb_take_2",
          from: { id: STAFF2_TG_ID, is_bot: false, first_name: "Staff 2" },
          chat_instance: "ci_race_2",
          data: `lead:take:${lead.id}`,
        },
      }),
    ]);

    const claimedLead = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(claimedLead.status).toBe("IN_PROGRESS");
    expect([BigInt(STAFF_TG_ID), BigInt(STAFF2_TG_ID)]).toContain(claimedLead.assigneeTgId);

    // Exactly one callback answer showed alert (the loser got "lead_already_taken" with show_alert: true)
    const takeAnswers = transport
      .callsOf("answerCallbackQuery")
      .filter(
        (c) =>
          c.payload.callback_query_id === "cb_take_1" ||
          c.payload.callback_query_id === "cb_take_2",
      );
    expect(takeAnswers).toHaveLength(2);
    expect(takeAnswers.filter((a) => a.payload.show_alert === true)).toHaveLength(1);

    const winnerId = Number(claimedLead.assigneeTgId);
    const loserId = winnerId === STAFF_TG_ID ? STAFF2_TG_ID : STAFF_TG_ID;

    // Loser STAFF cannot change status of a lead assigned to winner
    await bot.handleUpdate({
      update_id: 52,
      callback_query: {
        id: "cb_loser_done",
        from: { id: loserId, is_bot: false, first_name: "Loser" },
        chat_instance: "ci_loser",
        data: `lead:status:${lead.id}:DONE`,
      },
    });
    const loserAnswer = transport
      .callsOf("answerCallbackQuery")
      .find((c) => c.payload.callback_query_id === "cb_loser_done");
    expect(loserAnswer?.payload.show_alert).toBe(true);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
      "IN_PROGRESS",
    );

    // Winner STAFF can mark lead as DONE
    await bot.handleUpdate({
      update_id: 53,
      callback_query: {
        id: "cb_winner_done",
        from: { id: winnerId, is_bot: false, first_name: "Winner" },
        chat_instance: "ci_winner",
        data: `lead:status:${lead.id}:DONE`,
      },
    });
    const updatedLead = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updatedLead.status).toBe("DONE");
    expect(updatedLead.assigneeTgId).toBe(BigInt(winnerId));
  });
});
