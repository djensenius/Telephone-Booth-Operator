import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forwardedClientIp, isTrustedPeer, matchesProxyRule } from "../src/lib/client-ip.js";

const xff = (value: string): Headers => new Headers({ "x-forwarded-for": value });

describe("matchesProxyRule", () => {
  it("matches a bare IPv4 address exactly", () => {
    expect(matchesProxyRule("10.0.0.1", "10.0.0.1")).toBe(true);
    expect(matchesProxyRule("10.0.0.2", "10.0.0.1")).toBe(false);
  });

  it("matches an IPv4 CIDR on its documented 32-bit width", () => {
    expect(matchesProxyRule("10.4.2.1", "10.0.0.0/8")).toBe(true);
    expect(matchesProxyRule("11.4.2.1", "10.0.0.0/8")).toBe(false);
    expect(matchesProxyRule("192.168.1.9", "192.168.1.0/24")).toBe(true);
    expect(matchesProxyRule("192.168.2.9", "192.168.1.0/24")).toBe(false);
  });

  it("treats an IPv4-mapped peer as the IPv4 address it is", () => {
    expect(matchesProxyRule("::ffff:10.4.2.1", "10.0.0.0/8")).toBe(true);
  });

  it("matches IPv6 exactly and by prefix", () => {
    expect(matchesProxyRule("2001:db8::1", "2001:db8::1")).toBe(true);
    expect(matchesProxyRule("2001:db8::dead", "2001:db8::/32")).toBe(true);
    expect(matchesProxyRule("2001:dba::dead", "2001:db8::/32")).toBe(false);
  });

  it("rejects nonsense rather than throwing", () => {
    expect(matchesProxyRule("10.0.0.1", "not-an-address")).toBe(false);
    expect(matchesProxyRule("999.0.0.1", "10.0.0.0/8")).toBe(false);
    expect(matchesProxyRule("10.0.0.1", "10.0.0.0/64")).toBe(false);
    // `::` stands for at least one omitted group, so a full eight groups
    // alongside it is malformed and must not parse as a real address.
    expect(matchesProxyRule("2001:db8:0:0:0:0:0:1::", "2001:db8::/32")).toBe(false);
    expect(matchesProxyRule("2001:db8::1", "2001:db8:0:0:0:0:0:1::/32")).toBe(false);
  });

  // docs/azure-deployment.md ships TRUSTED_PROXIES=azure-container-apps.
  it("expands the azure-container-apps shorthand to the private ranges", () => {
    expect(matchesProxyRule("100.100.4.7", "azure-container-apps")).toBe(true);
    expect(matchesProxyRule("10.0.0.4", "azure-container-apps")).toBe(true);
    expect(matchesProxyRule("::1", "azure-container-apps")).toBe(true);
    expect(matchesProxyRule("203.0.113.7", "azure-container-apps")).toBe(false);
  });
});

describe("isTrustedPeer", () => {
  const original = process.env.TRUSTED_PROXIES;

  beforeEach(() => {
    process.env.TRUSTED_PROXIES = "10.0.0.0/8, 192.168.1.5";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = original;
  });

  it("trusts a peer matching any configured rule", () => {
    expect(isTrustedPeer("10.9.9.9")).toBe(true);
    expect(isTrustedPeer("192.168.1.5")).toBe(true);
  });

  it("trusts nothing when nothing is configured", () => {
    delete process.env.TRUSTED_PROXIES;
    expect(isTrustedPeer("10.9.9.9")).toBe(false);
  });

  it("does not trust an unknown peer or a missing one", () => {
    expect(isTrustedPeer("203.0.113.7")).toBe(false);
    expect(isTrustedPeer(null)).toBe(false);
  });
});

describe("forwardedClientIp", () => {
  const original = process.env.TRUSTED_PROXIES;

  beforeEach(() => {
    process.env.TRUSTED_PROXIES = "10.0.0.0/8";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = original;
  });

  it("takes the rightmost entry that is not a configured proxy", () => {
    expect(forwardedClientIp(xff("203.0.113.7, 10.0.0.1"))).toBe("203.0.113.7");
  });

  // nginx's $proxy_add_x_forwarded_for appends to whatever the caller sent, so
  // the leftmost entry is attacker-controlled and must not win.
  it("ignores a forged prefix appended to by the proxy", () => {
    expect(forwardedClientIp(xff("198.51.100.9, 203.0.113.7"))).toBe("203.0.113.7");
  });

  it("skips further proxy hops on the way left", () => {
    expect(forwardedClientIp(xff("203.0.113.7, 10.1.1.1, 10.0.0.1"))).toBe("203.0.113.7");
  });

  it("normalizes an IPv4-mapped entry", () => {
    expect(forwardedClientIp(xff("::ffff:203.0.113.7, 10.0.0.1"))).toBe("203.0.113.7");
  });

  it("skips garbage entries", () => {
    expect(forwardedClientIp(xff("203.0.113.7, unknown, 10.0.0.1"))).toBe("203.0.113.7");
  });

  it("returns null when the chain is empty or entirely trusted", () => {
    expect(forwardedClientIp(new Headers())).toBeNull();
    expect(forwardedClientIp(xff("10.1.1.1, 10.0.0.1"))).toBeNull();
  });
});
