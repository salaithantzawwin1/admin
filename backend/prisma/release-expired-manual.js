/* Manual run of the auto-release logic (same as TripRemindersService.releaseExpired). */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const now = new Date();
  const stuck = await p.carAssignment.findMany({
    where: {
      releasedAt: null,
      request: { carRequest: { endDate: { lt: now } } },
      OR: [{ trip: null }, { trip: { status: 'NOT_STARTED' } }],
    },
    include: {
      vehicle: { select: { vehicleNo: true } },
      request: { select: { docNumber: true, carRequest: { select: { endDate: true } } } },
    },
  });
  console.log('stuck found:', stuck.length);
  for (const a of stuck) {
    await p.carAssignment.update({ where: { id: a.id }, data: { releasedAt: now } });
    await p.vehicle.update({ where: { id: a.vehicleId }, data: { status: 'AVAILABLE' } });
    console.log('released:', a.request.docNumber, '→', a.vehicle.vehicleNo, 'AVAILABLE');
  }
  await p.$disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
