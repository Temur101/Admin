import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { QuickBookConfigSchema, QuizConfigSchema } from "@lcqb/contracts";
import { bookingSetupIssues } from "@lcqb/contracts/validation";
import { authenticateAdmin } from "./auth.js";
import { validateQuizDag } from "../bots/leadcatch/dag-validator.js";
import type { TenantResolver } from "../gateway/tenant-resolver.js";
import { TEMPLATES_CATALOG } from "./templates-catalog.js";

export { TEMPLATES_CATALOG, type BotTemplateMeta } from "./templates-catalog.js";

interface BotParams {
  id: string;
}

interface ApplyTemplateBody {
  templateId: string;
}

export function registerTemplatesRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  tenantResolver?: TenantResolver,
): void {
  // GET /api/v1/templates - Catalog of ready presets
  app.get("/api/v1/templates", { preHandler: [authenticateAdmin] }, async (_req, reply) => {
    return reply.send({
      ok: true,
      templates: TEMPLATES_CATALOG.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        botType: t.botType,
      })),
    });
  });

  // POST /api/v1/bots/:id/apply-template - Apply a ready preset
  app.post<{ Params: BotParams; Body: ApplyTemplateBody }>(
    "/api/v1/bots/:id/apply-template",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const { templateId } = req.body ?? {};

      const template = TEMPLATES_CATALOG.find((t) => t.id === templateId);
      if (!template) {
        return reply.code(404).send({ ok: false, error: "Template not found" });
      }

      const bot = await prisma.bot.findUnique({ where: { id } });
      if (!bot) {
        return reply.code(404).send({ ok: false, error: "Bot not found" });
      }

      if (bot.botType !== template.botType) {
        return reply.code(400).send({
          ok: false,
          error: `Template type '${template.botType}' is not compatible with bot type '${bot.botType}'`,
        });
      }

      const updated = await prisma.bot.update({
        where: { id },
        data: { settings: template.config },
      });

      tenantResolver?.invalidate(bot.botTokenHash, bot.id);

      return reply.send({
        ok: true,
        message: `Template '${template.name}' applied successfully`,
        settings: updated.settings,
      });
    },
  );

  // PUT /api/v1/bots/:id/settings - Custom configuration update with DAG / Schema validation
  app.put<{ Params: BotParams }>(
    "/api/v1/bots/:id/settings",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const bot = await prisma.bot.findUnique({ where: { id } });
      if (!bot) {
        return reply.code(404).send({ ok: false, error: "Bot not found" });
      }

      if (bot.botType === "LEADCATCH") {
        const parsed = QuizConfigSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({
            ok: false,
            error: "Invalid LeadCatch Quiz configuration schema",
            issues: parsed.error.issues,
          });
        }

        const dagResult = validateQuizDag(parsed.data);
        if (!dagResult.valid) {
          return reply.code(400).send({
            ok: false,
            error: "Quiz DAG validation failed",
            details: dagResult.errors,
          });
        }

        const updated = await prisma.bot.update({
          where: { id },
          data: { settings: parsed.data },
        });

        tenantResolver?.invalidate(bot.botTokenHash, bot.id);
        return reply.send({ ok: true, settings: updated.settings });
      }

      if (bot.botType === "QUICKBOOK") {
        const errors = bookingSetupIssues(req.body);
        if (errors.length)
          return reply
            .code(400)
            .send({ ok: false, error: "Проверьте услуги и расписание.", details: errors });

        const parsed = QuickBookConfigSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({
            ok: false,
            error: "Invalid QuickBook configuration schema",
            issues: parsed.error.issues,
          });
        }

        const updated = await prisma.bot.update({
          where: { id },
          data: { settings: parsed.data },
        });

        tenantResolver?.invalidate(bot.botTokenHash, bot.id);
        return reply.send({ ok: true, settings: updated.settings });
      }

      return reply.code(400).send({ ok: false, error: "Unknown bot type" });
    },
  );
}
