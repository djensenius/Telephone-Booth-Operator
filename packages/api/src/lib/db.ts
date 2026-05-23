import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

/**
 * Shared Prisma client instance.
 *
 * In local development, TSX/Vite-style hot reload can re-evaluate modules while
 * the Node process keeps running. Keeping the client on `globalThis` lets reloads
 * reuse the same connection pool instead of leaking a new pool per reload.
 */
export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
