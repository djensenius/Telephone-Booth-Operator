import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const themeCss = readFileSync(resolve(process.cwd(), "../web/src/styles/theme.css"), "utf8");
const lightThemeBlock = /:root\[data-theme="light"\]\s*\{([^}]*)\}/u.exec(themeCss)?.[1];
if (!lightThemeBlock) throw new Error("missing explicit light theme");

const colorVariable = (name: string): string => {
  const value = new RegExp(`--${name}:\\s*(#[\\da-f]{6});`, "iu").exec(lightThemeBlock)?.[1];
  if (!value) throw new Error(`missing light-theme color ${name}`);
  return value;
};

const relativeLuminance = (hex: string): number => {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

const contrastRatio = (foreground: string, background: string): number => {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
};

describe("web light thermal palette", () => {
  it("meets text and non-text contrast requirements", () => {
    const raisedSurface = colorVariable("surface-panel-raised");
    const chartSurface = colorVariable("surface-inset");

    expect(
      contrastRatio(colorVariable("thermal-online-color"), raisedSurface),
    ).toBeGreaterThanOrEqual(4.5);
    for (let index = 0; index < 6; index += 1) {
      expect(
        contrastRatio(colorVariable(`thermal-line-${index}`), chartSurface),
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps automatic and explicit light palettes synchronized", () => {
    for (const name of [
      "thermal-online-color",
      "thermal-line-0",
      "thermal-line-1",
      "thermal-line-2",
      "thermal-line-3",
      "thermal-line-4",
      "thermal-line-5",
    ]) {
      const value = colorVariable(name);
      expect(themeCss.match(new RegExp(`--${name}:\\s*${value}`, "giu"))).toHaveLength(2);
    }
  });

  it("wires thermal status and chart styles to the contrast-safe palette", () => {
    expect(themeCss).toContain("color: var(--thermal-online-color);");
    for (let index = 0; index < 6; index += 1) {
      expect(
        new RegExp(
          `\\.thermal-chart__line--${index}\\s*\\{[^}]*--thermal-line:\\s*var\\(--thermal-line-${index}\\);`,
          "u",
        ).test(themeCss),
      ).toBe(true);
    }
  });
});
