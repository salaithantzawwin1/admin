-- AMS Phase 3 — fleet, car requests, assignments, trips, expenses

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('AVAILABLE', 'IN_USE', 'UNDER_MAINTENANCE', 'OUT_OF_SERVICE');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('SEDAN', 'SUV', 'PICKUP', 'VAN', 'BUS', 'TRUCK', 'OTHER');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('AVAILABLE', 'ON_TRIP', 'ON_LEAVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "CarRequestTimeSlot" AS ENUM ('FULL_DAY', 'HALF_DAY_AM', 'HALF_DAY_PM', 'CUSTOM_HOURS');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('NOT_STARTED', 'STARTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CarExpenseType" AS ENUM ('FUEL', 'TOLL', 'PARKING', 'REPAIR', 'OTHER');

-- Alter existing enum to add car-request notification types
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CAR_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TRIP_STARTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TRIP_COMPLETED';

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "vehicleNo" TEXT NOT NULL,
    "vehicleType" "VehicleType" NOT NULL DEFAULT 'SEDAN',
    "brandModel" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 4,
    "driverId" UUID,
    "currentMileage" INTEGER NOT NULL DEFAULT 0,
    "status" "VehicleStatus" NOT NULL DEFAULT 'AVAILABLE',
    "registrationExpiry" TIMESTAMP(3),
    "insuranceExpiry" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "licenseNo" TEXT,
    "licenseExpiry" TIMESTAMP(3),
    "status" "DriverStatus" NOT NULL DEFAULT 'AVAILABLE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "car_requests" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "vehicleTypeRequired" "VehicleType",
    "passengers" INTEGER NOT NULL DEFAULT 1,
    "destination" TEXT NOT NULL,
    "purpose" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "timeSlot" "CarRequestTimeSlot" NOT NULL DEFAULT 'FULL_DAY',
    "pickupLocation" TEXT,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "vehicleId" UUID,
    "driverId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "car_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "car_assignments" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "carRequestId" UUID,
    "vehicleId" UUID NOT NULL,
    "driverId" UUID,
    "assignedById" UUID NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "car_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "car_trips" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "status" "TripStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "startMileage" INTEGER,
    "endMileage" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "car_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "car_expenses" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "type" "CarExpenseType" NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "expenseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "car_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_vehicleNo_key" ON "vehicles"("vehicleNo");
CREATE UNIQUE INDEX "car_requests_requestId_key" ON "car_requests"("requestId");
CREATE UNIQUE INDEX "car_assignments_requestId_key" ON "car_assignments"("requestId");
CREATE UNIQUE INDEX "car_assignments_carRequestId_key" ON "car_assignments"("carRequestId");
CREATE UNIQUE INDEX "car_trips_assignmentId_key" ON "car_trips"("assignmentId");
CREATE INDEX "car_requests_startDate_endDate_idx" ON "car_requests"("startDate", "endDate");
CREATE INDEX "car_requests_vehicleId_idx" ON "car_requests"("vehicleId");
CREATE INDEX "car_assignments_vehicleId_idx" ON "car_assignments"("vehicleId");

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "car_requests" ADD CONSTRAINT "car_requests_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "request_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "car_requests" ADD CONSTRAINT "car_requests_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "car_requests" ADD CONSTRAINT "car_requests_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "car_assignments" ADD CONSTRAINT "car_assignments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "request_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "car_assignments" ADD CONSTRAINT "car_assignments_carRequestId_fkey" FOREIGN KEY ("carRequestId") REFERENCES "car_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "car_assignments" ADD CONSTRAINT "car_assignments_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "car_assignments" ADD CONSTRAINT "car_assignments_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "car_assignments" ADD CONSTRAINT "car_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "car_trips" ADD CONSTRAINT "car_trips_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "car_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "car_expenses" ADD CONSTRAINT "car_expenses_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "car_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "car_expenses" ADD CONSTRAINT "car_expenses_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "car_expenses" ADD CONSTRAINT "car_expenses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
