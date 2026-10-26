import { z } from "zod";

export const BotTypeSchema = z.enum(["LEADCATCH", "QUICKBOOK"]);
export type BotType = z.infer<typeof BotTypeSchema>;

export const SubscriptionStatusSchema = z.enum([
  "TRIAL",
  "ACTIVE",
  "EXPIRED",
  "GRACE_PERIOD",
  "BLOCKED",
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const LangSchema = z.enum(["RU", "UZ"]);
export type Lang = z.infer<typeof LangSchema>;

export const ReceiptKindSchema = z.enum(["PHOTO", "TEXT"]);
export type ReceiptKind = z.infer<typeof ReceiptKindSchema>;

export const ReceiptStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED"]);
export type ReceiptStatus = z.infer<typeof ReceiptStatusSchema>;

export const BookingStatusSchema = z.enum(["PENDING", "CONFIRMED", "CANCELLED", "COMPLETED"]);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

export const TariffOptionSchema = z.object({
  months: z.union([z.literal(1), z.literal(6), z.literal(12)]),
  amountUzs: z.number().int().positive(),
});
export type TariffOption = z.infer<typeof TariffOptionSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  timestamp: z.string().datetime(),
  uptime: z.number().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const TelegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
  })
  .passthrough();
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

export const WebhookResponseSchema = z.object({
  ok: z.boolean(),
  duplicate: z.boolean().optional(),
  error: z.string().optional(),
});
export type WebhookResponse = z.infer<typeof WebhookResponseSchema>;

export const LocalizedTextSchema = z.object({
  ru: z.string().min(1),
  uz: z.string().min(1),
});
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

export const QuizOptionSchema = z.object({
  id: z.string().min(1),
  text: LocalizedTextSchema,
  nextNodeId: z.string().min(1).nullable().optional(),
  inputType: z.enum(["CHOICE", "TEXT"]).optional(),
});
export type QuizOption = z.infer<typeof QuizOptionSchema>;

export const QUIZ_FREE_TEXT_MAX_LENGTH = 1000;
export const QuizFreeTextAnswerSchema = z.string().trim().min(1).max(QUIZ_FREE_TEXT_MAX_LENGTH);

export const QuizNodeSchema = z.object({
  id: z.string().min(1),
  title: LocalizedTextSchema,
  options: z.array(QuizOptionSchema).min(1),
});
export type QuizNode = z.infer<typeof QuizNodeSchema>;

export const QuizConfigSchema = z.object({
  startNodeId: z.string().min(1),
  nodes: z.array(QuizNodeSchema).min(1),
});
export type QuizConfig = z.infer<typeof QuizConfigSchema>;
export const QuizDraftConfigSchema = QuizConfigSchema.extend({
  startNodeId: z.string(),
  nodes: z.array(QuizNodeSchema),
});

export const QuizAnswerSchema = z.object({
  question: z.string(),
  answer: z.string(),
  optionId: z.string().optional(),
});
export type QuizAnswer = z.infer<typeof QuizAnswerSchema>;

export const ResourceTypeSchema = z.enum(["STAFF", "TABLE", "ROOM"]);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

export const QuickBookServiceSchema = z.object({
  id: z.string().min(1),
  name: LocalizedTextSchema,
  description: LocalizedTextSchema.optional(),
  durationMin: z.number().int().min(5).max(480),
  priceUzs: z.number().int().nonnegative(),
});
export type QuickBookService = z.infer<typeof QuickBookServiceSchema>;

export const TimeWindowSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});
export type TimeWindow = z.infer<typeof TimeWindowSchema>;

export const QuickBookResourceSchema = z.object({
  id: z.string().min(1),
  name: LocalizedTextSchema,
  serviceIds: z.array(z.string().min(1)).optional(),
  workDays: z.array(z.number().int().min(0).max(6)),
  workHours: TimeWindowSchema,
  breakHours: TimeWindowSchema.optional(),
});
export type QuickBookResource = z.infer<typeof QuickBookResourceSchema>;

