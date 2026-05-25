import type { BoothSystemSnapshot, Message } from "@telephone-booth-operator/shared";

export type BoothStatusEvent = {
  state:
    | "idle"
    | "dialTone"
    | "dialing"
    | "playingQuestion"
    | "beep"
    | "recording"
    | "uploading"
    | "playingMessage"
    | "playingInstructions"
    | "error";
  updatedAt: string;
  currentQuestionId?: string | null;
  currentMessageId?: string | null;
  lastError?: string | null;
};

// Discriminated union mirroring `@telephone-booth-operator/shared`
// `WsEnvelopeSchema`. The status WS broadcasts all three kinds.
export type WsEnvelope =
  | { kind: "status"; status: BoothStatusEvent }
  | { kind: "system"; boothId: string; snapshot: BoothSystemSnapshot; receivedAt: string }
  | { kind: "message"; message: Message };

type Subscriber<T> = (event: T) => void;

export class Broadcaster<T> {
  readonly #subscribers = new Map<string, Subscriber<T>>();

  subscribe(clientId: string, cb: Subscriber<T>): void {
    this.#subscribers.set(clientId, cb);
  }

  unsubscribe(clientId: string): void {
    this.#subscribers.delete(clientId);
  }

  broadcast(event: T): void {
    for (const cb of this.#subscribers.values()) cb(event);
  }

  get size(): number {
    return this.#subscribers.size;
  }
}

// Unified WS broadcaster. Older code that emitted bare `BoothStatusEvent`
// payloads now wraps them as `{ kind: "status", status }` before calling
// `wsBroadcaster.broadcast(...)`.
export const wsBroadcaster = new Broadcaster<WsEnvelope>();

// Back-compat alias for code that still imports `statusBroadcaster`. Routes
// should prefer `wsBroadcaster` directly going forward.
export const statusBroadcaster = {
  broadcast(status: BoothStatusEvent): void {
    wsBroadcaster.broadcast({ kind: "status", status });
  },
  subscribe(clientId: string, cb: Subscriber<BoothStatusEvent>): void {
    wsBroadcaster.subscribe(clientId, (event) => {
      if (event.kind === "status") cb(event.status);
    });
  },
  unsubscribe(clientId: string): void {
    wsBroadcaster.unsubscribe(clientId);
  },
};
