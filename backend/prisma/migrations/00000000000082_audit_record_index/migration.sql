-- One record's audit trail (license renewal history, request timelines) used to
-- filter a module-wide scan; index the pair the queries actually use.
CREATE INDEX "audit_logs_module_recordId_idx" ON "audit_logs"("module", "recordId");
