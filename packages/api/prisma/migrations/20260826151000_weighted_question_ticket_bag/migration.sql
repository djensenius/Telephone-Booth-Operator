-- AlterTable
ALTER TABLE "Installation" ADD COLUMN     "lastSelectedQuestionId" UUID,
ADD COLUMN     "recentQuestionDraws" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "questionSelectionCycle" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "lastSelectedCycle" INTEGER,
ADD COLUMN     "selectionsInCycle" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "weight" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "Question_installationId_status_lastSelectedCycle_idx" ON "Question"("installationId", "status", "lastSelectedCycle");
