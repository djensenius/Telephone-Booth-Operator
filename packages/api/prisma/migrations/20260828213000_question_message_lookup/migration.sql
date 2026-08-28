-- CreateIndex
CREATE INDEX "Message_questionId_createdAt_id_idx" ON "Message"("questionId", "createdAt", "id");
