import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App.js";

describe("App shell", () => {
  it("renders the TELEPHONE banner", () => {
    render(<App />);
    expect(screen.getByText("TELEPHONE")).toBeDefined();
  });
});
