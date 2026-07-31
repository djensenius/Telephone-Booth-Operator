import { BusyBar } from "@busy-app/busy-lib";
import type { DisplayDrawParams } from "@busy-app/busy-lib";
import type { BusyBarMonitorConfig } from "./config.js";

export interface BusyBarDeviceClient {
  resolveDeviceId(): Promise<string | null>;
  draw(payload: DisplayDrawParams): Promise<void>;
  clear(applicationName: string): Promise<void>;
  playStockSound(applicationName: string, stockPath: string): Promise<void>;
}

export const createBusyBarDeviceClient = (
  config: Extract<BusyBarMonitorConfig, { enabled: true }>,
): BusyBarDeviceClient => {
  const bar = new BusyBar({ addr: config.apiUrl, token: config.token, timeout: 5_000 });
  return {
    resolveDeviceId(): Promise<string | null> {
      return Promise.resolve(config.deviceId);
    },
    async draw(payload: DisplayDrawParams): Promise<void> {
      await bar.DisplayDraw(payload);
    },
    async clear(applicationName: string): Promise<void> {
      await bar.DisplayClear({ application_name: applicationName });
    },
    async playStockSound(applicationName: string, stockPath: string): Promise<void> {
      await bar.AudioPlay({ application_name: applicationName, stock_path: stockPath });
    },
  };
};
