import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BoothStatusProvider } from "./BoothStatusContext.js";
import { Handset } from "./Handset.js";

function renderHandset(onAnswer: () => void): void {
  render(
    <BoothStatusProvider>
      <div
        data-handset-cradle="true"
        ref={(element) => {
          if (element !== null) {
            element.getBoundingClientRect = () => ({
              x: 0,
              y: 0,
              left: 0,
              top: 0,
              right: 120,
              bottom: 120,
              width: 120,
              height: 120,
              toJSON: () => ({}),
            });
          }
        }}
      />
      <Handset onAnswer={onAnswer} />
    </BoothStatusProvider>,
  );
}

describe("Handset", () => {
  beforeEach(() => {
    Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("dragging into the cradle triggers navigation", () => {
    const onAnswer = vi.fn();
    renderHandset(onAnswer);
    fireEvent.dragEnd(screen.getByRole("button", { name: "Answer the phone" }), { clientX: 60, clientY: 60 });
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("pressing Enter triggers the same navigation", () => {
    const onAnswer = vi.fn();
    renderHandset(onAnswer);
    fireEvent.keyDown(screen.getByRole("button", { name: "Answer the phone" }), { key: "Enter" });
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });
});
