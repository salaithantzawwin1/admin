/**
 * VMS Phase B (Vehicle spec §6.1/§6.2/§6.5) — document register + compliance.
 *
 * REAL FleetService / FleetComplianceService / CarsService over an in-memory
 * prisma double that models just the query shapes these services issue:
 *
 *  - document types (§6.1): create validation, duplicate code, warning-days
 *    range, delete→deactivate when records exist.
 *  - document records (§6.2): expiry required unless the type allows it, one
 *    CURRENT record per vehicle+type, superseded rows immutable, renewal
 *    lineage (new row → old row superseded, old expiry preserved), legacy
 *    column mirroring for REGISTRATION/INSURANCE.
 *  - compliance (§6.5/§7.3): mandatory missing/expired/dateless block; VALID,
 *    DUE_TODAY, non-mandatory and out-of-scope types do not; expired driver
 *    licence blocks with the assigned driver only.
 *  - dispatch block: CarsService.assign + startTrip throw the block reason.
 *  - fleet list chip: dispatchBlocked/dispatchBlockReason ride listVehicles.
 *  - sweep (§6.4): per-type thresholds, register records suppress their legacy
 *    column (no double alert), dedup still one-per-recipient-per-key.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/fleet-documents.test.ts
 */
import assert from 'assert';
import { FleetService } from '../src/fleet/fleet.service';
import { FleetComplianceService } from '../src/fleet/compliance.service';
import { CarsService } from '../src/cars/cars.service';

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

