-- Shared trips (convoy mode): two or more approved requests may ride
-- the same car + driver over overlapping windows. Administration links the
-- second request to the first at assign time (cars.assign body share=true);
-- availability checks skip other members of the same group.
ALTER TABLE "car_requests" ADD COLUMN "sharedTripId" UUID;
CREATE INDEX "car_requests_sharedTripId_idx" ON "car_requests"("sharedTripId");
