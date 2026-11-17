/**
 * The announcement end-date rule, on both write paths and nowhere else.
 *
 * The web client mirrors this rule (endRule() in Announcements.tsx) and decides
 * which field to flag from the error `code`. Three things this file pins down:
 *
 *   1. assertEndDate's three rejections — before the send date, in the past on a
 *      live notice, and an unparseable date — each with its stable code;
 *   2. create() and update() ask the SAME helper, so a change to one path cannot
 *      leave the other behind (the drift that let a PATCH store a notice that
 *      expires before it is sent);
 *   3. the cases that must stay allowed: an expiry in the past on a draft, a
 *      clear (null), and an untouched expiry on an edit.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/announcement-end-date.test.ts
 */
const assert = require('assert');
const { AnnouncementsService } = require('../src/announcements/announcements.service');

let passed = 0;
const failures: string[] = [];
const queue: [string, () => unknown][] = [];
function test(name: string, fn: () => unknown) {
  queue.push([name, fn]);
}

const ACTOR = { userId: 'u-1', username: 'admin' };
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.now();
const YESTERDAY = iso(NOW - DAY);
const TOMORROW = iso(NOW + DAY);
const NEXT_WEEK = iso(NOW + 7 * DAY);
const LONG_AGO = iso(NOW - 30 * DAY);

/** The audience is 'ALL' everywhere, so no org lookup is needed. */
const TARGETS = [{ targetType: 'ALL' }];

/** A notice row as update() reads it. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'ann-1',
    code: 'ANN-202611-0001',
    title: 'Generator test',
    content: '<p>body</p>',
    category: 'GENERAL',
    priority: 'NORMAL',
    status: 'PUBLISHED',
    publishAt: new Date(LONG_AGO),
    endAt: null,
    requiresAck: false,
    createdById: ACTOR.userId,
    targets: [],
    ...over,
  };
}

/** Prisma stand-in: records what the service tried to write. */
function makeService(existing: any) {
  const writes: any[] = [];
  const audits: any[] = [];
  const prisma: any = {
    announcement: {
      findUnique: async () => existing,
      update: async (args: any) => {
        writes.push(args);
        return { ...existing, ...args.data, targets: [] };
      },
      create: async (args: any) => {
        writes.push(args);
        return { id: 'ann-new', ...args.data, targets: [] };
      },
    },
  };
  const svc = new AnnouncementsService(
    prisma,
    { next: async () => 'ANN-202611-0099' } as any,
    {} as any,
    { log: async (e: any) => audits.push(e) } as any,
    {} as any,
  );
  return { svc, writes, audits };
}

/** The code a call was refused with, or null when it was allowed through. */
async function judge(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e: any) {
    const body = typeof e.getResponse === 'function' ? e.getResponse() : null;
    return body?.code ?? `THREW:${e?.message}`;
  }
}

/** Run a call expected to be refused; return the HTTP status and body. */
async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e: any) {
    return {
      status: typeof e.getStatus === 'function' ? e.getStatus() : null,
      body: typeof e.getResponse === 'function' ? e.getResponse() : null,
      message: e.message,
    };
  }
  throw new Error('expected the service to refuse this, but it resolved');
}

// ---------------------------------------------------------------- create()

test('create refuses an expiry before the send date, with END_BEFORE_SEND', async () => {
  const { svc, writes } = makeService(null);
  const r = await refusal(() =>
    svc.create({ title: 'T', content: '<p>c</p>', publishAt: TOMORROW, endAt: iso(NOW + DAY / 2), targets: TARGETS }, ACTOR),
  );
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'END_BEFORE_SEND');
  assert.strictEqual(r.body.message, 'End date must be after the send date');
  assert.strictEqual(writes.length, 0, 'nothing may be written when the rule refuses');
});

test('create refuses an expiry equal to the send date (not "after")', async () => {
  const { svc } = makeService(null);
  const at = TOMORROW;
  const r = await refusal(() => svc.create({ title: 'T', content: '<p>c</p>', publishAt: at, endAt: at, targets: TARGETS }, ACTOR));
  assert.strictEqual(r.body.code, 'END_BEFORE_SEND');
});

test('create refuses an unparseable expiry with END_AT_INVALID', async () => {
  const { svc } = makeService(null);
  const r = await refusal(() =>
    svc.create({ title: 'T', content: '<p>c</p>', publishAt: TOMORROW, endAt: 'not a date', targets: TARGETS }, ACTOR),
  );
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'END_AT_INVALID');
});

test('create accepts an expiry after the send date', async () => {
  const { svc, writes } = makeService(null);
  const created = await svc.create({ title: 'T', content: '<p>c</p>', publishAt: TOMORROW, endAt: NEXT_WEEK, targets: TARGETS }, ACTOR);
  assert.strictEqual(writes.length, 1, 'the notice is written');
  assert.strictEqual(new Date(created.endAt).toISOString(), NEXT_WEEK);
});

test('create accepts a past expiry on a draft — it is not live yet', async () => {
  const { svc, writes } = makeService(null);
  await svc.create({ title: 'T', content: '<p>c</p>', endAt: YESTERDAY, targets: TARGETS }, ACTOR);
  assert.strictEqual(writes.length, 1);
});

test('create never applies the live rule, even with a past send date', async () => {
  // status would be DRAFT even though publishAt is in the past, so an expiry
  // between the two is a draft that is already over — allowed until published.
  const { svc, writes } = makeService(null);
  await svc.create({ title: 'T', content: '<p>c</p>', publishAt: LONG_AGO, endAt: YESTERDAY, targets: TARGETS }, ACTOR);
  assert.strictEqual(writes.length, 1);
});

// ---------------------------------------------------------------- update()

