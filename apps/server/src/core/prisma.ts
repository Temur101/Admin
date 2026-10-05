import { PrismaClient } from "@prisma/client";
import { env } from "./env.js";

declare global {
  var __prismaClient: PrismaClient | undefined;
}

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  const url = databaseUrl ?? env.DATABASE_URL;

  // Append connection_limit=10 if not present to respect 2GB VPS memory limit
  let connectionUrl = url;
  if (!connectionUrl.includes("connection_limit=")) {
    const separator = connectionUrl.includes("?") ? "&" : "?";
    connectionUrl = `${connectionUrl}${separator}connection_limit=10`;
  }

  return new PrismaClient({
    datasources: {
      db: {
        url: connectionUrl,
      },
    },
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma = global.__prismaClient ?? createPrismaClient();

if (env.NODE_ENV !== "production") {
  global.__prismaClient = prisma;
}
