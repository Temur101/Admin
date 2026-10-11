import { PrismaClient } from "@prisma/client";
import { env } from "./env.js";

declare global {
  var __prismaClient: PrismaClient | undefined;
}

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  let url: string;
  if (process.env.NODE_ENV === "test") {
    url = databaseUrl ?? env.TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL is not configured in test environment. Refusing to connect.");
    }
    if (url === env.DATABASE_URL) {
      throw new Error("Safety check failed: Test database URL matches production/dev DATABASE_URL. Refusing to connect.");
    }
    if (!url.toLowerCase().includes("test")) {
      throw new Error("Safety check failed: Test database URL does not contain 'test'. Refusing to connect.");
    }
  } else {
    url = databaseUrl ?? env.DATABASE_URL;
  }


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
