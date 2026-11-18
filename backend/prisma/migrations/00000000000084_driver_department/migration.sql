-- Driver → Department (fleet master data §6): which office a driver belongs to.
-- Nullable: existing drivers keep working until the desk assigns them.
ALTER TABLE "drivers" ADD COLUMN "departmentId" UUID;

ALTER TABLE "drivers" ADD CONSTRAINT "drivers_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "drivers_departmentId_idx" ON "drivers"("departmentId");
