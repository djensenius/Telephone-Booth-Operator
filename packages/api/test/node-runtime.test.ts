import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const pinned = read(".node-version").trim();

// Node2Shell (CVE-2026-111497) was fixed in the Node 24 line at 24.22.1.
// Keep deployment and developer environments on the same patched runtime.
describe("patched Node runtime", () => {
  it("requires the supported Node 24 security release or newer", () => {
    const [major, minor, patch] = pinned.split(".").map(Number);
    expect(major).toBe(24);
    expect(minor! > 22 || (minor === 22 && patch! >= 1)).toBe(true);
    const metadata: unknown = JSON.parse(read("package.json"));
    const config = z.object({ engines: z.object({ node: z.string() }) }).parse(metadata);
    expect(config.engines.node).toBe(`>=${pinned} <25`);
  });

  it("keeps mise and the development container aligned", () => {
    expect(read("mise.toml")).toContain(`node = "${pinned}"`);
    const metadata: unknown = JSON.parse(read(".devcontainer/devcontainer.json"));
    const config = z.object({ features: z.record(z.string(), z.unknown()) }).parse(metadata);
    const node = z
      .object({ version: z.string() })
      .parse(config.features["ghcr.io/devcontainers/features/node:1"]);
    expect(node.version).toBe(pinned);
  });

  it("excludes local credentials and dependencies from Docker build contexts", () => {
    const ignored = read(".dockerignore").split("\n");
    expect(ignored).toContain(".env");
    expect(ignored).toContain(".env.*");
    expect(ignored).toContain("**/node_modules");
    expect(ignored).toContain(".git");
  });

  it.each(["packages/api/Dockerfile", "packages/web/Dockerfile"])(
    "pins every Node image stage in %s",
    (path) => {
      const images = [...read(path).matchAll(/^FROM (node:\S+)/gm)].map((match) => match[1]);
      expect(images.length).toBeGreaterThan(0);
      expect(images.every((image) => image === `node:${pinned}-alpine`)).toBe(true);
    },
  );

  it.each([".github/workflows/ci.yml", ".github/workflows/openapi-sync.yml"])(
    "uses the pinned runtime in %s",
    (path) => {
      expect(read(path)).not.toMatch(/node-version:\s*24\b/);
      expect(read(path)).toContain('node-version-file: ".node-version"');
    },
  );
});
