import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTestPrismaClient, safeCleanTestDb } from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

describe("Database Integration & Schema Constraints", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await safeCleanTestDb(prisma);
  });

  it("1. should enforce unique constraint on botTokenHash", async () => {
    const tenant = await prisma.tenant.create({
      data: {
        clientName: "Test Client",
        contactPhone: "+998901234567",
      },
    });

    await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "LEADCATCH",
        botTokenEnc: "enc_token_1",
        botTokenHash: "duplicate_hash_test_123",
        webhookSecret: "secret_1",
        adminInviteCode: "code_1",
      },
    });

    await expect(
      prisma.bot.create({
        data: {
          tenantId: tenant.id,
          botType: "LEADCATCH",
          botTokenEnc: "enc_token_2",
          botTokenHash: "duplicate_hash_test_123",
          webhookSecret: "secret_2",
          adminInviteCode: "code_2",
        },
      }),
    ).rejects.toThrow();
  });

  it("2. should enforce partial unique index on Booking to prevent double booking", async () => {
    const tenant = await prisma.tenant.create({
      data: {
        clientName: "Barbershop Client",
        contactPhone: "+998901112233",
      },
    });

    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        botTokenEnc: "enc_token",
        botTokenHash: "quickbook_hash_test",
        webhookSecret: "secret",
        adminInviteCode: "invite_code_qb",
      },
    });

    const slotTime = new Date("2026-10-10T10:00:00Z");

    // First booking is PENDING
    await prisma.booking.create({
      data: {
        botId: bot.id,
        customerTgId: BigInt(111111),
        customerName: "Client A",
        customerPhone: "+998901234567",
        serviceId: "haircut",
        serviceName: "Мужская стрижка",
        staffId: "barber_1",
        durationMin: 45,
        slotTime,
        status: "PENDING",
      },
    });

    // Attempting a second active booking for the SAME staff and slotTime must be rejected by partial index
    await expect(
      prisma.booking.create({
        data: {
          botId: bot.id,
          customerTgId: BigInt(222222),
          customerName: "Client B",
          customerPhone: "+998907654321",
          serviceId: "haircut",
          serviceName: "Мужская стрижка",
          staffId: "barber_1",
          durationMin: 45,
          slotTime,
          status: "CONFIRMED",
        },
      }),
    ).rejects.toThrow();

    // A cancelled booking for the same slot is allowed (not part of the partial index)
    const cancelledBooking = await prisma.booking.create({
      data: {
        botId: bot.id,
        customerTgId: BigInt(333333),
        customerName: "Client C",
        customerPhone: "+998909998877",
        serviceId: "haircut",
        serviceName: "Мужская стрижка",
        staffId: "barber_1",
        durationMin: 45,
        slotTime,
        status: "CANCELLED",
      },
    });

    expect(cancelledBooking.id).toBeDefined();
    expect(cancelledBooking.status).toBe("CANCELLED");
  });

  it("3. should cascade delete bots, users, leads and bookings when tenant is deleted", async () => {
    const tenant = await prisma.tenant.create({
      data: {
        clientName: "Client With Data",
        contactPhone: "+998909990000",
      },
    });

    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "LEADCATCH",
        botTokenEnc: "enc_token_cascade",
        botTokenHash: "cascade_hash_test",
        webhookSecret: "secret_cascade",
        adminInviteCode: "cascade_invite",
      },
    });

    const user = await prisma.botUser.create({
      data: {
        botId: bot.id,
        tgId: BigInt(99887766),
        firstName: "Test User",
        isAdmin: true,
      },
    });

    const lead = await prisma.lead.create({
      data: {
        botId: bot.id,
        customerTgId: BigInt(554433),
        customerName: "Lead Name",
        phoneRaw: "+998901234567",
        answers: { question1: "answer1" },
      },
    });

    const booking = await prisma.booking.create({
      data: {
        botId: bot.id,
        customerTgId: BigInt(554433),
        customerPhone: "+998901234567",
        serviceId: "srv_1",
        serviceName: "Service 1",
        staffId: "staff_1",
        durationMin: 30,
        slotTime: new Date("2026-10-15T14:00:00Z"),
      },
    });

    // Delete the tenant
    await prisma.tenant.delete({
      where: { id: tenant.id },
    });

    // Check that everything was cascade deleted
    const foundBot = await prisma.bot.findUnique({ where: { id: bot.id } });
    const foundUser = await prisma.botUser.findUnique({ where: { id: user.id } });
    const foundLead = await prisma.lead.findUnique({ where: { id: lead.id } });
    const foundBooking = await prisma.booking.findUnique({ where: { id: booking.id } });

    expect(foundBot).toBeNull();
    expect(foundUser).toBeNull();
    expect(foundLead).toBeNull();
    expect(foundBooking).toBeNull();
  });
});
