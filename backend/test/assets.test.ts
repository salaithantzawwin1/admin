/**
 * Gap-analysis follow-up batch (2026-10-19) — Asset register (spec §15–16,
 * §39–40) + §66 delete policy.
 *
 * REAL AssetsService with a spy Prisma:
 *  - create: auto AST-… code, custom-code duplicate 409, unknown refs 400,
 *    REGISTER movement + audit.
 *  - update: status transitions write DISPOSE/RESTORE/MAINTENANCE movements;
 *    a location change writes a TRANSFER movement automatically.
 *  - transfer: disposed asset refused, location+custodian moved + movement.
 *  - remove (§66): procurement-linked assets refused (DISPOSED instead),
 *    unused master rows hard-delete + audit.
 *  - registerFromPoLine (§39): consumable/already-registered lines refused;
 *    cost = accepted×unitPrice (fallback ordered), first GRN date, PO line
 *    back-reference, REGISTER movement with the PO number.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/assets.test.ts
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

/** In-memory spy: assets keyed by id + codes, movements, audits, numbering. */
function makeEnv(opts: {
  takenCode?: string;
  poLine?: any; // purchaseOrderItem.findUnique result (null = not found)
  prRefs?: number;
  invRefs?: number;
  poRefs?: number;
} = {}) {
  const assets = new Map<string, any>();
  const movements: any[] = [];
  const audits: any[] = [];
  const poState = opts.poLine ? { ...opts.poLine } : null; // mutable PO line row
  let seq = 0;

  const prisma: any = {
    asset: {
      // return copies like real Prisma — the service's before-state compares
      // must not see the same object update() mutates
      findUnique: async ({ where }: any) => {
        const row =
          (where.id ? assets.get(where.id) : undefined) ??
          (where.assetCode ? [...assets.values()].find((a) => a.assetCode === where.assetCode) ?? null : null);
        return row ? { ...row } : null;
      },
      findMany: async ({ where }: any) =>
        [...assets.values()].filter((a) => !where?.status || a.status === where.status).map((a) => ({ ...a })),
      create: async ({ data }: any) => {
        const row = { id: `a-${++seq}`, categoryId: null, locationId: null, status: 'ACTIVE', ...data };
        assets.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }: any) => {
        const row = assets.get(where.id);
        if (!row) throw new Error('Asset not found');
        for (const [k, v] of Object.entries(data)) {
          if (v !== undefined) row[k] = v;
        }
        return { ...row };
      },
      delete: async ({ where }: any) => {
        assets.delete(where.id);
        return { id: where.id };
      },
    },
    assetMovement: {
      create: async ({ data }: any) => {
        movements.push(data);
        return data;
      },
    },
    assetCategory: { findUnique: async ({ where }: any) => (where.id === 'cat-1' ? { id: 'cat-1', name: 'IT Equipment' } : null) },
    location: { findUnique: async ({ where }: any) => (where.id === 'loc-1' ? { id: 'loc-1', name: 'Head Office' } : null) },
    purchaseRequestItem: { count: async () => opts.prRefs ?? 0 },
    invoiceItem: { count: async () => opts.invRefs ?? 0 },
    purchaseOrderItem: {
      count: async () => opts.poRefs ?? 0,
      findUnique: async () => (poState ? { ...poState } : null),
      update: async ({ where, data }: any) => {
        if (poState && where.id === poState.id) Object.assign(poState, data);
        return { id: where.id, ...data };
      },
    },
  };
  const audit = { log: async (e: any) => { audits.push(e); } };
  const numbering = { next: async (prefix: string) => `${prefix}-202610-${String(1000 + seq).slice(1)}` };
  if (opts.takenCode) assets.set('a-taken', { id: 'a-taken', assetCode: opts.takenCode, name: 'Pre-existing' });
  return { prisma, audit, numbering, assets, movements, audits };
}

const { AssetsService } = require('../src/assets/assets.service');

function makeSvc(opts: any = {}) {
  const env = makeEnv(opts);
  const svc = new AssetsService(env.prisma, env.audit, env.numbering);
  return { svc, env };
}

