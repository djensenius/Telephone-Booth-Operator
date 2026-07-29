// Single source of truth for the "messages awaiting moderation" count that
// drives the mobile app-icon / tab badge.
//
// A message is "awaiting moderation" once it has landed in the booth but has
// not yet been approved or rejected. That spans two internal states:
//   - "pending":  in the operator moderation queue. A completed upload lands
//                 here directly — transcription is optional enrichment and
//                 never gates review.
//   - "received": legacy state for messages recorded before that change, when
//                 the AI pipeline had to finish first. Counted so historical
//                 rows are not silently dropped from the badge.

import { db } from "./db.js";

export const AWAITING_MODERATION_STATUSES = ["received", "pending"] as const;

export const countMessagesAwaitingModeration = (): Promise<number> =>
  db.message.count({ where: { status: { in: [...AWAITING_MODERATION_STATUSES] } } });
