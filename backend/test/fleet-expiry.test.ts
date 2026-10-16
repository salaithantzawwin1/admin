/**
 * VMS Phase A (Vehicle spec §6.3/§6.4) — document-expiry status + daily alert sweep.
 *
 * REAL FleetService with spy Prisma/notifications/permissions:
 *  - expiryStatus(): thresholds EXPIRED / DUE_TODAY / UPCOMING(≤30) / VALID on
 *    business-local (Asia/Yangon) calendar dates — browser/UTC time is never
 *    the source of truth (spec §6.3).
 *  - listVehicles()/listDrivers(): computed status fields ride along the lists.
 *  - expiryAlerts(): the dashboard feed (non-VALID only, EXPIRED first).
 *  - runExpiryAlerts(): alerts only on 30/14/7/1 + due-today + expired, one
 *    notification per recipient per key (Notification.dedupeKey dedup), silent
 *    on a second pass (spec §6.4).
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/fleet-expiry.test.ts
 */
import assert from 'assert';
import { FleetService, expiryStatus, daysUntilExpiry } from '../src/fleet/fleet.service';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e: unknown) => {
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    });
}

// Fixed "now": 16 Oct 2026 06:00 UTC = 16 Oct 12:30 Asia/Yangon → business date 2026-10-16.
const NOW = new Date('2026-10-16T06:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

/** Mutable store of "already delivered" dedup keys — shared across runs. */
const sentKeys = new Set<string>();
const notifyCalls: {
  userId: string; type: string; title: string; body?: string; link?: string; dedupeKey?: string;
}[] = [];

const vehicles = [
  { id: 'v-expired', vehicleNo: 'YGN-1001', registrationExpiry: day(-3), insuranceExpiry: day(45) },
  { id: 'v-due', vehicleNo: 'YGN-1002', registrationExpiry: new Date('2026-10-16T10:00:00Z'), insuranceExpiry: null },
  { id: 'v-week', vehicleNo: 'YGN-1003', registrationExpiry: day(7), insuranceExpiry: day(23) },
  { id: 'v-clean', vehicleNo: 'YGN-1004', registrationExpiry: day(200), insuranceExpiry: null },
];
const drivers = [
  { id: 'd-1', name: 'U Aung Kyaw', licenseExpiry: day(14), status: 'AVAILABLE' },
  { id: 'd-2', name: 'Doe', licenseExpiry: null, status: 'AVAILABLE' },
];

const recipients = ['mgr-1', 'mgr-2'];
let recipientsNow: string[] = recipients; // flipped to [] by the no-holders test

const prisma: any = {
  vehicle: { findMany: async () => vehicles },
  driver: { findMany: async () => drivers },
  carRequest: { findMany: async () => [] },
  carAssignment: { findMany: async () => [] },
  notification: {
    findMany: async ({ where }: any) => {
      const keys: string[] = where?.dedupeKey?.in ?? [];
      return keys.filter((k) => sentKeys.has(k)).map((dedupeKey) => ({ dedupeKey }));
    },
  },
};
const notifications = {
  notify: async (p: (typeof notifyCalls)[number]) => {
    notifyCalls.push(p);
    sentKeys.add(p.dedupeKey as string);
    return p;
  },
};
const permissions = { usersWithPermissions: async () => recipientsNow };
const fleet = new FleetService(
  prisma, // prisma
  {}, // audit (writes only)
  {}, // events
  {}, // telegram
  notifications as never,
  permissions as never,
  {} as never, // timetable
);

async function main() {
  console.log('== expiryStatus (spec §6.3) ==');
  await test('unset date → null (field-level NOT_CONFIGURED)', () => {
    assert.strictEqual(expiryStatus(null, NOW), null);
    assert.strictEqual(expiryStatus(undefined, NOW), null);
  });
  await test('beyond 30 days → VALID; exactly 30/14/7/1 → UPCOMING', () => {
    assert.strictEqual(expiryStatus(day(31), NOW), 'VALID');
    assert.strictEqual(expiryStatus(day(200), NOW), 'VALID');
    for (const d of [30, 14, 7, 1]) assert.strictEqual(expiryStatus(day(d), NOW), 'UPCOMING', `${d}d`);
  });
  await test('business-local today → DUE_TODAY; past → EXPIRED', () => {
    assert.strictEqual(expiryStatus(new Date('2026-10-16T10:00:00Z'), NOW), 'DUE_TODAY'); // same Yangon day
    assert.strictEqual(expiryStatus(day(-1), NOW), 'EXPIRED');
    assert.strictEqual(expiryStatus(day(-400), NOW), 'EXPIRED');
  });
  await test('Yangon, not UTC, decides the day (spec §6.3)', () => {
    // 17 Oct 00:00 UTC is already 17 Oct 06:30 in Yangon while UTC still says 16 Oct
    const nowLateUtc = new Date('2026-10-16T18:00:00Z'); // Yangon 17 Oct 00:30
    assert.strictEqual(expiryStatus(new Date('2026-10-17T00:00:00Z'), nowLateUtc), 'DUE_TODAY');
    assert.strictEqual(daysUntilExpiry(new Date('2026-10-17T00:00:00Z'), nowLateUtc), 0);
    // and 16 Oct 18:00Z is already 17 Oct in Yangon → TOMORROW for a 16 Oct "today"
    // (UTC math would wrongly say DUE_TODAY — same calendar day)
    assert.strictEqual(expiryStatus(new Date('2026-10-16T18:00:00Z'), NOW), 'UPCOMING');
    assert.strictEqual(daysUntilExpiry(new Date('2026-10-16T18:00:00Z'), NOW), 1);
  });

  console.log('== computed list fields ==');
  await test('listVehicles carries registration/insurance expiry status', async () => {
    const rows = await fleet.listVehicles();
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));
    assert.strictEqual(byId['v-expired'].registrationExpiryStatus, 'EXPIRED');
    assert.strictEqual(byId['v-expired'].insuranceExpiryStatus, 'VALID');
    assert.strictEqual(byId['v-due'].registrationExpiryStatus, 'DUE_TODAY');
    assert.strictEqual(byId['v-due'].insuranceExpiryStatus, null);
    assert.strictEqual(byId['v-week'].registrationExpiryStatus, 'UPCOMING');
    assert.strictEqual(byId['v-clean'].registrationExpiryStatus, 'VALID');
  });
  await test('listDrivers carries licence expiry status', async () => {
    const rows = await fleet.listDrivers();
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));
    assert.strictEqual(byId['d-1'].licenseExpiryStatus, 'UPCOMING'); // 14 days
    assert.strictEqual(byId['d-2'].licenseExpiryStatus, null);
  });

  console.log('== expiryAlerts dashboard feed ==');
  await test('non-VALID only, EXPIRED first, VALID/unset excluded', async () => {
    const alerts = await fleet.expiryAlerts(NOW);
    const keys = alerts.map((a) => `${a.kind}:${a.label}:${a.doc}:${a.status}`);
    assert.deepStrictEqual(keys, [
      'VEHICLE:YGN-1001:registration:EXPIRED',
      'VEHICLE:YGN-1002:registration:DUE_TODAY',
      'VEHICLE:YGN-1003:registration:UPCOMING', // 7d
      'DRIVER:U Aung Kyaw:license:UPCOMING', // 14d — licences are in scope (spec §6.1)
      'VEHICLE:YGN-1003:insurance:UPCOMING', // 23d — in the ≤30d feed, but NOT a notify threshold
    ]);
    assert.ok(!keys.some((k) => k.includes('YGN-1004')), 'VALID dates must not alert');
    const reg = alerts.find((a) => a.label === 'YGN-1003');
    assert.strictEqual(reg?.daysLeft, 7);
  });

  console.log('== runExpiryAlerts daily sweep (spec §6.4) ==');
  await test('thresholds only: 30/14/7/1 + due-today + expired (23 days stays silent)', async () => {
    const res = await fleet.runExpiryAlerts(NOW);
    // expected: v-expired reg (EXPIRED), v-due reg (DUE_TODAY), v-week reg (d7),
    // d-1 licence (d14) — NOT v-week insurance (23d), NOT v-expired insurance (45d/VALID)
    assert.strictEqual(res.alerts, 4, `alerts=${res.alerts}`);
    assert.strictEqual(res.recipients, 2);
    assert.strictEqual(res.sent, notifyCalls.length);
    assert.strictEqual(res.sent, 8); // 4 alerts × 2 recipients
    const keys = notifyCalls.map((c) => c.dedupeKey);
    assert.ok(keys.every((k) => k && (k.endsWith(':mgr-1') || k.endsWith(':mgr-2'))), 'key ends with recipient');
    const weekKey = keys.find((k) => k?.includes('v-week') && k.includes(':insurance:'));
    assert.ok(!weekKey, '23-day insurance must not notify');
    const d7 = keys.find((k) => k?.startsWith('doc-expiry:VEHICLE:v-week:registration:') && k.endsWith(':mgr-1'));
    assert.ok(d7 && d7.includes(':d7:'), `expected d7 threshold key, got ${d7}`);
    assert.ok(notifyCalls.every((c) => c.type === 'VEHICLE_DOC_EXPIRY' && c.link === '/fleet'));
    assert.ok(notifyCalls.some((c) => c.title.includes('Driver license expiring')));
  });
  await test('dedup: already-sent keys are skipped; second run sends nothing', async () => {
    const before = notifyCalls.length;
    const res = await fleet.runExpiryAlerts(NOW);
    assert.strictEqual(res.alerts, 4, 'alerts are still detected');
    assert.strictEqual(res.recipients, 2);
    assert.strictEqual(res.sent, 0, 'no duplicate deliveries on rerun');
    assert.strictEqual(notifyCalls.length, before);
  });
  await test('no fleet.manage holders → zero sends, no crash', async () => {
    const before = notifyCalls.length;
    recipientsNow = [];
    const res = await fleet.runExpiryAlerts(NOW);
    recipientsNow = recipients;
    assert.strictEqual(res.recipients, 0);
    assert.strictEqual(res.sent, 0);
    assert.strictEqual(notifyCalls.length, before);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
