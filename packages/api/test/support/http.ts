import type { Context } from "hono";
import { setSessionCookie } from "../../src/lib/session.js";
import { seedSession } from "./fake-db.js";

export const phoneHeaders = { authorization: "Bearer test-token" };

export const operatorCookie = (): string => {
  const session = seedSession();
  const headers = new Headers();
  const context = {
    req: {
      url: "http://localhost/",
      header: (name: string) => (name.toLowerCase() === "host" ? "localhost" : undefined),
    },
    header: (name: string, value: string, options?: { append?: boolean }) => {
      if (options?.append) headers.append(name, value);
      else headers.set(name, value);
    },
  } as unknown as Context;

  setSessionCookie(context, session.id, session.expiresAt);
  const setCookie = headers.get("set-cookie");
  if (!setCookie) throw new Error("missing set-cookie");
  return setCookie.split(";")[0] ?? setCookie;
};