export const QuickBookConfigSchema = z.object({
  resourceType: ResourceTypeSchema.default("STAFF"),
  resourceLabel: LocalizedTextSchema.optional(),
  services: z.array(QuickBookServiceSchema).min(1),
  resources: z.array(QuickBookResourceSchema).min(1),
  slotIntervalMin: z.number().int().min(5).max(120).default(30),
  bookingHorizonDays: z.number().int().min(1).max(60).default(14),
  timezone: z.string().default("Asia/Tashkent"),
  customTexts: z.record(LocalizedTextSchema).optional(),
});
export type QuickBookConfig = z.infer<typeof QuickBookConfigSchema>;
const DraftLocalizedTextSchema = z.object({ ru: z.string(), uz: z.string() });
export const QuickBookDraftConfigSchema = QuickBookConfigSchema.extend({
  services: z.array(QuickBookServiceSchema.extend({ name: DraftLocalizedTextSchema })),
  resources: z.array(QuickBookResourceSchema.extend({ name: DraftLocalizedTextSchema })),
});

export const BookingSourceSchema = z.enum(["TELEGRAM", "MANUAL"]);
export type BookingSource = z.infer<typeof BookingSourceSchema>;

export const AdminLoginRequestSchema = z.object({
  email: z.string().min(3),
  password: z.string().min(6),
});
export type AdminLoginRequest = z.infer<typeof AdminLoginRequestSchema>;

export const CreateTenantRequestSchema = z.object({
  clientName: z.string().min(1).max(255),
  contactPhone: z.string().min(5).max(50),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>;

export const CreateBotRequestSchema = z.object({
  tenantId: z.string().uuid(),
  botType: BotTypeSchema,
  botToken: z.string().min(10),
  templateId: z.string().min(1).optional(),
  startPaused: z.boolean().optional(),
  resourceType: ResourceTypeSchema.optional(),
});
export type CreateBotRequest = z.infer<typeof CreateBotRequestSchema>;

export const ManualBookingRequestSchema = z.object({
  serviceId: z.string().min(1),
  staffId: z.string().min(1),
  slotTime: z.string(),
  customerName: z.string().min(1),
  customerPhone: z.string().min(5),
});
export type ManualBookingRequest = z.infer<typeof ManualBookingRequestSchema>;

export const ExtendSubscriptionRequestSchema = z.object({
  days: z.number().int().min(1).max(3650).default(30),
});
export type ExtendSubscriptionRequest = z.infer<typeof ExtendSubscriptionRequestSchema>;

export const ReduceSubscriptionRequestSchema = z.object({
  days: z.number().int().min(1).max(3650),
});
export type ReduceSubscriptionRequest = z.infer<typeof ReduceSubscriptionRequestSchema>;

export const GrantTrialRequestSchema = z.object({
  days: z.number().int().min(1).max(365).default(7),
});
export type GrantTrialRequest = z.infer<typeof GrantTrialRequestSchema>;

export const RejectReceiptRequestSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type RejectReceiptRequest = z.infer<typeof RejectReceiptRequestSchema>;

export const UpdatePlatformSettingsRequestSchema = z.object({
  paymentDetails: z.string().optional(),
  tariffs: z
    .array(TariffOptionSchema)
    .length(3)
    .refine(
      (tariffs) => new Set(tariffs.map((tariff) => tariff.months)).size === 3,
      "Укажите по одному тарифу на 1, 6 и 12 месяцев.",
    )
    .optional(),
  supportContact: z.string().optional(),
  alertBotToken: z.string().optional(),
  alertChatId: z.union([z.number(), z.string()]).optional(),
  alertBotUsername: z.string().optional(),
  paymentInstructions: z.string().optional(),
  maintenanceMode: z.boolean().optional(),
});
export type UpdatePlatformSettingsRequest = z.infer<typeof UpdatePlatformSettingsRequestSchema>;

export const RESOURCE_LABELS: Record<ResourceType, LocalizedText> = {
  STAFF: { ru: "Сотрудник", uz: "Xodim" },
  TABLE: { ru: "Стол", uz: "Stol" },
  ROOM: { ru: "Помещение", uz: "Xona" },
};

// Empty configurations are onboarding drafts, not publishable booking/quiz settings.
export function createEmptyQuickBookConfig(resourceType: ResourceType = "STAFF"): QuickBookConfig {
  return {
    resourceType,
    resourceLabel: { ...RESOURCE_LABELS[resourceType] },
    services: [],
    resources: [],
    slotIntervalMin: 30,
    bookingHorizonDays: 14,
    timezone: "Asia/Tashkent",
  };
}

export function createEmptyQuizConfig(): QuizConfig {
  return { startNodeId: "", nodes: [] };
}
