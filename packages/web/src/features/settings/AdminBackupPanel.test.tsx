import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { exportMock, importMock } = vi.hoisted(() => ({
  exportMock: vi.fn(),
  importMock: vi.fn(),
}));

vi.mock("../../lib/api-client.js", () => ({
  adminData: { export: exportMock, import: importMock },
}));

const { AdminBackupPanel } = await import("./AdminBackupPanel.js");

beforeEach(() => {
  exportMock.mockReset();
  importMock.mockReset();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:x"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdminBackupPanel", () => {
  it("downloads a backup on successful export", async () => {
    exportMock.mockResolvedValue({ blob: new Blob(["x"]), filename: "backup.tar" });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<AdminBackupPanel />);
    fireEvent.click(screen.getByText("Export all data"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("backup.tar"));
    expect(exportMock).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("surfaces an error when export fails", async () => {
    exportMock.mockRejectedValue(new Error("boom"));
    render(<AdminBackupPanel />);
    fireEvent.click(screen.getByText("Export all data"));
    await waitFor(() => {
      const status = screen.getByRole("status");
      expect(status.textContent).toContain("boom");
      expect(status.className).toContain("settings-status--error");
    });
  });

  it("restores an archive on successful import", async () => {
    importMock.mockResolvedValue({
      rows: { question: 2, message: 3 },
      blobsUploaded: 4,
      blobsSkipped: 1,
    });
    const { container } = render(<AdminBackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["tar"], "restore.tar", { type: "application/x-tar" })] },
    });
    await waitFor(() => {
      const text = screen.getByRole("status").textContent ?? "";
      expect(text).toContain("Restored 5 rows");
      expect(text).toContain("4 audio");
    });
    expect(importMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces an error when import fails", async () => {
    importMock.mockRejectedValue(new Error("bad archive"));
    const { container } = render(<AdminBackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["tar"], "restore.tar", { type: "application/x-tar" })] },
    });
    await waitFor(() => {
      const status = screen.getByRole("status");
      expect(status.textContent).toContain("bad archive");
      expect(status.className).toContain("settings-status--error");
    });
  });
});
