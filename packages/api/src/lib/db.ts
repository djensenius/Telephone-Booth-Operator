import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

const createClient = (): PrismaClient => {
  const connectionString = process.env["DATABASE_URL"];

  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
  }

  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  /**
   * In local development, TSX/Vite-style hot reload can re-evaluate modules while
   * the Node process keeps running. Keeping the client on `globalThis` lets reloads
   * reuse the same connection pool instead of leaking a new pool per reload.
   */
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
  }

  return client;
};

let client: PrismaClient | undefined;

const getClient = (): PrismaClient => {
  client ??= globalForPrisma.prisma ?? createClient();
  return client;
};

/**
 * Shared Prisma client instance.
 *
 * Prisma 7 requires a driver adapter, so the connection string has to be read
 * when the client is constructed rather than when it first connects. Building
 * it behind this proxy keeps importing the module free of side effects, so
 * modules that only reach `db` transitively — and tests that stub it out — do
 * not need DATABASE_URL to be set.
 */
export const db = new Proxy({} as PrismaClient, {
  get: (_target, property) => {
    const instance = getClient();
    const value: unknown = Reflect.get(instance, property, instance);

    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(instance)
      : value;
  },
});
