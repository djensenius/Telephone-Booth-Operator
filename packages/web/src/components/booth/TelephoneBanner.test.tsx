import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TelephoneBanner } from "./TelephoneBanner.js";

describe("TelephoneBanner", () => {
  it("renders title and Bell hex logo", () => {
    render(<TelephoneBanner />);
    expect(screen.getByText("TELEPHONE")).toBeDefined();
    expect(screen.getByRole("img", { name: "Bell Canada hex logo" })).toBeDefined();
  });
});
