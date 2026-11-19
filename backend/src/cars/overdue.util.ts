/**
 * Ride evidence — the ONE definition of "the car left the office and has not
 * been closed out" (docs/OVERDUE_RETURN_GUARD_PLAN.md, Step 1).
 *
 * Tap state is not physical state. A driver who tapped Ready and never tapped
 * "🏁 Back at Office" used to be auto-completed 15 minutes after the planned
 * end while still on the road (CAR-202611-0039), freeing the car for the next
 * requester. Every reader — the janitor, the two fleet badges, the conflict
 * check and the assign pickers — imports these so the arms cannot drift.
 */

/**
 * Prisma filter for assignments whose ride is still out: nothing released, no
 * Back tap, no return reading, and proof the car left (Ready tap, or a departure
 * km with its timestamp — `startOdoKm` is the number, `startOdoAt` the capture
 * time, and captureOdometer writes both).
 */
export const outOnRoadWhere = {
  releasedAt: null,
  driverBackAtOfficeAt: null,
  endOdoAt: null,
  OR: [
    { startOdoKm: { not: null } },
    { startOdoAt: { not: null } },
    { driverArrivedAt: { not: null } },
  ],
};

/**
 * Every assignment that holds a car or driver right now: a STARTED trip (the
 * mileage close-out is still open) OR a ride that is provably out (above). The
 * fleet/requester badges and the busy-driver lists looked at STARTED trips
 * only, so a held car read AVAILABLE and was offered for a new trip.
 */
export const liveRideWhere = {
  releasedAt: null,
  OR: [{ trip: { status: 'STARTED' as const } }, outOnRoadWhere],
};

/**
 * A live assignment whose ride was never started: departure recorded, no return
 * yet — the janitor's hold. This is the non-STARTED half of `liveRideWhere`, so
 * every reader agrees on which live rows are holds and which are plain trips.
 */
export function isHeldRide(a: { trip: { status: string } | null }): boolean {
  return a.trip?.status !== 'STARTED';
}

/** The same rule for an assignment row that is already loaded. */
export function isOutOnRoad(a: {
  releasedAt: Date | null;
  driverBackAtOfficeAt: Date | null;
  endOdoAt: Date | null;
  startOdoKm: number | null;
  startOdoAt: Date | null;
  driverArrivedAt: Date | null;
}): boolean {
  if (a.releasedAt != null || a.driverBackAtOfficeAt != null || a.endOdoAt != null) return false;
  return a.startOdoKm != null || a.startOdoAt != null || a.driverArrivedAt != null;
}
