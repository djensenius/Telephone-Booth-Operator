// Client address resolution shared by session creation and the audit log.
//
// Trust model: `X-Forwarded-For` is attacker-controlled, so it is only
// consulted when the request actually arrived *from* one of the reverse
// proxies named in `TRUSTED_PROXIES`. A client that can reach the API
// directly therefore cannot forge the actor IP recorded on sessions and audit
// rows. With no trusted proxies configured the header is ignored entirely and
// we use the TCP peer address the Node adapter reports.

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

const csv = (input: string | undefined): string[] =>
  (input ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

export const trustedProxies = (): string[] => csv(process.env.TRUSTED_PROXIES);

// `::ffff:203.0.113.7` is an IPv4-mapped IPv6 address; store the plain IPv4
// form so audit rows and session rows are comparable across transports.
const normalize = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return mapped?.[1] ?? trimmed;
};

// Big-endian byte form of an IPv4 or IPv6 literal, or null if it is neither.
// IPv4 is widened to its IPv4-mapped IPv6 form so a v4 peer matches a v4 rule
// however the socket happened to report it.
const toBytes = (address: string): Uint8Array | null => {
  const plain = normalize(address);
  if (!plain) return null;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(plain);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    const bytes = new Uint8Array(16);
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    bytes.set(octets, 12);
    return bytes;
  }

  // Strip a zone id (`fe80::1%eth0`), which is not part of the address.
  const literal = plain.split("%")[0] ?? "";
  if (!/^[0-9a-f:]+$/i.test(literal)) return null;
  const [head, tail, ...rest] = literal.split("::");
  if (rest.length > 0) return null;
  const parse = (group: string | undefined): number[] | null => {
    if (!group) return [];
    const parts: number[] = [];
    for (const piece of group.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      const word = Number.parseInt(piece, 16);
      parts.push(word >> 8, word & 0xff);
    }
    return parts;
  };
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  if (!left || !right) return null;
  if (tail === undefined && left.length !== 16) return null;
  if (left.length + right.length > 16) return null;

  const bytes = new Uint8Array(16);
  bytes.set(left, 0);
  bytes.set(right, 16 - right.length);
  return bytes;
};

// Whether `address` falls inside `rule`, which is either a bare address (exact
// match) or CIDR notation.
export const matchesProxyRule = (address: string, rule: string): boolean => {
  const [network, prefix] = rule.split("/");
  const ruleBytes = toBytes(network ?? "");
  const addressBytes = toBytes(address);
  if (!ruleBytes || !addressBytes) return false;

  if (prefix === undefined) {
    return ruleBytes.every((byte, index) => byte === addressBytes[index]);
  }

  const width = Number(prefix);
  if (!Number.isInteger(width) || width < 0) return false;
  // A v4 rule's prefix is written against 32 bits but compared in the
  // IPv4-mapped space, which puts those bits last in the 128.
  const isV4Rule = network?.includes(".") ?? false;
  if (isV4Rule && width > 32) return false;
  if (!isV4Rule && width > 128) return false;
  const bits = isV4Rule ? width + 96 : width;

  const fullBytes = bits >> 3;
  for (let index = 0; index < fullBytes; index += 1) {
    if (ruleBytes[index] !== addressBytes[index]) return false;
  }
  const remainder = bits & 7;
  if (remainder === 0) return true;
  const mask = 0xff << (8 - remainder);
  return ((ruleBytes[fullBytes] ?? 0) & mask) === ((addressBytes[fullBytes] ?? 0) & mask);
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

// Whether the request came from a configured reverse proxy, and so whether its
// forwarding headers may be believed.
export const isTrustedPeer = (peer: string | null): boolean => {
  if (!peer) return false;
  return trustedProxies().some((rule) => matchesProxyRule(peer, rule));
};

export const forwardedClientIp = (headers: Headers): string | null =>
  normalize(headers.get("x-forwarded-for")?.split(",")[0]);

export const clientIp = (c: Context): string | null => {
  const peer = peerAddress(c);
  if (!isTrustedPeer(peer)) return peer;
  return forwardedClientIp(c.req.raw.headers) ?? peer;
};
