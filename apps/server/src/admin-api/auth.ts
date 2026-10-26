import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as argon2 from "argon2";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { AdminLoginRequestSchema } from "@lcqb/contracts";
import { env } from "../core/env.js";
import type { Logger } from "../core/logger.js";

const REFRESH_TTL_SEC = 7 * 24 * 3600;
const ACCESS_FALLBACK_TTL_SEC = 15 * 60;

const activeRedisByApp = new WeakMap<FastifyInstance, Redis>();

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
  jti?: string;
  exp?: number;
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
    const redis = activeRedisByApp.get(req.server);
    if (redis && user.jti) {
      const denied = await redis.exists(`auth:deny:access:${user.jti}`);
      if (denied === 1) {
        return reply.code(401).send({ ok: false, error: "Unauthorized" });
      }
    }
  } catch {
    return reply.code(401).send({ ok: false, error: "Unauthorized" });
  }
}

export function registerAuthRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  redis?: Redis,
): void {
  if (redis) {
    activeRedisByApp.set(app, redis);
  }

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

      const accessJti = randomUUID();
      const refreshJti = randomUUID();

      const accessTokenPayload: AdminJwtPayload = {
        adminId: admin.id,
        email: admin.email,
        tokenType: "access",
        jti: accessJti,
      };

      const refreshTokenPayload: AdminJwtPayload = {
        adminId: admin.id,
        email: admin.email,
        tokenType: "refresh",
        jti: refreshJti,
      };

      const accessToken = app.jwt.sign(accessTokenPayload, {
        key: env.JWT_ACCESS_SECRET,
        expiresIn: env.JWT_ACCESS_TTL,
      });
      const refreshToken = app.jwt.sign(refreshTokenPayload, {
        key: env.JWT_REFRESH_SECRET,
        expiresIn: env.JWT_REFRESH_TTL,
      });

      if (redis) {
        await redis.set(`auth:refresh:${admin.id}:${refreshJti}`, "1", "EX", REFRESH_TTL_SEC);
      }

      reply.setCookie("refreshToken", refreshToken, {
        httpOnly: true,
        secure: env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: REFRESH_TTL_SEC,
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

      if (redis && decoded.jti) {
        const exists = await redis.exists(`auth:refresh:${decoded.adminId}:${decoded.jti}`);
        if (exists !== 1) {
          return reply.code(401).send({ ok: false, error: "Invalid refresh token" });
        }
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
        jti: randomUUID(),
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
  app.post("/api/v1/auth/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    if (redis) {
      const rawRefresh = req.cookies.refreshToken;
      if (rawRefresh) {
        try {
          const decoded = app.jwt.verify<AdminJwtPayload>(rawRefresh, {
            key: env.JWT_REFRESH_SECRET,
          });
          if (decoded?.tokenType === "refresh" && decoded.jti) {
            await redis.del(`auth:refresh:${decoded.adminId}:${decoded.jti}`);
          }
        } catch {
          // Ignore invalid or expired refresh token on logout
        }
      }

      const authHeader = req.headers.authorization;
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        const rawAccess = authHeader.slice(7).trim();
        try {
          const decodedAccess = app.jwt.verify<AdminJwtPayload>(rawAccess, {
            key: env.JWT_ACCESS_SECRET,
          });
          if (decodedAccess?.tokenType === "access" && decodedAccess.jti) {
            const nowSec = Math.floor(Date.now() / 1000);
            const ttlSec = decodedAccess.exp
              ? Math.max(1, decodedAccess.exp - nowSec)
              : ACCESS_FALLBACK_TTL_SEC;
            await redis.set(`auth:deny:access:${decodedAccess.jti}`, "1", "EX", ttlSec);
          }
        } catch {
          // Ignore invalid or expired access token on logout
        }
      }
    }

    reply.clearCookie("refreshToken", { path: "/" });
    return reply.code(200).send({ ok: true });
  });
}
