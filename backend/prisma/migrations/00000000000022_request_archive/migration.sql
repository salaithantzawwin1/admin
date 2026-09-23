-- Auto-archive (Plan: keep working lists clean) — cancelled requests older than
-- 30 days are hidden from default lists; archivedAt marks the soft archive.
ALTER TABLE "request_documents" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "request_documents_archivedAt_idx" ON "request_documents"("archivedAt");
