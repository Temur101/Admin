import argon2 from "argon2";
import { config } from "dotenv";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

// Ensure root .env is loaded
config({ path: resolve(process.cwd(), "../../.env") });
config({ path: resolve(process.cwd(), ".env") });

const prisma = new PrismaClient();

async function main() {
  const superadminEmail = process.env.SUPERADMIN_EMAIL ?? "admin@example.com";
  const superadminPassword = process.env.SUPERADMIN_PASSWORD ?? "changeme123456";
  const paymentDetails =
    process.env.PAYMENT_DETAILS ?? "Карта: 8600 0000 0000 0000\nПолучатель: Админ";
  const supportContact = process.env.SUPPORT_CONTACT ?? "@support";

  // eslint-disable-next-line no-console
  console.log(`🌱 Seeding superadmin: ${superadminEmail}...`);

  const passwordHash = await argon2.hash(superadminPassword);

  await prisma.admin.upsert({
    where: { email: superadminEmail },
    update: { passwordHash },
    create: {
      email: superadminEmail,
      passwordHash,
    },
  });

  // eslint-disable-next-line no-console
  console.log("🌱 Seeding platform settings and tariffs...");

  const defaultTariffs = [
    { months: 1, amountUzs: Number(process.env.TARIFF_1M_UZS ?? 100000) },
    { months: 6, amountUzs: Number(process.env.TARIFF_6M_UZS ?? 500000) },
    { months: 12, amountUzs: Number(process.env.TARIFF_12M_UZS ?? 1000000) },
  ];

  await prisma.platformSettings.upsert({
    where: { id: 1 },
    update: {
      paymentDetails,
      supportContact,
      tariffs: defaultTariffs,
    },
    create: {
      id: 1,
      paymentDetails,
      supportContact,
      tariffs: defaultTariffs,
    },
  });

  // eslint-disable-next-line no-console
  console.log("✅ Seed completed successfully!");
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
