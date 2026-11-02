/**
 * §13–§15 Maintenance module — service records + preventive schedules.
 *
 * REAL MaintenanceService with a spy Prisma:
 *  - create: MRC-… code from the numbering service (stamped with the SERVICE
 *    date), cost columns normalised, and a SERVICE row written into the asset
 *    cost ledger when parts+labor+other is more than 0.
 *  - create with a zero cost writes no ledger row (a free warranty visit must
 *    not appear as spend).
 *  - update: the ledger row follows the new total (no stale amount left behind).
 *  - remove: the ledger row goes with the record.
 *  - schedules: next due is derived from last done + interval (day clamped),
 *    "mark done" rolls it forward, and the list decorates OVERDUE / DUE_SOON.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/maintenance.test.ts
 */
const assert = require('assert');

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

const ACTOR = { userId: 'u-1', username: 'admin1' };

/** In-memory spy: one asset, one vendor, records, schedules and the ledger. */
function makeEnv() {
  const assets = new Map<string, any>([
    ['a-1', { id: 'a-1', assetCode: 'AST-AC-2611-0001', name: 'Aircon — Meeting room' }],
  ]);
  const vendors = new Map<string, any>([['v-1', { id: 'v-1', name: 'Cool Air Services' }]]);
  const records = new Map<string, any>();
  const schedules = new Map<string, any>();
  const costs: any[] = [];
  const audits: any[] = [];
  let rseq = 0;
  let sseq = 0;
  let cseq = 0;
  let nseq = 0;

  const prisma: any = {
    asset: { findUnique: async ({ where }: any) => assets.get(where.id) ?? null },
    supplier: { findUnique: async ({ where }: any) => vendors.get(where.id) ?? null },
    maintenanceRecord: {
      create: async ({ data }: any) => {
        const row = { id: `mr-${++rseq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        records.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }: any) => {
        const row = records.get(where.id);
        if (!row) throw new Error('Record not found');
        for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
        return { ...row };
      },
      findUnique: async ({ where }: any) => {
        const row = records.get(where.id);
        return row ? { ...row, asset: assets.get(row.assetId) ?? null } : null;
      },
      findMany: async () => [...records.values()].map((r) => ({ ...r })),
      delete: async ({ where }: any) => {
        records.delete(where.id);
        return { id: where.id };
      },
    },
    maintenanceSchedule: {
      create: async ({ data }: any) => {
        const row = { id: `ms-${++sseq}`, createdAt: new Date(), updatedAt: new Date(), active: true, ...data };
        schedules.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }: any) => {
        const row = schedules.get(where.id);
        if (!row) throw new Error('Schedule not found');
        for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
        return { ...row };
      },
      findUnique: async ({ where }: any) => schedules.get(where.id) ?? null,
      findMany: async () =>
        [...schedules.values()].map((s) => ({ ...s, asset: assets.get(s.assetId) ?? null })),
      delete: async ({ where }: any) => {
        schedules.delete(where.id);
        return { id: where.id };
      },
    },
    assetCost: {
      // the service writes through the (sourceType, sourceId) unique key
      upsert: async ({ where, create, update }: any) => {
        const key = where.sourceType_sourceId;
        const existing = costs.find((c) => c.sourceType === key.sourceType && c.sourceId === key.sourceId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `ac-${++cseq}`, createdAt: new Date(), ...create };
        costs.push(row);
        return row;
      },
      deleteMany: async ({ where }: any) => {
        const before = costs.length;
        for (let i = costs.length - 1; i >= 0; i--) {
          if (costs[i].sourceType === where.sourceType && costs[i].sourceId === where.sourceId) costs.splice(i, 1);
        }
        return { count: before - costs.length };
      },
      findMany: async ({ where }: any = {}) =>
        costs.filter((c) => !where?.assetId || c.assetId === where.assetId),
    },
  };

  const audit = { log: async (e: any) => { audits.push(e); } };
  const numbering = { next: async (prefix: string) => `${prefix}-2611-${String(++nseq).padStart(4, '0')}` };
  return { prisma, audit, numbering, assets, vendors, records, schedules, costs, audits };
}

const { MaintenanceService } = require('../src/maintenance/maintenance.service');

function makeSvc() {
  const env = makeEnv();
  return { svc: new MaintenanceService(env.prisma, env.audit, env.numbering), env };
}

async function main() {
  console.log('\n== maintenance records (§13/§14) ==');

  await test('a service job gets an MRC code and writes the cost into the asset ledger', async () => {
    const { svc, env } = makeSvc();
    const row = await svc.create({
      assetId: 'a-1', type: 'corrective', date: '2026-11-02',
      problem: 'Not cooling', workDone: 'Gas refill',
      vendorId: 'v-1', costParts: 20000, costLabor: 30000, costOther: 5000,
    }, ACTOR);

    assert.strictEqual(row.code, 'MRC-2611-0001');
    assert.strictEqual(row.type, 'CORRECTIVE');
    assert.strictEqual(row.status, 'COMPLETED', 'a recorded past job is complete by default');
    assert.strictEqual(row.costTotal, 55000);
    assert.strictEqual(env.costs.length, 1);
    assert.strictEqual(env.costs[0].kind, 'SERVICE');
    assert.strictEqual(Number(env.costs[0].amount), 55000);
    assert.strictEqual(env.costs[0].sourceType, 'MAINTENANCE');
    assert.strictEqual(env.costs[0].supplierId, 'v-1');
    assert.strictEqual(env.audits.at(-1).action, 'MAINTENANCE_RECORD_CREATED');
  });

  await test('a free visit (warranty) records history without inventing spend', async () => {
    const { svc, env } = makeSvc();
    await svc.create({ assetId: 'a-1', type: 'WARRANTY_SERVICE', workDone: 'Board replaced under warranty' }, ACTOR);
    assert.strictEqual(env.records.size, 1);
    assert.strictEqual(env.costs.length, 0);
  });

  await test('editing the cost keeps exactly one ledger row in step', async () => {
    const { svc, env } = makeSvc();
    const created = await svc.create({ assetId: 'a-1', costParts: 1000, costLabor: 2000 }, ACTOR);
    assert.strictEqual(env.costs.length, 1);
    assert.strictEqual(Number(env.costs[0].amount), 3000);

    await svc.update(created.id, { costLabor: 5000 }, ACTOR);
    assert.strictEqual(env.costs.length, 1, 'no duplicate ledger row on edit');
    assert.strictEqual(Number(env.costs[0].amount), 6000);

    // editing down to zero removes the row instead of leaving a 0 cost behind
    await svc.update(created.id, { costParts: 0, costLabor: 0, costOther: 0 }, ACTOR);
    assert.strictEqual(env.costs.length, 0);
  });

  await test('deleting a record takes its ledger row with it', async () => {
    const { svc, env } = makeSvc();
    const created = await svc.create({ assetId: 'a-1', costParts: 7000 }, ACTOR);
    assert.strictEqual(env.costs.length, 1);
    await svc.remove(created.id, ACTOR);
    assert.strictEqual(env.records.size, 0);
    assert.strictEqual(env.costs.length, 0);
    assert.strictEqual(env.audits.at(-1).action, 'MAINTENANCE_RECORD_DELETED');
  });

  await test('a bad type, an unknown asset/vendor or a negative cost is refused', async () => {
    const { svc } = makeSvc();
    await assert.rejects(() => svc.create({ assetId: 'nope' }, ACTOR), /Unknown asset/);
    await assert.rejects(() => svc.create({ assetId: 'a-1', type: 'MAGIC' }, ACTOR), /Unknown maintenance type/);
    await assert.rejects(() => svc.create({ assetId: 'a-1', vendorId: 'nope' }, ACTOR), /Unknown vendor/);
    await assert.rejects(() => svc.create({ assetId: 'a-1', costParts: -1 }, ACTOR), /must be 0 or more/);
  });

  console.log('\n== preventive schedules (§15) ==');

  await test('next due is derived from last done + interval (day clamped)', async () => {
    const { svc } = makeSvc();
    const row = await svc.createSchedule(
      { assetId: 'a-1', title: 'Aircon gas service', intervalMonths: 6, lastDoneAt: '2026-01-31' },
      ACTOR,
    );
    assert.strictEqual(row.nextDueAt.toISOString().slice(0, 10), '2026-07-31');
    // 31 Aug + 6 months would be 31 Feb → clamped to the last real day
    const clamped = await svc.createSchedule(
      { assetId: 'a-1', title: 'Generator oil', intervalMonths: 6, lastDoneAt: '2026-08-31' },
      ACTOR,
    );
    assert.strictEqual(clamped.nextDueAt.toISOString().slice(0, 10), '2027-02-28');
  });

  await test('marking a schedule done rolls it forward one interval', async () => {
    const { svc, env } = makeSvc();
    const row = await svc.createSchedule(
      { assetId: 'a-1', title: 'Aircon gas service', intervalMonths: 6, nextDueAt: '2026-11-01' },
      ACTOR,
    );
    await svc.completeSchedule(row.id, { doneAt: '2026-11-02' }, ACTOR);
    const after = env.schedules.get(row.id);
    assert.strictEqual(after.lastDoneAt.toISOString().slice(0, 10), '2026-11-02');
    assert.strictEqual(after.nextDueAt.toISOString().slice(0, 10), '2027-05-02');
  });

  await test('the list flags overdue and due-soon schedules', async () => {
    const { svc } = makeSvc();
    const day = 24 * 3600 * 1000;
    const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);
    await svc.createSchedule({ assetId: 'a-1', title: 'Overdue job', intervalMonths: 3, nextDueAt: iso(-5) }, ACTOR);
    await svc.createSchedule({ assetId: 'a-1', title: 'Soon job', intervalMonths: 3, nextDueAt: iso(10) }, ACTOR);
    await svc.createSchedule({ assetId: 'a-1', title: 'Later job', intervalMonths: 3, nextDueAt: iso(90) }, ACTOR);

    const all = await svc.listSchedules({});
    const states = all.map((s: any) => s.dueState).sort();
    assert.deepStrictEqual(states, ['DUE_SOON', 'OK', 'OVERDUE']);

    const due = await svc.listSchedules({ dueOnly: true });
    assert.strictEqual(due.length, 2, 'the 90-day job is not due yet');
    const summary = await svc.summary();
    assert.deepStrictEqual(summary, { overdue: 1, dueSoon: 1, active: 3 });
  });

  await test('a schedule needs a title and a sane interval', async () => {
    const { svc } = makeSvc();
    await assert.rejects(() => svc.createSchedule({ assetId: 'a-1', title: '  ', intervalMonths: 6 }, ACTOR), /title/);
    await assert.rejects(() => svc.createSchedule({ assetId: 'a-1', title: 'x' }, ACTOR), /Interval/);
    await assert.rejects(() => svc.createSchedule({ assetId: 'a-1', title: 'x', intervalMonths: 0 }, ACTOR), /Interval/);
    await assert.rejects(() => svc.createSchedule({ assetId: 'nope', title: 'x', intervalMonths: 6 }, ACTOR), /Unknown asset/);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

void main();
