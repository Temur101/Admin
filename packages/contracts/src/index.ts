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

export const BookingStatusSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "CANCELLED",
  "COMPLETED",
]);
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
});
export type QuizOption = z.infer<typeof QuizOptionSchema>;

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

