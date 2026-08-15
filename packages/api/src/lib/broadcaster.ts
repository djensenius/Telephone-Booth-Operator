import type { BoothSystemSnapshot, Installation, Message } from "@telephone-booth-operator/shared";
import { log } from "./logger.js";

export type BoothStatusEvent = {
  // Snapshot row id; absent only for the synthetic default status.
  id?: number;
  isSynthetic?: boolean;
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
    | "callUnavailable"
    | "error";
  updatedAt: string;
  currentQuestionId?: string | null;
  currentMessageId?: string | null;
  lastError?: string | null;
  runtimeMode?: "real" | "mock" | "simulator" | null;
  // Collapsing metadata: identical consecutive booth reports fold into one
  // snapshot spanning `firstSeenAt`..`updatedAt`. See `routes/status.ts`.
  firstSeenAt?: string;
  repeatCount?: number;
};

// Discriminated union mirroring `@telephone-booth-operator/shared`
// `WsEnvelopeSchema`. The status WS broadcasts all three kinds.
export type WsEnvelope =
  | { kind: "status"; status: BoothStatusEvent }
  | {
      kind: "system";
      boothId: string;
      snapshot: BoothSystemSnapshot;
      receivedAt: string;
      version: string | null;
    }
  | { kind: "message"; message: Message }
  | { kind: "work"; messageId: string; needs: WorkNeed[] }
  // Emitted when an installation starts or ends so consoles re-scope their
  // queries immediately instead of showing the previous era until a reload.
  | { kind: "installation"; installation: Installation };

// The push-mode job steps a subscribed Transcription worker can be asked to
// run. Mirrors the `work` arm of `WsEnvelopeSchema` in the shared package.
export type WorkNeed = "transcription" | "translation" | "moderation";

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
    for (const [clientId, cb] of this.#subscribers.entries()) {
      try {
        cb(event);
      } catch (err: unknown) {
        this.#subscribers.delete(clientId);
        log.warn({ clientId, err }, "subscriber callback threw; unsubscribed");
      }
    }
  }

  get size(): number {
    return this.#subscribers.size;
  }
}

// Unified WS broadcaster. Older code that emitted bare `BoothStatusEvent`
// payloads now wraps them as `{ kind: "status", status }` before calling
// `wsBroadcaster.broadcast(...)`.
export const wsBroadcaster = new Broadcaster<WsEnvelope>();

// Notify subscribed Transcription workers (macOS + iOS) that a message needs
// one or more pipeline steps run and pushed back. This is the push-mode
// replacement for the removed `/v1/jobs/next` poll loop.
export const broadcastWork = (messageId: string, needs: WorkNeed[]): void => {
  if (needs.length === 0) return;
  wsBroadcaster.broadcast({ kind: "work", messageId, needs });
};

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
