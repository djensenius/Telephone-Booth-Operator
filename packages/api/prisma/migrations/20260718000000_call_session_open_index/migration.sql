-- CreateIndex
CREATE INDEX "CallSession_endedAt_startedAt_idx" ON "CallSession"("endedAt", "startedAt");
