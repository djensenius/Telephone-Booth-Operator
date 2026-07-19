-- Support worker WebSocket reconnect replay queries for outstanding push work.
CREATE INDEX "Transcription_push_translation_replay_idx"
  ON "Transcription" ("status", "translationStatus", "translationProvider", "createdAt" DESC, "id" DESC);

CREATE INDEX "Moderation_push_replay_idx"
  ON "Moderation" ("status", "provider", "createdAt" DESC, "id" DESC);
