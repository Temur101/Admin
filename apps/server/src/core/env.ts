import { config } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

// Load .env from project root or current working directory
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DEFAULT_TIMEZONE: z.string().default("Asia/Tashkent"),
  PUBLIC_BASE_URL: z.string().optional().default(""),
  BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
  USE_MOCK_TELEGRAM: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
  ADMIN_ORIGIN: z.string().default("http://localhost:5173"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  TEST_DATABASE_URL: z.string().optional().default(""),

  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  TEST_REDIS_URL: z.string().optional().default(""),

  // Webhook gateway tuning (defaults sized for a 2 GB VPS)
  UPDATE_DEDUP_TTL_SEC: z.coerce.number().int().positive().default(900),
  BOT_RESOLVE_CACHE_TTL_SEC: z.coerce.number().int().positive().default(600),
  BOT_INFO_CACHE_TTL_SEC: z.coerce.number().int().positive().default(86400),
  BOT_INSTANCE_CACHE_SIZE: z.coerce.number().int().positive().default(200),
  SESSION_TTL_SEC: z.coerce.number().int().positive().default(3600),
  WEBHOOK_MAX_INFLIGHT: z.coerce.number().int().positive().default(500),

  TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(1, "TOKEN_ENCRYPTION_KEY is required")
    .refine((v) => Buffer.from(v, "base64").length === 32, {
      message: "TOKEN_ENCRYPTION_KEY must be base64 of exactly 32 bytes (AES-256)",
    }),
  JWT_ACCESS_SECRET: z.string().min(1, "JWT_ACCESS_SECRET is required"),
  JWT_REFRESH_SECRET: z.string().min(1, "JWT_REFRESH_SECRET is required"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),

  SUPERADMIN_EMAIL: z.string().min(1, "SUPERADMIN_EMAIL is required"),
  SUPERADMIN_PASSWORD: z.string().min(8, "SUPERADMIN_PASSWORD must be at least 8 chars"),

  PAYMENT_DETAILS: z.string().default(""),
  SUPPORT_CONTACT: z.string().default("@support"),
  TRIAL_DAYS_DEFAULT: z.coerce.number().int().positive().default(3),
  TARIFF_1M_UZS: z.coerce.number().int().positive().default(100000),
  TARIFF_6M_UZS: z.coerce.number().int().positive().default(500000),
  TARIFF_12M_UZS: z.coerce.number().int().positive().default(1000000),

  UPLOAD_DIR: z.string().default("./uploads"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(5),

  DEV_LEADCATCH_TOKEN: z.string().optional().default(""),
  DEV_QUICKBOOK_TOKEN: z.string().optional().default(""),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment variables:", JSON.stringify(parsed.error.format(), null, 2));
  throw new Error("Invalid environment configuration. Check your .env file.");
}

export const env = parsed.data;
export type Env = z.infer<typeof EnvSchema>;
