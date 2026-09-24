-- Driver-busy / driver-overlap queries (CarPanel picker, absence clash checks,
-- reassign free-the-driver lookups) filter car_requests by driverId — add the
-- missing index so they do not scan the whole table.
CREATE INDEX "car_requests_driverId_idx" ON "car_requests"("driverId");