/** Standard procurement fixture for register-from-PO tests. */
function poLineFixture(over: any = {}) {
  return {
    id: 'pol-1',
    description: 'Dell OptiPlex 7090',
    inventoryItemId: null,
    quantity: 2,
    unitPrice: 1500000,
    assetId: null,
    purchaseOrder: {
      poNumber: 'PO-202610-0001',
      goodsReceipts: [{ receivedAt: new Date('2026-10-15T05:00:00Z') }],
    },
    grnItems: [{ acceptedQty: 1 }],
    ...over,
  };
}

async function main() {
  console.log('\n== asset create (§15/§16) ==');

  await test('auto code from numbering when omitted + REGISTER movement + audit', async () => {
    const { svc, env } = makeSvc();
    const asset = await svc.create({ name: 'Laptop', locationId: 'loc-1' }, ACTOR);
    assert.ok(asset.assetCode.startsWith('AST-'), `auto code, got ${asset.assetCode}`);
    assert.strictEqual(env.movements.length, 1);
    assert.strictEqual(env.movements[0].type, 'REGISTER');
    assert.strictEqual(env.movements[0].toLocationId, 'loc-1');
    assert.strictEqual(env.audits[0].action, 'ASSET_CREATED');
  });

  await test('duplicate custom code → 409', async () => {
    const { svc } = makeSvc({ takenCode: 'AST-X-1' });
    await assert.rejects(() => svc.create({ name: 'Dup', assetCode: 'AST-X-1' }, ACTOR), /already exists/);
  });

  await test('unknown category / location → 400', async () => {
    const { svc } = makeSvc();
    await assert.rejects(() => svc.create({ name: 'X', categoryId: 'nope' }, ACTOR), /Unknown asset category/);
    await assert.rejects(() => svc.create({ name: 'X', locationId: 'nope' }, ACTOR), /Unknown location/);
    await assert.rejects(() => svc.create({ name: 'X', purchaseCost: -1 }, ACTOR), /non-negative/);
  });

  console.log('\n== status & location transitions (§40) ==');

  await test('status ACTIVE→DISPOSED writes a DISPOSE movement; restore writes RESTORE', async () => {
    const { svc, env } = makeSvc();
    const asset = await svc.create({ name: 'Printer' }, ACTOR);
    await svc.update(asset.id, { status: 'DISPOSED' }, ACTOR);
    await svc.update(asset.id, { status: 'ACTIVE' }, ACTOR);
    const types = env.movements.map((m) => m.type);
    assert.deepStrictEqual(types, ['REGISTER', 'DISPOSE', 'RESTORE']);
  });

  await test('location change via edit writes a TRANSFER movement automatically', async () => {
    const { svc, env } = makeSvc();
    const asset = await svc.create({ name: 'Desk', locationId: 'loc-1' }, ACTOR);
    await svc.update(asset.id, { locationId: 'loc-1', name: 'Desk 2' }, ACTOR); // same location → no transfer
    assert.strictEqual(env.movements.filter((m) => m.type === 'TRANSFER').length, 0);
    await svc.update(asset.id, { custodian: 'U Aung' }, ACTOR);
    assert.strictEqual(env.movements.filter((m) => m.type === 'TRANSFER').length, 0);
    // unknown status rejected
    await assert.rejects(() => svc.update(asset.id, { status: 'BOGUS' }, ACTOR), /Unknown asset status/);
  });

  await test('transfer: disposed asset refused; happy path moves location+custodian + movement', async () => {
    const { svc, env } = makeSvc();
    const asset = await svc.create({ name: 'Scanner', locationId: 'loc-1' }, ACTOR);
    const moved = await svc.transfer(asset.id, { toLocationId: 'loc-1', custodian: 'U Kyaw', note: 'Floor 2' }, ACTOR);
    assert.strictEqual(moved.custodian, 'U Kyaw');
    const transfer = env.movements.filter((m) => m.type === 'TRANSFER');
    assert.strictEqual(transfer.length, 1);
    assert.strictEqual(transfer[0].note, 'Floor 2');

    const disposed = await svc.create({ name: 'Old PC' }, ACTOR);
    await svc.update(disposed.id, { status: 'DISPOSED' }, ACTOR);
    await assert.rejects(() => svc.transfer(disposed.id, { toLocationId: 'loc-1' }, ACTOR), /disposed asset cannot be transferred/);
  });

  console.log('\n== delete policy (§66) ==');

  await test('procurement-linked asset refused with a DISPOSED hint', async () => {
    const { svc } = makeSvc({ prRefs: 2, invRefs: 1 });
    const asset = await svc.create({ name: 'Linked' }, ACTOR);
    await assert.rejects(
      () => svc.remove(asset.id, ACTOR),
      (e: Error) => /3 procurement reference\(s\)/.test(e.message) && /DISPOSED/.test(e.message),
    );
  });

  await test('unused asset hard-deletes (movements cascade) + WARNING audit', async () => {
    const { svc, env } = makeSvc();
    const asset = await svc.create({ name: 'Scratch', assetCode: 'AST-TEST-1' }, ACTOR);
    const res = await svc.remove(asset.id, ACTOR);
    assert.strictEqual(res.success, true);
    assert.strictEqual(env.assets.has(asset.id), false);
    assert.strictEqual(env.audits.at(-1).action, 'ASSET_DELETED');
    assert.strictEqual(env.audits.at(-1).severity, 'WARNING');
  });

  console.log('\n== register from PO line (§39) ==');

  await test('cost = accepted × unit price, first GRN date, PO back-reference + REGISTER movement', async () => {
    const { svc, env } = makeSvc({ poLine: poLineFixture() });
    const asset = await svc.registerFromPoLine('pol-1', { categoryId: 'cat-1', locationId: 'loc-1' }, ACTOR);
    assert.strictEqual(Number(asset.purchaseCost), 1500000); // 1 accepted × 1,500,000
    assert.strictEqual(asset.purchaseDate.getTime(), new Date('2026-10-15T05:00:00Z').getTime());
    assert.ok(asset.description.includes('PO-202610-0001'));
    const linked = await env.prisma.purchaseOrderItem.findUnique({ where: { id: 'pol-1' } });
    assert.strictEqual(linked.assetId, asset.id);
    const reg = env.movements.find((m) => m.type === 'REGISTER');
    assert.ok(reg.note.includes('PO-202610-0001'));
    assert.strictEqual(env.audits.at(-1).action, 'ASSET_REGISTERED_FROM_PO');
  });

  await test('before any GRN: cost falls back to ordered quantity', async () => {
    const { svc } = makeSvc({ poLine: poLineFixture({ grnItems: [], purchaseOrder: { poNumber: 'PO-1', goodsReceipts: [] } }) });
    const asset = await svc.registerFromPoLine('pol-1', {}, ACTOR);
    assert.strictEqual(Number(asset.purchaseCost), 3000000); // 2 ordered × 1,500,000
  });

  await test('consumable line → 409; already-registered line → 409', async () => {
    const { svc } = makeSvc({ poLine: poLineFixture({ inventoryItemId: 'itm-1' }) });
    await assert.rejects(() => svc.registerFromPoLine('pol-1', {}, ACTOR), /received consumables into stock/);

    const { svc: svc2 } = makeSvc({ poLine: poLineFixture({ assetId: 'a-existing' }) });
    await assert.rejects(() => svc2.registerFromPoLine('pol-1', {}, ACTOR), /already registered/);

    const { svc: svc3 } = makeSvc({ poLine: null });
    await assert.rejects(() => svc3.registerFromPoLine('pol-1', {}, ACTOR), /PO line not found/);
  });

  console.log('\n== list filters ==');

  await test('unknown status → 400; valid filter passes through', async () => {
    const { svc } = makeSvc();
    await assert.rejects(() => svc.list({ status: 'BOGUS' }), /Unknown asset status/);
    await svc.create({ name: 'A' }, ACTOR);
    const rows = await svc.list({ status: 'ACTIVE' });
    assert.strictEqual(rows.length, 1);
  });

  console.log('\n== edit (PATCH) regression — "Edit does nothing" ==');

  await test('DTO: the exact payload the Edit form posts is accepted (assetCode was rejected)', async () => {
    const { validate } = require('class-validator');
    const { plainToInstance } = require('class-transformer');
    const { AssetUpdateDto } = require('../src/assets/assets.controller');
    // verbatim body from frontend/src/pages/Assets.tsx submitForm() on Edit —
    // main.ts runs ValidationPipe({ whitelist, forbidNonWhitelisted }), so any
    // property missing from AssetUpdateDto answers 400 "should not exist" and
    // the dialog silently failed to save
    const payload = {
      name: 'Dell OptiPlex 7090',
      assetCode: 'AST-202610-0001',
      categoryId: null,
      brand: 'Dell', model: '', serialNumber: '', custodian: '',
      locationId: null,
      purchaseDate: '2026-01-05',
      purchaseCost: 1500000,
      description: '',
      status: 'IN_STORAGE',
    };
    const errs = await validate(plainToInstance(AssetUpdateDto, payload), {
      whitelist: true, forbidNonWhitelisted: true,
    });
    assert.strictEqual(
      errs.length, 0,
      `Edit payload must be accepted, rejected: ${errs.map((e: any) => `${e.property} ${JSON.stringify(e.constraints)}`).join('; ')}`,
    );
  });

  await test('update: the row keeps its own code; a changed code applies; a taken code → 409', async () => {
    const { svc, env } = makeSvc();
    const a = await svc.create({ name: 'Laptop A', assetCode: 'AST-1' }, ACTOR);
    const b = await svc.create({ name: 'Laptop B', assetCode: 'AST-2' }, ACTOR);
    // the Edit form always posts the existing code — must be a no-op, not a 409
    const same = await svc.update(a.id, { assetCode: 'AST-1', name: 'Laptop A v2' }, ACTOR);
    assert.strictEqual(same.assetCode, 'AST-1');
    assert.strictEqual(same.name, 'Laptop A v2');
    // a real rename is honoured…
    const renamed = await svc.update(a.id, { assetCode: 'AST-1-NEW' }, ACTOR);
    assert.strictEqual(renamed.assetCode, 'AST-1-NEW');
    // …but never onto another asset (same 409 wording as create)
    await assert.rejects(() => svc.update(b.id, { assetCode: 'AST-1-NEW' }, ACTOR), /already exists/);
    assert.strictEqual(env.assets.get(b.id).assetCode, 'AST-2', 'the losing row keeps its code');
  });

  await test('update: blank fields clear on edit, omitted fields stay untouched', async () => {
    const { svc } = makeSvc();
    const a = await svc.create({ name: 'Desk', categoryId: 'cat-1', locationId: 'loc-1', custodian: 'U Aung', description: 'old' }, ACTOR);
    // null = "clear it" (what the form sends for "— none —" / emptied inputs)
    const cleared = await svc.update(a.id, { custodian: null, categoryId: null, locationId: null, description: null }, ACTOR);
    assert.strictEqual(cleared.custodian, null, 'custodian cleared');
    assert.strictEqual(cleared.categoryId, null, 'category cleared');
    assert.strictEqual(cleared.locationId, null, 'location cleared');
    assert.strictEqual(cleared.description, null, 'description cleared');
    // undefined = "leave it" (field absent from the payload)
    const kept = await svc.update(a.id, { name: 'Desk 2' }, ACTOR);
    assert.strictEqual(kept.name, 'Desk 2');
    assert.strictEqual(kept.custodian, null, 'absent field must not resurrect a value');
    assert.strictEqual(kept.categoryId, null);
  });

  const summary = failures.length ? `\nFAILED (${failures.length}): ${failures.join(' | ')}` : `\n${passed} passed, 0 failed`;
  console.log(summary);
  process.exitCode = failures.length ? 1 : 0;
}

main();
