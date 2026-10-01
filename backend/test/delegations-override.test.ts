/**
 * Checks for the approval-delegation create path — the contract between the
 * Delegations web form and DelegationsService.create, focused on the overlap
 * guard and its overrideOverlap escape hatch ("Save anyway" in the UI).
 *
 * Layers covered (same pattern as fleet-vehicle-creation.test.ts):
 *  1. DTO validation contract — plainToInstance()/validateSync() exactly like
 *     Nest's global ValidationPipe (transform + whitelist), runs the REAL
 *     CreateDelegationDto.
 *  2. Service behaviour — REAL DelegationsService with a mock Prisma: the exact
 *     error strings the web UI attributes to fields, the overlap query shape,
 *     and the override flag allowing an intentional overlap through.
 *
 * The exact messages matter: ApiError surfaces them verbatim and the UI keys
 * the orange "Save anyway" warning box on the overlap string specifically.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/delegations-override.test.ts
 */
const assert = require('assert');

// ------------------------------------------------------------------ helpers
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

// mirrors Nest's global ValidationPipe (main.ts: transform + whitelist)
function validationMessages(plain: object): string[] {
  const { plainToInstance } = require('class-transformer');
  const { validateSync } = require('class-validator');
  const { CreateDelegationDto } = require('../src/workflow/dto/delegation.dto');
  const dto = plainToInstance(CreateDelegationDto, plain);
  const errors = validateSync(dto, { whitelist: true });
  return errors.flatMap((e: any) => (e.constraints ? Object.values(e.constraints) : [])) as string[];
}

const ACTOR = { userId: 'u-admin', username: 'admin1' };
const DELEGATE = { id: 'u-head', username: 'head1', fullName: 'Department Head', status: 'ACTIVE' };

/** Mock Prisma: fresh DB each call; opts.point at an existing overlap row or a
 *  custom target-user finder. The create spy is ALWAYS owned by the harness so
 *  every test can assert on what was written. */
function makeService(
  opts: { overlap?: any; userFind?: (args: any) => any; onOverlapQuery?: (args: any) => any } = {},
  spies?: { created?: any[]; notified?: any[]; audited?: any[] },
) {
  const { DelegationsService } = require('../src/workflow/delegations.service');
  const created = spies?.created ?? [];
  const notified = spies?.notified ?? [];
  const audited = spies?.audited ?? [];
  const prisma: any = {
    user: {
      findUnique: opts.userFind ?? (async (args: any) => (args.where.id === 'u-head' ? DELEGATE : null)),
    },
    approvalDelegation: {
      findFirst: opts.onOverlapQuery ?? (async () => opts.overlap ?? null),
      create: async (args: any) => {
        created.push(args);
        return { id: 'dlg-1', ...args.data };
      },
    },
  };
  const svc = new DelegationsService(
    prisma,
    { notify: async (n: any) => { notified.push(n); } } as any, // notifications
    { log: async (a: any) => { audited.push(a); } } as any, // audit
  );
  return { svc, prisma, created, notified, audited };
}

/** Overlapping ACTIVE delegation returned by findFirst when a test wants one. */
const EXISTING_OVERLAP = { id: 'dlg-old', fromUserId: ACTOR.userId, toUserId: DELEGATE.id, status: 'ACTIVE' };

const BASE = { toUserId: 'u-head', startAt: '2026-10-05T09:00:00+06:30', endAt: '2026-10-05T17:00:00+06:30' };

