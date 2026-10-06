/**
 * Unit tests for the Telegram join-request Delete feature.
 *
 * Drives the REAL TelegramService.deleteJoin with a mock Prisma — the same
 * spy-style harness as test/telegram-car-request.test.ts. No DB, no HTTP, no
 * Telegram API (deleteJoin never calls the Bot API).
 *
 * Guards:
 *  - PENDING / REJECTED / SUPERSEDED drafts can be deleted permanently
 *  - APPROVED joins are refused until the chat is unbound
 *  - unknown join ids are refused
 *  - every deletion writes a TELEGRAM_JOIN_DELETED audit row with the chat id
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/telegram-joins.test.ts
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

function makeHarness(joinRow: any) {
  const calls: { op: string; args: any }[] = [];
  const auditRows: any[] = [];
  const prisma: any = {
    telegramJoinRequest: {
      findUnique: async (args: any) => {
        calls.push({ op: 'findUnique', args });
        return joinRow;
      },
      delete: async (args: any) => {
        calls.push({ op: 'delete', args });
        return joinRow;
      },
    },
  };
  const audit: any = { log: async (row: any) => { auditRows.push(row); } };
  const TelegramServiceMod = require('../src/telegram/telegram.service');
  const svc: any = new TelegramServiceMod.TelegramService(prisma, audit, { usersWithPermissions: async () => [] }, { publish: () => 0 });
  return { svc, calls, auditRows };
}

(async () => {
  console.log('\n— Telegram join delete —');

  await test('deleteJoin removes a PENDING draft and audits it with the chat id', async () => {
    const row = { id: 'join-1', chatId: '555000111', status: 'PENDING', tgUsername: 'hyundal', displayName: 'hyundal' };
    const { svc, calls, auditRows } = makeHarness(row);
    const res = await svc.deleteJoin('join-1', { userId: 'admin-1', username: 'sysadmin' });
    assert.deepStrictEqual(res, { ok: true });
    assert.strictEqual(calls.filter((c) => c.op === 'delete').length, 1, 'one hard delete');
    assert.strictEqual(calls.find((c) => c.op === 'delete').args.where.id, 'join-1');
    const auditRow = auditRows[0];
    assert.ok(auditRow, 'audit row written');
    assert.strictEqual(auditRow.action, 'TELEGRAM_JOIN_DELETED');
    assert.strictEqual(auditRow.module, 'SETTINGS');
    assert.strictEqual(auditRow.recordId, 'join-1');
    assert.strictEqual(auditRow.oldValue.chatId, '555000111', 'chat id preserved for the bind-history timeline');
    assert.strictEqual(auditRow.oldValue.status, 'PENDING');
  });

  await test('deleteJoin refuses APPROVED joins until the chat is unbound', async () => {
    const row = { id: 'join-2', chatId: '555000222', status: 'APPROVED', tgUsername: null, displayName: 'Linked person' };
    const { svc, calls, auditRows } = makeHarness(row);
    await assert.rejects(
      () => svc.deleteJoin('join-2', { userId: 'admin-1', username: 'sysadmin' }),
      /unbind it first/i,
    );
    assert.strictEqual(calls.filter((c) => c.op === 'delete').length, 0, 'no delete issued');
    assert.strictEqual(auditRows.length, 0, 'nothing audited');
  });

  await test('deleteJoin allows REJECTED drafts', async () => {
    const row = { id: 'join-3', chatId: '555000333', status: 'REJECTED', tgUsername: 'spam', displayName: 'spam' };
    const { svc, calls } = makeHarness(row);
    const res = await svc.deleteJoin('join-3', { userId: 'admin-1', username: 'sysadmin' });
    assert.deepStrictEqual(res, { ok: true });
    assert.strictEqual(calls.filter((c) => c.op === 'delete').length, 1);
  });

  await test('deleteJoin refuses unknown join ids', async () => {
    const { svc, calls, auditRows } = makeHarness(null);
    await assert.rejects(
      () => svc.deleteJoin('join-missing', { userId: 'admin-1', username: 'sysadmin' }),
      /not found/i,
    );
    assert.strictEqual(calls.filter((c) => c.op === 'delete').length, 0);
    assert.strictEqual(auditRows.length, 0);
  });

  await test('deleteJoin keeps the bind-history aware: deleted rows appear via TELEGRAM_JOIN_DELETED in chatHistory inputs', async () => {
    // chatHistory resolves this action to a human label — guard the mapping
    const row = { id: 'join-4', chatId: '555000444', status: 'PENDING', tgUsername: null, displayName: null };
    const { svc } = makeHarness(row);
    await svc.deleteJoin('join-4', { userId: 'admin-1', username: 'sysadmin' });
    const prismaStub: any = {
      auditLog: {
        findMany: async () => [
          { createdAt: new Date(), action: 'TELEGRAM_JOIN_DELETED', username: 'sysadmin', newValue: null, oldValue: { chatId: '555000444' } },
        ],
      },
    };
    (svc as any).prisma = prismaStub;
    const rows = await svc.chatHistory('555000444');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].action, 'TELEGRAM_JOIN_DELETED');
    assert.match(rows[0].label, /Deleted by Administration/);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('harness crash:', e);
  process.exit(1);
});
