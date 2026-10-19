/**
 * Gap-analysis follow-up batch (2026-10-19) — Petty cash ledger (§21/§36).
 *
 * REAL PettyCashService with a spy Prisma:
 *  - create: PC-… numbering, TOPUP/EXPENSE audit actions, amount must be
 *    positive, type must be TOPUP|EXPENSE, unknown account → 400.
 *  - list: totals computed (Σ TOPUP − Σ EXPENSE — no balance column, §23),
 *    invalid type filter → 400.
 *  - remove: audited WARNING deletion (no edit of monetary rows).
 *  - csv: header + rows + totals line; comma/quote escaping.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/petty-cash.test.ts
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

const ACTOR = { userId: 'u-1', username: 'finance1' };

function makeEnv() {
  const rows = new Map<string, any>();
  const audits: any[] = [];
  let seq = 0;

  const prisma: any = {
    pettyCashTransaction: {
      create: async ({ data }: any) => {
        const row = { id: `pc-${++seq}`, createdAt: new Date(), ...data };
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: any) => rows.get(where.id) ?? null,
      delete: async ({ where }: any) => {
        const row = rows.get(where.id);
        rows.delete(where.id);
        return row;
      },
      findMany: async ({ where }: any) => {
        let list = [...rows.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
        if (where?.type) list = list.filter((r) => r.type === where.type);
        if (where?.date?.gte) list = list.filter((r) => r.date >= where.date.gte);
        if (where?.date?.lte) list = list.filter((r) => r.date <= where.date.lte);
        return list.map((r) => ({
          ...r,
          account: r.accountId === 'acc-1' ? { id: 'acc-1', code: 'ACC-PETTY', name: 'Petty Cash' } : null,
          createdBy: { username: ACTOR.username, fullName: 'Finance One' },
        }));
      },
    },
    account: {
      findUnique: async ({ where }: any) => (where.id === 'acc-1' ? { id: 'acc-1', name: 'Petty Cash' } : null),
    },
  };
  const audit = { log: async (e: any) => { audits.push(e); } };
  const numbering = { next: async (prefix: string) => `${prefix}-202610-${String(1000 + seq).slice(1)}` };
  return { prisma, audit, numbering, rows, audits };
}

const { PettyCashService } = require('../src/pettycash/pettycash.service');

function makeSvc() {
  const env = makeEnv();
  const svc = new PettyCashService(env.prisma, env.audit, env.numbering);
  return { svc, env };
}

async function main() {
  console.log('\n== create (§21/§36) ==');

  await test('TOPUP gets a PC-… code, defaults date, audits PETTY_CASH_TOPUP', async () => {
    const { svc, env } = makeSvc();
    const row = await svc.create({ type: 'TOPUP', amount: 100000, payee: 'Cashier' }, ACTOR);
    assert.ok(row.code.startsWith('PC-'), `code, got ${row.code}`);
    assert.ok(row.date instanceof Date);
    assert.strictEqual(env.audits[0].action, 'PETTY_CASH_TOPUP');
    assert.strictEqual(env.audits[0].module, 'PETTY_CASH');
    assert.strictEqual(Number(env.audits[0].newValue.amount), 100000);
  });

  await test('EXPENSE audits PETTY_CASH_EXPENSE; account validated', async () => {
    const { svc, env } = makeSvc();
    const row = await svc.create({ type: 'EXPENSE', amount: 5000, accountId: 'acc-1', description: 'Tea, "cups"' }, ACTOR);
    assert.strictEqual(row.accountId, 'acc-1');
    assert.strictEqual(env.audits[0].action, 'PETTY_CASH_EXPENSE');
  });

  await test('validation: bad type / non-positive amount / unknown account → 400', async () => {
    const { svc } = makeSvc();
    await assert.rejects(() => svc.create({ type: 'WITHDRAW', amount: 10 }, ACTOR), /TOPUP or EXPENSE/);
    await assert.rejects(() => svc.create({ type: 'TOPUP', amount: 0 }, ACTOR), /positive/);
    await assert.rejects(() => svc.create({ type: 'EXPENSE', amount: -5 }, ACTOR), /positive/);
    await assert.rejects(() => svc.create({ type: 'EXPENSE', amount: 10, accountId: 'nope' }, ACTOR), /Unknown account/);
  });

  console.log('\n== totals (§23 — computed, never a column) ==');

  await test('balance = Σ TOPUP − Σ EXPENSE over the listing', async () => {
    const { svc } = makeSvc();
    await svc.create({ type: 'TOPUP', amount: 200000 }, ACTOR);
    await svc.create({ type: 'EXPENSE', amount: 30000 }, ACTOR);
    await svc.create({ type: 'EXPENSE', amount: 20000 }, ACTOR);
    const res = await svc.list({});
    assert.strictEqual(res.totals.topup, 200000);
    assert.strictEqual(res.totals.expense, 50000);
    assert.strictEqual(res.totals.balance, 150000);
    assert.strictEqual(res.count, 3);
  });

  await test('type filter + invalid type filter → filtered or 400', async () => {
    const { svc } = makeSvc();
    await svc.create({ type: 'TOPUP', amount: 1000 }, ACTOR);
    await svc.create({ type: 'EXPENSE', amount: 400 }, ACTOR);
    const only = await svc.list({ type: 'EXPENSE' });
    assert.strictEqual(only.count, 1);
    assert.strictEqual(only.totals.balance, -400);
    await assert.rejects(() => svc.list({ type: 'TRANSFER' }), /Unknown petty cash type/);
  });

  console.log('\n== delete (no edit of monetary rows) ==');

  await test('remove deletes the row and audits WARNING', async () => {
    const { svc, env } = makeSvc();
    const row = await svc.create({ type: 'EXPENSE', amount: 700 }, ACTOR);
    const res = await svc.remove(row.id, ACTOR);
    assert.strictEqual(res.success, true);
    assert.strictEqual(env.rows.size, 0);
    const a = env.audits.at(-1);
    assert.strictEqual(a.action, 'PETTY_CASH_DELETED');
    assert.strictEqual(a.severity, 'WARNING');
    await assert.rejects(() => svc.remove('missing', ACTOR), /not found/);
  });

  console.log('\n== csv export (§41) ==');

  await test('header + escaped rows + totals line', async () => {
    const { svc } = makeSvc();
    await svc.create({ type: 'EXPENSE', amount: 1500, payee: 'U Ba, "Ltd"', description: 'Line one' }, ACTOR);
    const csv = await svc.csv({});
    const lines = csv.split('\n');
    assert.ok(lines[0].startsWith('Code,Date,Type,Amount MMK'));
    assert.ok(csv.includes('"U Ba, ""Ltd"""'), 'comma+quote escaping');
    assert.ok(csv.includes('BALANCE=-1500.00'), `totals line, got: ${lines.at(-1)}`);
  });

  const summary = failures.length ? `\nFAILED (${failures.length}): ${failures.join(' | ')}` : `\n${passed} passed, 0 failed`;
  console.log(summary);
  process.exitCode = failures.length ? 1 : 0;
}

main();
