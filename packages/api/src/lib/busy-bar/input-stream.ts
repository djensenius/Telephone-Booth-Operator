import protobuf from "protobufjs";
import { WebSocket } from "ws";

export type BusyBarInputEvent =
  | { kind: "button"; button: "OK" | "BACK" | "START"; action: "PRESS" | "RELEASE" }
  | { kind: "encoder"; delta: number }
  | { kind: "switch" };

interface BusyBarInputStreamOptions {
  url: string;
  token: string;
  deviceId: string;
  onInput(event: BusyBarInputEvent): void;
  onStatus(connected: boolean): void;
  onError(error: Error): void;
}

const root = protobuf.Root.fromJSON({
  nested: {
    BSB_State: {
      nested: {
        State: {
          fields: {
            timestamp: { type: "fixed64", id: 1 },
            updates: { rule: "repeated", type: "StateUpdate", id: 2 },
          },
        },
        StateUpdate: {
          fields: {
            input: { type: "BSB_Input.InputEvent", id: 11 },
          },
        },
      },
    },
    BSB_Input: {
      nested: {
        Button: { values: { OK: 0, BACK: 1, START: 2 } },
        ButtonAction: { values: { PRESS: 0, RELEASE: 1 } },
        SwitchPosition: {
          values: { BUSY: 0, CUSTOM: 1, OFF: 2, APPS: 3, SETTINGS: 4 },
        },
        ButtonEvent: {
          fields: {
            button: { type: "Button", id: 1 },
            action: { type: "ButtonAction", id: 2 },
          },
        },
        SwitchEvent: {
          fields: {
            position: { type: "SwitchPosition", id: 1 },
          },
        },
        EncoderEvent: {
          fields: {
            delta: { type: "sint32", id: 1 },
          },
        },
        InputEvent: {
          oneofs: {
            event: { oneof: ["buttonEvent", "switchEvent", "encoderEvent"] },
          },
          fields: {
            buttonEvent: { type: "ButtonEvent", id: 1 },
            switchEvent: { type: "SwitchEvent", id: 2 },
            encoderEvent: { type: "EncoderEvent", id: 3 },
          },
        },
      },
    },
  },
});

const StateType = root.lookupType("BSB_State.State");

type DecodedState = {
  updates?: Array<{
    input?: {
      buttonEvent?: { button?: string; action?: string };
      encoderEvent?: { delta?: number };
      switchEvent?: object;
    };
  }>;
};

export const decodeBusyBarCloudFrame = (data: WebSocket.RawData): Uint8Array | null => {
  if (typeof data !== "string" && !Buffer.isBuffer(data)) return null;
  const text = typeof data === "string" ? data : data.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const frame = parsed as Record<string, unknown>;
  if (
    typeof frame.state !== "string" ||
    (frame.type !== undefined && frame.type !== "protobuf")
  ) {
    return null;
  }
  return Buffer.from(frame.state, "base64");
};

export const decodeBusyBarInputEvents = (bytes: Uint8Array): BusyBarInputEvent[] => {
  const message = StateType.decode(bytes);
  const decoded = StateType.toObject(message, {
    longs: Number,
    bytes: Uint8Array,
    enums: String,
    defaults: false,
  }) as DecodedState;
  const events: BusyBarInputEvent[] = [];
  for (const update of decoded.updates ?? []) {
    const input = update.input;
    const button = input?.buttonEvent;
    if (
      button?.button &&
      (button.button === "OK" || button.button === "BACK" || button.button === "START") &&
      (button.action === "PRESS" || button.action === "RELEASE")
    ) {
      events.push({ kind: "button", button: button.button, action: button.action });
      continue;
    }
    const delta = input?.encoderEvent?.delta;
    if (typeof delta === "number" && delta !== 0) {
      events.push({ kind: "encoder", delta });
      continue;
    }
    if (input?.switchEvent) events.push({ kind: "switch" });
  }
  return events;
};

export interface BusyBarInputStreamHandle {
  stop(): void;
}

export const startBusyBarInputStream = (
  options: BusyBarInputStreamOptions,
): BusyBarInputStreamHandle => {
  let socket: WebSocket | null = null;
  let retry: NodeJS.Timeout | null = null;
  let stopped = false;
  let attempt = 0;

  const reconnect = (): void => {
    if (stopped || retry) return;
    const delay = Math.min(30_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 250);
    attempt += 1;
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, delay);
    retry.unref();
  };

  const connect = (): void => {
    if (stopped) return;
    const current = new WebSocket(options.url);
    socket = current;
    current.on("open", () => {
      attempt = 0;
      options.onStatus(true);
      current.send(JSON.stringify({ token: options.token }));
      current.send(JSON.stringify({ subscribe: [options.deviceId] }));
    });
    current.on("message", (data) => {
      const bytes = decodeBusyBarCloudFrame(data);
      if (!bytes) return;
      try {
        for (const event of decodeBusyBarInputEvents(bytes)) options.onInput(event);
      } catch (error) {
        options.onError(
          error instanceof Error ? error : new Error("BUSY Bar input protobuf decode failed"),
        );
      }
    });
    current.on("error", (error) => {
      options.onError(error);
    });
    current.on("close", (code) => {
      if (socket !== current) return;
      socket = null;
      options.onStatus(false);
      if (!stopped) {
        if (code === 3000) {
          options.onError(new Error("BUSY Bar cloud input authentication failed"));
          return;
        }
        reconnect();
      }
    });
  };

  connect();
  return {
    stop(): void {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = null;
      socket?.close(1000, "monitor stopped");
      socket = null;
    },
  };
};
