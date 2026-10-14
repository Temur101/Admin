import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as argon2 from "argon2";
import type { PrismaClient } from "@prisma/client";
import { AdminLoginRequestSchema } from "@lcqb/contracts";
import { env } from "../core/env.js";
import type { Logger } from "../core/logger.js";

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export async function ensureSuperAdmin(prisma: PrismaClient, logger?: Logger): Promise<void> {
  const existing = await prisma.admin.findUnique({
    where: { email: env.SUPERADMIN_EMAIL },
  });

  if (!existing) {
    const passwordHash = await hashPassword(env.SUPERADMIN_PASSWORD);
    await prisma.admin.create({
      data: {
        email: env.SUPERADMIN_EMAIL,
        passwordHash,
      },
    });
    logger?.info({ email: env.SUPERADMIN_EMAIL }, "Seeded initial superadmin account");
  }
}

export interface AdminJwtPayload {
  adminId: string;
  email: string;
  tokenType: "access" | "refresh";
}

export async function authenticateAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await req.jwtVerify();
    const user = req.user as AdminJwtPayload | undefined;
    if (!user || user.tokenType !== "access") {
      return reply.code(401).send({ ok: false, error: "Unauthorized" });
    }
  } catch {
    return reply.code(401).send({ ok: false, error: "Unauthorized" });
  }
}

export function registerAuthRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
): void {
  // Login with rate limiting
  app.post(
    "/api/v1/auth/login",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "15 minutes",
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = AdminLoginRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: "Invalid credentials format" });
      }

      const { email, password } = parsed.data;
      const admin = await prisma.admin.findUnique({
        where: { email },
      });

      if (!admin) {
        return reply.code(401).send({ ok: false, error: "Invalid email or password" });
      }

      const isValid = await verifyPassword(admin.passwordHash, password);
      if (!isValid) {
        return reply.code(401).send({ ok: false, error: "Invalid email or password" });
      }

      const accessTokenPayload: AdminJwtPayload = {
        adminId: admin.id,
        email: admin.email,
        tokenType: "access",
      };

      const refreshTokenPayload: AdminJwtPayload = {
        adminId: admin.id,
        email: admin.email,
        tokenType: "refresh",
      };

      const accessToken = app.jwt.sign(accessTokenPayload, {
        key: env.JWT_ACCESS_SECRET,
        expiresIn: env.JWT_ACCESS_TTL,
      });
      const refreshToken = app.jwt.sign(refreshTokenPayload, {
        key: env.JWT_REFRESH_SECRET,
        expiresIn: env.JWT_REFRESH_TTL,
      });

      reply.setCookie("refreshToken", refreshToken, {
        httpOnly: true,
        secure: env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: 7 * 24 * 3600,
      });

      return reply.code(200).send({
        ok: true,
        accessToken,
        admin: {
          id: admin.id,
          email: admin.email,
        },
      });
    },
  );

  // Refresh token
  app.post("/api/v1/auth/refresh", async (req: FastifyRequest, reply: FastifyReply) => {
    const rawToken = req.cookies.refreshToken;
    if (!rawToken) {
      return reply.code(401).send({ ok: false, error: "Missing refresh token" });
    }

    try {
      const decoded = app.jwt.verify<AdminJwtPayload>(rawToken, {
        key: env.JWT_REFRESH_SECRET,
      });

      if (!decoded || decoded.tokenType !== "refresh") {
        return reply.code(401).send({ ok: false, error: "Invalid refresh token" });
      }

      const admin = await prisma.admin.findUnique({
        where: { id: decoded.adminId },
      });

      if (!admin) {
        return reply.code(401).send({ ok: false, error: "Admin not found" });
      }

      const tokenPayload: AdminJwtPayload = {
        adminId: admin.id,
        email: admin.email,
        tokenType: "access",
      };

      const newAccessToken = app.jwt.sign(tokenPayload, {
        key: env.JWT_ACCESS_SECRET,
        expiresIn: env.JWT_ACCESS_TTL,
      });
      return reply.code(200).send({
        ok: true,
        accessToken: newAccessToken,
      });
    } catch {
      return reply.code(401).send({ ok: false, error: "Invalid refresh token" });
    }
  });

  // Current user info
  app.get(
    "/api/v1/auth/me",
    { preHandler: [authenticateAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = req.user as AdminJwtPayload | undefined;
      if (!user) {
        return reply.code(401).send({ ok: false, error: "Unauthorized" });
      }

      const admin = await prisma.admin.findUnique({
        where: { id: user.adminId },
        select: { id: true, email: true, createdAt: true },
      });

      if (!admin) {
        return reply.code(404).send({ ok: false, error: "Admin not found" });
      }

      return reply.code(200).send({ ok: true, admin });
    },
  );

  // Logout
  app.post("/api/v1/auth/logout", async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.clearCookie("refreshToken", { path: "/" });
    return reply.code(200).send({ ok: true });
  });
}
