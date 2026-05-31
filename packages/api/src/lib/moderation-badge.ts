// Single source of truth for the "messages awaiting moderation" count that
// drives the mobile app-icon / tab badge.
//
// A message is "awaiting moderation" once it has landed in the booth but has
// not yet been approved or rejected. That spans two internal states:
//   - "received": uploaded, AI pipeline still running
//   - "pending":  pipeline done, sitting in the operator moderation queue
// Counting both means the badge is already correct at the moment a message
// is received (the push fan-out point), rather than lagging until the async
// pipeline promotes it to "pending".

import { db } from "./db.js";

export const AWAITING_MODERATION_STATUSES = ["received", "pending"] as const;

export const countMessagesAwaitingModeration = (): Promise<number> =>
  db.message.count({ where: { status: { in: [...AWAITING_MODERATION_STATUSES] } } });
