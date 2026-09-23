-- Driver ↔ Employee optional link (a driver may be a staff member).
ALTER TABLE "drivers" ADD COLUMN "employeeId" UUID;

-- each employee can back at most one driver record
CREATE UNIQUE INDEX "drivers_employeeId_key" ON "drivers"("employeeId");

ALTER TABLE "drivers"
  ADD CONSTRAINT "drivers_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "employees"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
