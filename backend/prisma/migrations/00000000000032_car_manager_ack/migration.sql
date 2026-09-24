-- Optional manager acknowledgement on car requests (Plan §5b — Department Head
-- confirms they know about the trip; never blocks the workflow).
ALTER TABLE "car_requests" ADD COLUMN "managerAckAt" TIMESTAMP(3);
ALTER TABLE "car_requests" ADD COLUMN "managerAckById" UUID;

ALTER TABLE "car_requests" ADD CONSTRAINT "car_requests_managerAckById_fkey"
  FOREIGN KEY ("managerAckById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