// Fixed "now": 16 Oct 2026 06:00 UTC = 16 Oct 12:30 Asia/Yangon → 2026-10-16.
const NOW = new Date('2026-10-16T06:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

// ---------------- in-memory store ----------------

const db: {
  docTypes: any[];
  documents: any[];
  vehicles: any[];
  drivers: any[];
  notifications: any[];
} = { docTypes: [], documents: [], vehicles: [], drivers: [], notifications: [] };

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(v as any[]).some((w) => matchWhere(row, w))) return false;
      continue;
    }
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      const cond = v as any;
      if ('in' in cond) {
        if (!cond.in.includes(row[k])) return false;
        continue;
      }
      if ('not' in cond) {
        if (cond.not === null) {
          if (row[k] === null || row[k] === undefined) return false;
          continue;
        }
        if (row[k] === cond.not) return false;
        continue;
      }
      throw new Error(`mock: unsupported operator on ${k}: ${JSON.stringify(cond)}`);
    }
    if (v === null) {
      if (row[k] !== null && row[k] !== undefined) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

function sortRows(rows: any[], orderBy: any): any[] {
  if (!orderBy) return rows;
  const specs: { field: string; dir: string }[] = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const s of specs) {
      const av = a[s.field];
      const bv = b[s.field];
      if (av === bv) continue;
      const cmp = (av ?? 0) < (bv ?? 0) ? -1 : 1;
      return s.dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

/** Attach relations the way include/select asks for (superset is safe). */
function decorate(row: any): any {
  if (!row || !row.documentTypeId) return row;
  const withRels = { ...row };
  if ('documentTypeId' in row) {
    withRels.documentType = db.docTypes.find((t) => t.id === row.documentTypeId) ?? null;
    withRels.vehicle = db.vehicles.find((v) => v.id === row.vehicleId) ?? null;
    withRels.attachment = row.attachmentId ? { id: row.attachmentId, filename: 'f.pdf', mimeType: 'application/pdf', size: 1 } : null;
  }
  return withRels;
}

function model(rows: any[], prefix: string, defaults: Record<string, unknown> = {}) {
  return {
    findMany: async (args: any = {}) => sortRows(rows.filter((r) => matchWhere(r, args.where)), args.orderBy).map((r) => decorate(r)),
    findUnique: async (args: any = {}) => {
      const r = rows.find((x) => matchWhere(x, args.where));
      return r ? decorate(r) : null;
    },
    findFirst: async (args: any = {}) => {
      const r = sortRows(rows.filter((x) => matchWhere(x, args.where)), args.orderBy)[0];
      return r ? decorate(r) : null;
    },
    count: async (args: any = {}) => rows.filter((r) => matchWhere(r, args.where)).length,
    create: async ({ data }: any) => {
      // schema defaults matter: `supersededById: null` filters and
      // `active: true` list filters compare against REAL nulls/defaults.
      // undefined = "not set" (Prisma semantics) so the default survives.
      const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
      const row = { id: data.id ?? uid(prefix), createdAt: new Date(), updatedAt: new Date(), ...defaults, ...clean };
      rows.push(row);
      return decorate(row);
    },
    update: async ({ where, data }: any) => {
      const row = rows.find((x) => matchWhere(x, where));
      if (!row) throw new Error(`mock ${prefix}.update: not found`);
      const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
      Object.assign(row, clean, { updatedAt: new Date() });
      return decorate(row);
    },
    delete: async ({ where }: any) => {
      const idx = rows.findIndex((x) => matchWhere(x, where));
      if (idx < 0) throw new Error(`mock ${prefix}.delete: not found`);
      return rows.splice(idx, 1)[0];
    },
  };
}

const docTypeModel = model(db.docTypes, 'vdt', {
  active: true, vehicleType: null, warningDays: [], mandatoryForDispatch: false, allowNoExpiry: false, sortOrder: 0,
});
const documentModel = model(db.documents, 'vdoc', {
  documentNo: null, issuingAuthority: null, issueDate: null, expiryDate: null,
  renewalStatus: 'NOT_STARTED', previousId: null, supersededById: null, notes: null, attachmentId: null,
});
const vehicleModel = model(db.vehicles, 'veh', {
  driverId: null, registrationExpiry: null, insuranceExpiry: null, status: 'AVAILABLE',
});
const driverModel = model(db.drivers, 'drv', { licenseExpiry: null });

const prisma: any = {
  vehicleDocumentType: docTypeModel,
  vehicleDocument: documentModel,
  vehicle: vehicleModel,
  driver: driverModel,
  carRequest: { findMany: async () => [] },
  carAssignment: { findMany: async () => [] },
  notification: {
    findMany: async ({ where }: any) => {
      const keys: string[] = where?.dedupeKey?.in ?? [];
      return keys.filter((k) => db.notifications.includes(k)).map((dedupeKey) => ({ dedupeKey }));
    },
  },
  $transaction: async (fn: any) => fn(prisma),
};

const notifyCalls: any[] = [];
const notifications = {
  notify: async (p: any) => {
    notifyCalls.push(p);
    db.notifications.push(p.dedupeKey);
    return p;
  },
};
const permissions = { usersWithPermissions: async () => ['fleet-mgr'] };
const audit = { log: async () => undefined };

const compliance = new FleetComplianceService(prisma);
const fleet = new FleetService(prisma, audit as never, {} as never, {} as never, notifications as never, permissions as never, {} as never, compliance);
const cars = new CarsService(prisma, {} as never, {} as never, notifications as never, audit as never, {} as never, {} as never, {} as never, compliance);

const actor = { userId: 'u1', username: 'admin' };

/** Convenience: a spec-default-ish doc type row. */
async function seedType(over: Partial<{ code: string; name: string; vehicleType: string | null; mandatoryForDispatch: boolean; allowNoExpiry: boolean; warningDays: number[] }> = {}) {
  return fleet.createDocumentType(
    { code: over.code ?? 'ROAD_TAX', name: over.name ?? 'Road tax', vehicleType: over.vehicleType, mandatoryForDispatch: over.mandatoryForDispatch, allowNoExpiry: over.allowNoExpiry, warningDays: over.warningDays },
    actor,
  );
}

async function rejects(fn: () => Promise<unknown>, needle: string): Promise<string> {
  try {
    await fn();
  } catch (e: any) {
    assert.ok(e.message.includes(needle), `expected "${needle}" in: ${e.message}`);
    return e.message;
  }
  assert.fail(`expected rejection containing "${needle}"`);
}

async function main() {
  // fixtures: one vehicle per scenario + a driver. Type scopes keep the
  // mandatory rules under test on ONE vehicle (spec §6.5 scoping: a type only
  // applies to its vehicleType, others are NOT_APPLICABLE).
  db.vehicles.push(
    { id: 'v-mand', vehicleNo: 'YGN-2001', vehicleType: 'SEDAN', driverId: 'd-1', status: 'AVAILABLE', registrationExpiry: null, insuranceExpiry: null },
    { id: 'v-clean', vehicleNo: 'YGN-2002', vehicleType: 'SUV', driverId: null, status: 'AVAILABLE', registrationExpiry: null, insuranceExpiry: null },
    { id: 'v-legacy', vehicleNo: 'YGN-2003', vehicleType: 'VAN', driverId: null, status: 'AVAILABLE', registrationExpiry: day(7), insuranceExpiry: null },
  );
  db.drivers.push({ id: 'd-1', name: 'U Ba Gyi', licenseExpiry: null, status: 'AVAILABLE' });

  console.log('== document types (spec §6.1) ==');
  await test('create validates code + duplicates + warning-day range', async () => {
    const t = await seedType({ code: 'road tax', warningDays: [14, 30] });
    assert.strictEqual(t.code, 'ROAD_TAX', 'code stored uppercase/underscored');
    assert.deepStrictEqual(t.warningDays, [30, 14], 'thresholds stored descending');
    assert.strictEqual(t.mandatoryForDispatch, false, '§6.1 default: nothing blocks yet');
    await rejects(() => fleet.createDocumentType({ code: 'road_tax', name: 'Dup' }, actor), 'already exists');
    await rejects(() => fleet.createDocumentType({ code: '$$BAD', name: 'Bad' }, actor), 'letters/numbers/underscore');
    await rejects(() => seedType({ code: 'BAD_DAYS', warningDays: [0] }), 'between 1 and 365');
  });

  await test('delete: used type deactivates instead; unused type deletes', async () => {
    const t = await seedType({ code: 'INSPECTION', name: 'Inspection' });
    await fleet.createVehicleDocument('v-clean', { documentTypeId: t.id, expiryDate: day(200).toISOString() }, actor);
    await rejects(() => fleet.deleteDocumentType(t.id, actor), 'deactivate it instead');
    const stillThere = await fleet.listDocumentTypes(true);
    assert.ok(stillThere.some((x: any) => x.id === t.id), 'type still exists for managers');
    const roadTax = (await fleet.listDocumentTypes(true)).find((x: any) => x.code === 'ROAD_TAX');
    await fleet.deleteDocumentType(roadTax!.id, actor);
    assert.ok(!(await fleet.listDocumentTypes(true)).some((x: any) => x.code === 'ROAD_TAX'), 'unused type removed');
    // keep INSPECTION for later tests (it now has a record on v-clean)
  });

  console.log('== document records (spec §6.2) ==');
  await test('expiry required unless the type allows none; issue ≤ expiry', async () => {
    const t = await seedType({ code: 'LEASE_CONTRACT', name: 'Lease contract', allowNoExpiry: true });
    const ok = await fleet.createVehicleDocument('v-clean', { documentTypeId: t.id }, actor);
    assert.strictEqual(ok.expiryDate, null, 'dateless record allowed when the type allows it');
    const strict = await seedType({ code: 'ROUTE_PERMIT', name: 'Route permit' });
    await rejects(() => fleet.createVehicleDocument('v-clean', { documentTypeId: strict.id }, actor), 'requires an expiry date');
    await rejects(
      () => fleet.createVehicleDocument('v-clean', { documentTypeId: strict.id, issueDate: day(30).toISOString(), expiryDate: day(1).toISOString() }, actor),
      'Issue date cannot be after',
    );
  });

  await test('one CURRENT record per vehicle+type — duplicates go through renew', async () => {
    const t = await seedType({ code: 'REGISTRATION', name: 'Vehicle registration' });
    const doc = await fleet.createVehicleDocument('v-legacy', { documentTypeId: t.id, expiryDate: day(7).toISOString() }, actor);
    assert.ok(doc.id, 'first record created');
    // v-legacy already got a REGISTRATION row in this suite? guard against double-run
    const second = db.documents.filter((d) => d.vehicleId === 'v-legacy' && d.documentTypeId === t.id && d.supersededById === null);
    if (second.length === 1) {
      await rejects(
        () => fleet.createVehicleDocument('v-legacy', { documentTypeId: t.id, expiryDate: day(100).toISOString() }, actor),
        'renew it instead of adding a second one',
      );
    }
  });

  await test('REGISTRATION/INSURANCE writes mirror the legacy Phase A columns', async () => {
    const reg = (await fleet.listDocumentTypes(true)).find((x: any) => x.code === 'REGISTRATION');
    const v = db.vehicles.find((x) => x.id === 'v-legacy');
    assert.ok(v!.registrationExpiry, 'create mirrored registrationExpiry onto the vehicle');
    const ins = await seedType({ code: 'INSURANCE', name: 'Motor insurance' });
    await fleet.createVehicleDocument('v-clean', { documentTypeId: ins.id, expiryDate: day(45).toISOString() }, actor);
    const clean = db.vehicles.find((x) => x.id === 'v-clean');
    assert.strictEqual(clean!.insuranceExpiry?.toISOString(), day(45).toISOString(), 'insurance mirrored');
    assert.ok(reg, 'REGISTRATION type exists');
  });

  await test('renewal: new row supersedes old, old expiry preserved, second renew refused', async () => {
    const reg = (await fleet.listDocumentTypes(true)).find((x: any) => x.code === 'REGISTRATION');
    const old = db.documents.find((d) => d.vehicleId === 'v-legacy' && d.documentTypeId === reg!.id && d.supersededById === null)!;
    const oldExpiry = old.expiryDate;
    const renewed = await fleet.renewVehicleDocument(old.id, { expiryDate: day(365).toISOString(), documentNo: 'REG-NEW-1' }, actor);
    assert.strictEqual(renewed.previousId, old.id, 'new row points at the old one');
    const oldAfter = db.documents.find((d) => d.id === old.id)!;
    assert.strictEqual(oldAfter.supersededById, renewed.id, 'old row carries the forward pointer');
    assert.strictEqual(oldAfter.renewalStatus, 'RENEWED', 'old row marked RENEWED');
    assert.strictEqual(oldAfter.expiryDate?.getTime(), oldExpiry?.getTime(), 'old expiry NEVER overwritten (§6.2)');
    const clean = db.vehicles.find((x) => x.id === 'v-legacy');
    assert.strictEqual(clean!.registrationExpiry?.getTime(), day(365).getTime(), 'legacy column mirrors the NEW expiry');
    await rejects(() => fleet.renewVehicleDocument(old.id, { expiryDate: day(400).toISOString() }, actor), 'already renewed');
    await rejects(() => fleet.updateVehicleDocument(old.id, { expiryDate: day(500).toISOString() }, actor), 'superseded by a renewal');
    // history survives a delete attempt too
    await rejects(() => fleet.deleteVehicleDocument(old.id, actor), 'superseded record');
  });

  await test('manual renewalStatus=RENEWED is refused; clearing dates needs allowNoExpiry', async () => {
    const reg = (await fleet.listDocumentTypes(true)).find((x: any) => x.code === 'REGISTRATION');
    const current = db.documents.find((d) => d.vehicleId === 'v-legacy' && d.documentTypeId === reg!.id && d.supersededById === null)!;
    await rejects(() => fleet.updateVehicleDocument(current.id, { renewalStatus: 'RENEWED' }, actor), 'written by the renew action');
    await rejects(() => fleet.updateVehicleDocument(current.id, { expiryDate: null }, actor), 'requires an expiry date');
    const lease = db.documents.find((d) => d.documentTypeId && db.docTypes.find((t) => t.id === d.documentTypeId)?.code === 'LEASE_CONTRACT');
    await fleet.updateVehicleDocument(lease.id, { expiryDate: null }, actor); // allowNoExpiry type — clearing is fine
    assert.strictEqual(db.documents.find((d) => d.id === lease.id)!.expiryDate, null, 'dateless on an allow-no-expiry type');
  });

  console.log('== compliance rules (spec §6.5 / §7.3) ==');
  await test('mandatory missing → violation; nothing mandatory → clean', async () => {
    const t = await seedType({ code: 'ROAD_TAX_BLOCK', name: 'Road tax (mandatory)', mandatoryForDispatch: true, vehicleType: 'SEDAN' }); // scoped: only v-mand
    assert.ok(t.mandatoryForDispatch);
    const v = db.vehicles.find((x) => x.id === 'v-mand')!;
    const missing = await compliance.violationsFor(v, { now: NOW });
    assert.strictEqual(missing.length, 1, 'one MISSING violation');
    assert.strictEqual(missing[0].reason, 'MISSING');
    assert.ok(missing[0].detail.includes('Road tax'), `names the type: ${missing[0].detail}`);
    // clean vehicle has no mandatory types applicable → no violations
    const clean = db.vehicles.find((x) => x.id === 'v-clean')!;
    assert.deepStrictEqual(await compliance.violationsFor(clean, { now: NOW }), []);
    // scope: a mandatory type scoped to another vehicle type never applies
    await seedType({ code: 'TRUCK_ONLY', name: 'Truck permit', mandatoryForDispatch: true, vehicleType: 'TRUCK' });
    assert.deepStrictEqual(await compliance.violationsFor(clean, { now: NOW }), [], 'out-of-scope type is NOT_APPLICABLE');
  });

  await test('expired blocks, VALID and DUE_TODAY do not', async () => {
    const t = (await fleet.listDocumentTypes(true)).find((x: any) => x.code === 'ROAD_TAX_BLOCK');
    const v = db.vehicles.find((x) => x.id === 'v-mand')!;
    await fleet.createVehicleDocument('v-mand', { documentTypeId: t.id, expiryDate: day(-2).toISOString() }, actor);
    const expired = await compliance.violationsFor(v, { now: NOW });
    assert.strictEqual(expired.length, 1);
    assert.strictEqual(expired[0].reason, 'EXPIRED');
    assert.strictEqual(expired[0].daysLeft, -2, 'overdue by 2 business-local days');
    // DUE_TODAY and VALID never block (spec: "expired or missing")
    const mandDocId = db.documents.find((d) => d.vehicleId === 'v-mand' && d.documentTypeId === t.id)!.id;
    await fleet.updateVehicleDocument(mandDocId, { expiryDate: new Date('2026-10-16T10:00:00Z').toISOString() }, actor);
    assert.deepStrictEqual(await compliance.violationsFor(v, { now: NOW }), [], 'DUE_TODAY does not block');
    await fleet.updateVehicleDocument(mandDocId, { expiryDate: day(90).toISOString() }, actor);
    assert.deepStrictEqual(await compliance.violationsFor(v, { now: NOW }), [], 'VALID does not block');
    // a dateless record can never exist on a strict type: create refuses it,
    // so the violation is MISSING (not a silently stored null date)
    const strict = await seedType({ code: 'STRICT_MISS', name: 'Strict document', mandatoryForDispatch: true, vehicleType: 'SEDAN' });
    await rejects(() => fleet.createVehicleDocument('v-mand', { documentTypeId: strict.id }, actor), 'requires an expiry date');
    const missingDate = await compliance.violationsFor(v, { now: NOW });
    assert.ok(missingDate.every((x) => x.reason !== 'NO_EXPIRY_DATE'), 'no dateless record can exist on a strict type');
    assert.ok(missingDate.some((x) => x.reason === 'MISSING' && x.docType === 'Strict document'), 'refused create = MISSING violation');
  });

  await test('expired driver licence blocks only the driver actually assigned', async () => {
    const v = db.vehicles.find((x) => x.id === 'v-clean')!; // no default driver, no mandatory types
    assert.deepStrictEqual(await compliance.violationsFor(v, { now: NOW }), [], 'clean: no violations');
    db.drivers[0].licenseExpiry = day(-1);
    const withDriver = await compliance.violationsFor(v, { driverId: 'd-1', now: NOW });
    assert.strictEqual(withDriver.length, 1);
    assert.strictEqual(withDriver[0].kind, 'DRIVER_LICENSE');
    assert.ok(withDriver[0].detail.includes('U Ba Gyi'));
    assert.deepStrictEqual(await compliance.violationsFor(v, { driverId: null, now: NOW }), [], 'driver-less assignment ignores licences');
    db.drivers[0].licenseExpiry = null;
    assert.deepStrictEqual(await compliance.violationsFor(v, { driverId: 'd-1', now: NOW }), [], 'blank licence = data gap, not a violation (§7.3 "where maintained")');
  });

  console.log('== dispatch block (assign + start, spec §6.5/§8.3) ==');
  await test('assign() refuses a vehicle blocked by a mandatory document', async () => {
    const carsPrisma: any = {
      requestDocument: {
        findUnique: async () => ({
          id: 'r1', docNumber: 'CAR-1', docType: 'CAR_REQUEST', status: 'APPROVED', requesterId: 'u1',
          carRequest: { id: 'cr1', requestId: 'r1', startDate: new Date(), endDate: new Date(), assignment: null },
        }),
      },
      vehicle: { findUnique: async () => db.vehicles.find((x) => x.id === 'v-mand') },
      // compliance queries run against the shared prisma (same store)
      vehicleDocumentType: docTypeModel,
      vehicleDocument: documentModel,
      driver: driverModel,
    };
    const svc: any = new CarsService(carsPrisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, new FleetComplianceService(carsPrisma));
    const msg = await rejects(() => svc.assign('r1', { vehicleId: 'v-mand' }, actor), 'Document compliance blocks YGN-2001');
    assert.ok(msg.includes('Strict document'), `block names the offending document: ${msg}`);
    // and a vehicle with no applicable mandatory rules passes the compliance
    // gate (the double then fails later in assign — compliance came first)
    const compliant = db.vehicles.find((x) => x.id === 'v-legacy')!;
    assert.deepStrictEqual(await compliance.violationsFor(compliant, { now: NOW }), [], 'v-legacy is compliant');
  });

  await test('startTrip() refuses dispatch when a document expired after assign', async () => {
    const t = (await fleet.listDocumentTypes(true)).find((x: any) => x.code === 'ROAD_TAX_BLOCK');
    await fleet.updateVehicleDocument(db.documents.find((d) => d.vehicleId === 'v-mand' && d.documentTypeId === t.id)!.id, { expiryDate: day(-1).toISOString() }, actor);
    const carsPrisma: any = {
      carAssignment: {
        findUnique: async () => ({
          id: 'a1', requestId: 'r1', vehicleId: 'v-mand', driverId: null,
          vehicle: db.vehicles.find((x) => x.id === 'v-mand'),
          trip: null,
        }),
      },
      vehicleDocumentType: docTypeModel,
      vehicleDocument: documentModel,
      driver: driverModel,
    };
    const svc: any = new CarsService(carsPrisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, new FleetComplianceService(carsPrisma));
    const msg = await rejects(() => svc.startTrip('r1', { startMileage: 100 }, actor), 'Document compliance blocks dispatch of YGN-2001');
    assert.ok(msg.includes('Road tax (mandatory)'), 'dispatch block names the document');
  });

  console.log('== fleet list chip (§6.5) ==');
  await test('listVehicles carries dispatchBlocked + reason', async () => {
    const rows = await fleet.listVehicles();
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));
    assert.strictEqual(byId['v-mand'].dispatchBlocked, true, 'blocked vehicle flagged');
    assert.ok(byId['v-mand'].dispatchBlockReason.includes('Road tax (mandatory)'), `reason: ${byId['v-mand'].dispatchBlockReason}`);
    assert.strictEqual(byId['v-clean'].dispatchBlocked, false, 'clean vehicle not flagged');
    assert.strictEqual(byId['v-clean'].dispatchBlockReason, null);
  });

  console.log('== sweep + register thresholds (spec §6.2/§6.4) ==');
  // suppression fixture: a vehicle whose LEGACY registration date and register
  // record carry the same expiry (what migration 53's backfill produces)
  db.vehicles.push({ id: 'v-sup', vehicleNo: 'YGN-2004', vehicleType: 'SUV', driverId: null, status: 'AVAILABLE', registrationExpiry: day(5), insuranceExpiry: null });
  const regType = (await fleet.listDocumentTypes(true)).find((x: any) => x.code === 'REGISTRATION');
  await fleet.createVehicleDocument('v-sup', { documentTypeId: regType!.id, expiryDate: day(5).toISOString() }, actor);

  await test('per-type thresholds: [10] alerts at d10, default ladder ignored', async () => {
    const t = await seedType({ code: 'COMPREHENSIVE_INSURANCE', name: 'Comprehensive insurance', warningDays: [10] });
    await fleet.createVehicleDocument('v-clean', { documentTypeId: t.id, expiryDate: day(10).toISOString() }, actor);
    const alerts = await fleet.expiryAlerts(NOW);
    const comp = alerts.filter((a) => a.kind === 'DOCUMENT' && a.doc === 'COMPREHENSIVE_INSURANCE');
    assert.strictEqual(comp.length, 1, 'non-VALID record appears in the feed');
    assert.strictEqual(comp[0].thresholds?.length, 1, 'thresholds ride the alert');
    const before = notifyCalls.length;
    const res = await fleet.runExpiryAlerts(NOW);
    const compKeys = notifyCalls.slice(before).filter((c) => c.dedupeKey?.includes('COMPREHENSIVE_INSURANCE'));
    assert.ok(compKeys.length > 0, 'd10 within its custom threshold notified');
    assert.ok(compKeys.every((c) => c.dedupeKey.includes(':d10:')), `custom threshold in key: ${compKeys[0]?.dedupeKey}`);
    assert.ok(res.alerts > 0);
    // the same record must NOT have used a default-ladder key (7 days is on the
    // default ladder but not on [10]) — only d10 keys may exist for this type
    const wrongLadder = notifyCalls.slice(before).filter((c) => c.dedupeKey?.includes('COMPREHENSIVE_INSURANCE') && /:d(7|14|30|1):/.test(c.dedupeKey));
    assert.strictEqual(wrongLadder.length, 0, 'default ladder must not apply when the type overrides it');
  });

  await test('register record suppresses its legacy column — no double alert', async () => {
    const alerts = await fleet.expiryAlerts(NOW);
    // YGN-2004: legacy registrationExpiry=day(5) AND a current REGISTRATION
    // register record with the same date → exactly one alert, DOCUMENT kind
    const regAlerts = alerts.filter((a) => a.label === 'YGN-2004' && (a.doc === 'registration' || a.doc === 'REGISTRATION'));
    assert.strictEqual(regAlerts.length, 1, `expected 1 registration alert, got ${regAlerts.map((a) => `${a.kind}:${a.doc}`).join(', ')}`);
    assert.strictEqual(regAlerts[0].kind, 'DOCUMENT', 'the register record wins over the legacy column');
    // and the legacy VEHICLE kind never appears for a covered column anywhere
    assert.ok(!alerts.some((a) => a.kind === 'VEHICLE' && a.label === 'YGN-2004'), 'no legacy duplicate for the covered column');
    // a superseded record must never alert (renewal closed its reminders §6.4)
    const regDocs = db.documents.filter((d) => d.documentTypeId === regType!.id && d.supersededById !== null);
    assert.ok(regDocs.length > 0, 'fixture has superseded history from the renewal test');
    assert.ok(!alerts.some((a) => a.kind === 'DOCUMENT' && regDocs.some((d) => d.id === a.id)), 'superseded rows never alert');
  });

  await test('dedup: rerun sends nothing new (recipient × key)', async () => {
    const before = notifyCalls.length;
    const res = await fleet.runExpiryAlerts(NOW);
    assert.strictEqual(res.sent, 0, 'second sweep silent');
    assert.strictEqual(notifyCalls.length, before);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