test('update refuses an expiry in the past on a PUBLISHED notice with END_IN_PAST', async () => {
  const { svc, writes } = makeService(row({ status: 'PUBLISHED' }));
  const r = await refusal(() => svc.update('ann-1', { endAt: YESTERDAY }, ACTOR));
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'END_IN_PAST');
  assert.strictEqual(writes.length, 0, 'a refused edit writes nothing');
});

test('update refuses an expiry before the send date on a draft with END_BEFORE_SEND', async () => {
  const { svc } = makeService(row({ status: 'DRAFT', publishAt: new Date(TOMORROW) }));
  const r = await refusal(() => svc.update('ann-1', { endAt: iso(NOW + DAY / 2) }, ACTOR));
  assert.strictEqual(r.body.code, 'END_BEFORE_SEND');
});

test('update refuses an unparseable expiry with END_AT_INVALID', async () => {
  const { svc } = makeService(row({ status: 'DRAFT' }));
  const r = await refusal(() => svc.update('ann-1', { endAt: 'soon-ish' }, ACTOR));
  assert.strictEqual(r.body.code, 'END_AT_INVALID');
});

test('update accepts a future expiry and stores it', async () => {
  const { svc, writes } = makeService(row({ status: 'PUBLISHED' }));
  await svc.update('ann-1', { endAt: NEXT_WEEK }, ACTOR);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(new Date(writes[0].data.endAt).toISOString(), NEXT_WEEK);
});

test('update accepts a clear (null), so a notice can be given no expiry', async () => {
  const { svc, writes } = makeService(row({ status: 'PUBLISHED', endAt: new Date(NEXT_WEEK) }));
  await svc.update('ann-1', { endAt: null }, ACTOR);
  assert.strictEqual(writes[0].data.endAt, null);
});

test('update accepts an untouched, already-passed expiry on a published notice', async () => {
  // the client omits an unchanged expiry, so this PATCH carries no endAt at all —
  // it must not be judged, or editing the text of a just-expired notice is blocked
  const { svc, writes } = makeService(row({ status: 'PUBLISHED', endAt: new Date(YESTERDAY) }));
  await svc.update('ann-1', { title: 'New title' }, ACTOR);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].data.endAt, undefined, 'the stored expiry is left alone');
});

test('update still refuses an edited expiry on a live notice whose fix expired', async () => {
  // same notice, but now the admin actually typed a past date: refused
  const { svc } = makeService(row({ status: 'PUBLISHED', endAt: new Date(YESTERDAY) }));
  const r = await refusal(() => svc.update('ann-1', { endAt: iso(NOW - DAY / 2) }, ACTOR));
  assert.strictEqual(r.body.code, 'END_IN_PAST');
});

test('update refuses every edit to an EXPIRED notice', async () => {
  const { svc } = makeService(row({ status: 'EXPIRED', endAt: new Date(LONG_AGO) }));
  const r = await refusal(() => svc.update('ann-1', { title: 'late fix' }, ACTOR));
  assert.strictEqual(r.status, 409);
  assert.match(String(r.message), /Expired announcements cannot be edited/);
});

// ----------------------------------------------- both paths, one rule

test('create and update agree on every case they share', async () => {
  // If the rule is ever written twice, this is the test that fails: the same
  // (publishAt, endAt) pair must be judged the same way on both paths.
  const cases: { publishAt: string; endAt: string; code: string | null }[] = [
    { publishAt: TOMORROW, endAt: YESTERDAY, code: 'END_BEFORE_SEND' },
    { publishAt: TOMORROW, endAt: TOMORROW, code: 'END_BEFORE_SEND' },
    { publishAt: LONG_AGO, endAt: YESTERDAY, code: null }, // draft: allowed by both
    { publishAt: LONG_AGO, endAt: NEXT_WEEK, code: null },
    { publishAt: TOMORROW, endAt: NEXT_WEEK, code: null },
  ];

  for (const c of cases) {
    const created = makeService(null);
    const createCode = await judge(() =>
      created.svc.create({ title: 'T', content: '<p>c</p>', publishAt: c.publishAt, endAt: c.endAt, targets: TARGETS }, ACTOR),
    );

    // update() on a DRAFT sees the same publishAt and is never live, exactly like create()
    const edited = makeService(row({ status: 'DRAFT', publishAt: new Date(c.publishAt) }));
    const updateCode = await judge(() => edited.svc.update('ann-1', { endAt: c.endAt }, ACTOR));

    assert.deepStrictEqual(
      { create: createCode, update: updateCode },
      { create: c.code, update: c.code },
      `publishAt=${c.publishAt} endAt=${c.endAt}`,
    );
  }
});

test('every refusal carries a code the client can map, never just a sentence', async () => {
  const checks = [
    (svc: any) => svc.create({ title: 'T', content: '<p>c</p>', publishAt: TOMORROW, endAt: YESTERDAY, targets: TARGETS }, ACTOR),
    (svc: any) => svc.update('ann-1', { endAt: 'nope' }, ACTOR),
    (svc: any) => svc.update('ann-1', { endAt: YESTERDAY }, ACTOR),
  ];
  for (const call of checks) {
    const { svc } = makeService(row({ status: 'PUBLISHED' }));
    const r: any = await refusal(() => call(svc));
    assert.ok(['END_BEFORE_SEND', 'END_IN_PAST', 'END_AT_INVALID'].includes(r.body?.code), `got ${JSON.stringify(r.body)}`);
  }
});

// ---------------------------------------------------------------- runner

(async () => {
  for (const [name, fn] of queue) {
    try {
      await fn();
      passed++;
      console.log(`  \u2713 ${name}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${name}: ${msg}`);
      console.error(`  \u2717 ${name}\n    ${msg}`);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
})();
