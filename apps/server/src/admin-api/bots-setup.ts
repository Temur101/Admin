import type { FastifyInstance } from "fastify";
import type { Bot, PrismaClient } from "@prisma/client";
import { authenticateAdmin } from "./auth.js";
import { validateBotSetup } from "./bot-setup-validation.js";
import { activateBot, type ActivationOptions } from "./bot-activation.js";

type SetupBot = Bot & {
  tenant: { status: string };
  subscription: { status: string; trialEndsAt: Date; paidUntil: Date | null } | null;
};
async function inspectSetup(bot: SetupBot, options: ActivationOptions) {
  const errors = validateBotSetup(bot.botType, bot.settings);
  const configurationReady = errors.length === 0;
  if (bot.tenant.status !== "ACTIVE") errors.push("Обслуживание клиента приостановлено.");
  const sub = bot.subscription;
  if (
    !sub ||
    !["TRIAL", "ACTIVE"].includes(sub.status) ||
    (sub.status === "TRIAL" && sub.trialEndsAt.getTime() <= Date.now()) ||
    (sub.status === "ACTIVE" && sub.paidUntil && sub.paidUntil.getTime() <= Date.now())
  )
    errors.push("Для запуска нужна действующая подписка или пробный период.");
  let telegramReady = false;
  try {
    await options.getTelegramBot(bot).api.getMe();
    telegramReady = true;
  } catch {
    errors.push("Не удалось связаться с Telegram. Проверьте токен и подключение сервера.");
  }
  if (options.mode === "polling" && !options.pollingManager)
    errors.push("Обработчик Telegram не запущен на сервере.");
  if (options.mode === "webhook" && !options.publicBaseUrl)
    errors.push("Не настроен адрес сервера для Telegram.");
  return {
    configurationReady,
    telegramReady,
    canLaunch: errors.length === 0,
    errors,
    checkedAt: new Date().toISOString(),
  };
}
export function registerBotSetupRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  options: ActivationOptions,
) {
  app.get<{ Params: { id: string } }>(
    "/api/v1/bots/:id/setup-check",
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const bot = await prisma.bot.findUnique({
        where: { id: request.params.id },
        include: { tenant: { select: { status: true } }, subscription: true },
      });
      if (!bot) return reply.code(404).send({ ok: false, error: "Бот не найден." });
      return reply.send({ ok: true, check: await inspectSetup(bot, options) });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/bots/:id/launch",
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const bot = await prisma.bot.findUnique({
        where: { id: request.params.id },
        include: { tenant: { select: { status: true } }, subscription: true },
      });
      if (!bot) return reply.code(404).send({ ok: false, error: "Бот не найден." });
      // Recheck at launch; an earlier browser check is not an authorization to run.
      const check = await inspectSetup(bot, options);
      if (!check.canLaunch)
        return reply
          .code(409)
          .send({ ok: false, error: "Бот пока не готов к запуску.", details: check.errors });
      try {
        await activateBot(prisma, bot, options, true);
      } catch {
        return reply
          .code(502)
          .send({
            ok: false,
            error: "Не удалось включить бота. Проверьте диагностику и повторите запуск.",
          });
      }
      return reply.send({ ok: true, bot: { id: bot.id, isActive: true } });
    },
  );
}
