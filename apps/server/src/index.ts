import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { env, type Env } from "./core/env.js";

export type { Env };

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
    },
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: [env.ADMIN_ORIGIN],
    credentials: true,
  });

  app.get("/health", async () => {
    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });

  return app;
}

async function start() {
  const app = await buildApp();
  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info(`🚀 Server running on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  void start();
}
