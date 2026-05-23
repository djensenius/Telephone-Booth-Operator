import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BoothStatusProvider } from "./BoothStatusContext.js";
import { CeilingLamps } from "./CeilingLamps.js";

describe("CeilingLamps", () => {
  it("reflects booth status in its color class", () => {
    render(
      <BoothStatusProvider initialStatus="recording">
        <CeilingLamps />
      </BoothStatusProvider>,
    );
    expect(screen.getByRole("status").className).toContain("ceiling-lamps--recording");
  });
});
