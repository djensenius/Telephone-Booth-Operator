-- Observability stack: persistent event log + derived call sessions.
-- See docs/observability.md for the schema rationale.

CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "boothId" TEXT NOT NULL,
    "bootId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "digitsDialed" TEXT,
    "outcome" TEXT,
    "recordingId" TEXT,
    "durationMs" INTEGER,

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CallSession_boothId_startedAt_idx" ON "CallSession"("boothId", "startedAt");
CREATE INDEX "CallSession_outcome_idx" ON "CallSession"("outcome");

CREATE TABLE "BoothEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "boothId" TEXT NOT NULL,
    "bootId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" TEXT,
    "recordingId" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "BoothEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BoothEvent_boothId_eventId_key" ON "BoothEvent"("boothId", "eventId");
CREATE INDEX "BoothEvent_occurredAt_idx" ON "BoothEvent"("occurredAt");
CREATE INDEX "BoothEvent_boothId_occurredAt_idx" ON "BoothEvent"("boothId", "occurredAt");
CREATE INDEX "BoothEvent_type_occurredAt_idx" ON "BoothEvent"("type", "occurredAt");
CREATE INDEX "BoothEvent_sessionId_idx" ON "BoothEvent"("sessionId");
CREATE INDEX "BoothEvent_boothId_receivedAt_id_idx" ON "BoothEvent"("boothId", "receivedAt", "id");

ALTER TABLE "BoothEvent" ADD CONSTRAINT "BoothEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CallSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
