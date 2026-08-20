-- Speeds up the monitor's all-time LISTEN / ALL count while keeping the index
-- limited to the exact playback-transition subset the query uses.
CREATE INDEX "BoothEvent_installationId_messagePlaybackState_idx"
    ON "BoothEvent"("installationId")
    WHERE "type" = 'state_transition' AND "payload"->>'to' = 'playing_message';
