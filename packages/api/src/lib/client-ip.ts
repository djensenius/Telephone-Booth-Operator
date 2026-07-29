// Client address resolution shared by session creation and the audit log.
//
// Trust model: `X-Forwarded-For` is attacker-controlled unless the API sits
// behind a proxy we own, so it is only consulted when `TRUSTED_PROXIES` is
// configured. Otherwise we fall back to the TCP peer address reported by the
// Node adapter, which cannot be spoofed by the client.

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

const csv = (input: string | undefined): string[] =>
  (input ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

export const trustsForwardedHeaders = (): boolean => csv(process.env.TRUSTED_PROXIES).length > 0;

// `::ffff:203.0.113.7` is an IPv4-mapped IPv6 address; store the plain IPv4
// form so audit rows and session rows are comparable across transports.
const normalize = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return mapped?.[1] ?? trimmed;
};

export const forwardedClientIp = (headers: Headers): string | null => {
  if (!trustsForwardedHeaders()) return null;
  return normalize(headers.get("x-forwarded-for")?.split(",")[0]);
};

// The Node adapter only exposes connection info for requests it served. Unit
// tests drive `app.request(...)` directly, where there is no socket at all.
const peerAddress = (c: Context): string | null => {
  try {
    return normalize(getConnInfo(c).remote.address);
  } catch {
    return null;
  }
};

export const clientIp = (c: Context): string | null =>
  forwardedClientIp(c.req.raw.headers) ?? peerAddress(c);
