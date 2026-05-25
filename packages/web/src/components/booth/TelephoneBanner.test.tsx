import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { TelephoneBanner } from "./TelephoneBanner.js";

describe("TelephoneBanner", () => {
  it("renders the console brand", () => {
    render(<TelephoneBanner />);
    expect(screen.getByText("Telephone Booth")).toBeDefined();
    expect(screen.getByText("Operator console")).toBeDefined();
  });
});
