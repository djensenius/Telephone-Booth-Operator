export type BoothStatusEvent = {
  state: "idle" | "dialTone" | "dialing" | "playingQuestion" | "beep" | "recording" | "uploading" | "playingMessage" | "playingInstructions" | "error";
  updatedAt: string;
  currentQuestionId?: string | null;
  currentMessageId?: string | null;
  lastError?: string | null;
};

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

export const statusBroadcaster = new Broadcaster<BoothStatusEvent>();