async function main() {
  // ============================== 1) DTO validation contract ==============================
  console.log('\n-- CreateDelegationDto validation contract (as the web form submits) --');

  await test('a VALID payload (with reason) validates cleanly', () => {
    const msgs = validationMessages({ ...BASE, reason: 'Attending offsite meeting' });
    assert.deepStrictEqual(msgs, [], `unexpected rejections: ${msgs.join(' | ')}`);
  });

  await test('overrideOverlap omitted (normal form submit) validates — the flag stays optional', () => {
    const msgs = validationMessages(BASE);
    assert.deepStrictEqual(msgs, [], `unexpected rejections: ${msgs.join(' | ')}`);
  });

  await test('overrideOverlap: true passes through the DTO (the Save-anyway path)', () => {
    const { plainToInstance } = require('class-transformer');
    const { validateSync } = require('class-validator');
    const { CreateDelegationDto } = require('../src/workflow/dto/delegation.dto');
    const dto = plainToInstance(CreateDelegationDto, { ...BASE, overrideOverlap: true });
    const errors = validateSync(dto, { whitelist: true });
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(dto.overrideOverlap, true, 'overrideOverlap must survive transformation as boolean true');
  });

  await test('overrideOverlap must be a boolean — strings are rejected', () => {
    const msgs = validationMessages({ ...BASE, overrideOverlap: 'yes' });
    assert.ok(msgs.some((m) => /overrideOverlap must be a boolean/.test(m)), `expected boolean violation, got: ${msgs.join(' | ')}`);
  });

  await test('ISO8601 dates enforced and reason capped at 500 chars', () => {
    let msgs = validationMessages({ ...BASE, startAt: 'tomorrow 9am', endAt: 'next friday' });
    assert.ok(msgs.length >= 2, 'bad date strings must be rejected');
    msgs = validationMessages({ ...BASE, reason: 'x'.repeat(501) });
    assert.ok(msgs.some((m) => /reason must be shorter than or equal to 500/.test(m)), '501-char reason must be rejected');
  });

  // ============================== 2) Service behaviour (mock Prisma) ==============================
  console.log('\n-- DelegationsService.create with mock Prisma --');

  await test("NaN dates → 'Invalid dates'", async () => {
    const { svc } = makeService();
    await assert.rejects(
      () => svc.create({ ...BASE, startAt: 'not-a-date' }, ACTOR),
      (e: any) => e.message === 'Invalid dates',
    );
  });

  await test("startAt === endAt → 'startAt must be before endAt' (zero-length window)", async () => {
    const { svc } = makeService();
    await assert.rejects(
      () => svc.create({ ...BASE, endAt: BASE.startAt }, ACTOR),
      (e: any) => e.message === 'startAt must be before endAt',
    );
  });

  await test("'Cannot delegate to yourself' — checked before the target lookup", async () => {
    let lookedUp = false;
    const { svc } = makeService({ userFind: async () => { lookedUp = true; return null; } });
    await assert.rejects(
      () => svc.create({ ...BASE, toUserId: ACTOR.userId }, ACTOR),
      (e: any) => e.message === 'Cannot delegate to yourself',
    );
    assert.strictEqual(lookedUp, false, 'self-delegate must fail before any user query');
  });

  await test("'Delegate user not found or inactive' — unknown id and INACTIVE user", async () => {
    const { svc } = makeService();
    await assert.rejects(
      () => svc.create({ ...BASE, toUserId: 'u-ghost' }, ACTOR),
      (e: any) => e.message === 'Delegate user not found or inactive',
    );
    const inactive = makeService({
      userFind: async () => ({ ...DELEGATE, status: 'INACTIVE' }),
    });
    await assert.rejects(
      () => inactive.svc.create(BASE, ACTOR),
      (e: any) => e.message === 'Delegate user not found or inactive',
    );
  });

  await test('overlap query shape: same fromUserId, status ACTIVE, windows touching (lte endAt / gte startAt)', async () => {
    const queries: any[] = [];
    const { svc } = makeService({
      onOverlapQuery: async (args: any) => {
        queries.push(args);
        return null;
      },
    });
    await svc.create(BASE, ACTOR);
    assert.strictEqual(queries.length, 1, 'exactly one overlap probe per create');
    const where = queries[0].where;
    assert.strictEqual(where.fromUserId, ACTOR.userId, 'overlap is scoped to the DELEGATING user');
    assert.strictEqual(where.status, 'ACTIVE', 'only ACTIVE delegations can overlap');
    // window overlap: existing.startAt <= new endAt AND existing.endAt >= new startAt
    assert.strictEqual(where.startAt.lte.getTime(), new Date(BASE.endAt).getTime(), 'startAt.lte = new endAt');
    assert.strictEqual(where.endAt.gte.getTime(), new Date(BASE.startAt).getTime(), 'endAt.gte = new startAt');
  });

  await test('overlap + no flag → rejected with the EXACT string the UI keys the Save-anyway box on', async () => {
    const { svc, created } = makeService({ overlap: EXISTING_OVERLAP });
    await assert.rejects(
      () => svc.create(BASE, ACTOR),
      (e: any) => {
        assert.strictEqual(e.message, 'You already have a delegation covering this period');
        assert.strictEqual(e.status, 400, 'must be a BadRequestException');
        return true;
      },
    );
    assert.strictEqual(created.length, 0, 'nothing may be written when the overlap is rejected');
  });

  await test('overlap + overrideOverlap: true → create proceeds (intentional double coverage)', async () => {
    const { svc, created } = makeService({ overlap: EXISTING_OVERLAP });
    const delegation = await svc.create({ ...BASE, overrideOverlap: true }, ACTOR);
    assert.strictEqual(delegation.id, 'dlg-1');
    assert.strictEqual(created.length, 1, 'approvalDelegation.create must be called exactly once');
    assert.strictEqual(created[0].data.fromUserId, ACTOR.userId, 'delegation created FROM the actor');
    assert.strictEqual(created[0].data.toUserId, 'u-head', 'delegation created TO the chosen user');
    assert.strictEqual(created[0].data.reason, undefined, 'no reason field when the form omits it');
  });

  await test('the override create still notifies the delegate AND writes the audit trail', async () => {
    const { svc, notified, audited } = makeService({ overlap: EXISTING_OVERLAP });
    await svc.create({ ...BASE, overrideOverlap: true, reason: 'Flying to Mandalay' }, ACTOR);
    assert.strictEqual(notified.length, 1, 'delegate gets exactly one notification');
    assert.strictEqual(notified[0].userId, 'u-head');
    assert.strictEqual(notified[0].type, 'DELEGATED');
    assert.ok(notified[0].title.includes('delegation'), `notification title: ${notified[0].title}`);
    assert.ok(notified[0].body.includes('admin1'), 'notification body names the delegating user');
    assert.strictEqual(audited.length, 1, 'exactly one audit entry');
    assert.strictEqual(audited[0].action, 'DELEGATION_CREATED');
    assert.strictEqual(audited[0].module, 'WORKFLOW');
    assert.strictEqual(audited[0].recordId, 'dlg-1');
  });

  await test('flag unset and NO overlap → normal create (control case for the override pair)', async () => {
    const { svc, created, notified } = makeService(); // findFirst → null
    const delegation = await svc.create({ ...BASE, reason: 'Annual leave' }, ACTOR);
    assert.strictEqual(delegation.id, 'dlg-1');
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].data.reason, 'Annual leave');
    assert.strictEqual(notified.length, 1);
  });

  await test('overrideOverlap: false behaves exactly like omitting the flag', async () => {
    const { svc } = makeService({ overlap: EXISTING_OVERLAP });
    await assert.rejects(
      () => svc.create({ ...BASE, overrideOverlap: false }, ACTOR),
      (e: any) => e.message === 'You already have a delegation covering this period',
    );
  });

  const total = passed + failures.length;
  console.log(`\n${total} checks, ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error('FAILED:\n' + failures.map((f) => ' - ' + f).join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
