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
