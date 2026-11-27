/**
 * The audit trail is an admin record: GET /audit-logs, /audit-logs/filters,
 * /audit-logs/export.csv and /audit-logs/:id must all require audit.read.
 *
 * The controller carried @RequirePermissions(AUDIT_READ) but listed only
 * JwtAuthGuard in @UseGuards, so the metadata was inert and any signed-in user
 * could page through — and export — the whole trail. The metadata check alone
 * cannot catch that, so the guard's presence in @UseGuards is asserted too.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/audit-logs-guard.test.ts
 */
const assert = require('assert');
const { ForbiddenException } = require('@nestjs/common');
const { PERMISSIONS } = require('../src/auth/permissions');
const { PermissionsGuard, PERMISSIONS_KEY } = require('../src/auth/permissions.guard');
const { AuditController } = require('../src/audit/audit.controller');

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

/** Every route the controller exposes for reading the trail. */
const HANDLERS = ['findAll', 'filters', 'exportCsv', 'findOne'];

(async () => {
  const controller: any = new AuditController({} as any);

  // reads real decorator metadata, in Nest's handler-then-class order
  const reflector = {
    getAllAndOverride: (key: string, targets: any[]) => {
      for (const t of targets) {
        const v = Reflect.getMetadata(key, t);
        if (v) return v;
      }
      return undefined;
    },
  };
  const ctx = (handler: string, user: any = { id: 'u-1' }) =>
    ({
      getHandler: () => controller[handler],
      getClass: () => AuditController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as any;

  await test('PermissionsGuard is attached to the controller (metadata alone is inert)', () => {
    const guards = Reflect.getMetadata('__guards__', AuditController) ?? [];
    assert.ok(
      guards.includes(PermissionsGuard),
      'AuditController must list PermissionsGuard in @UseGuards, otherwise audit.read is never checked',
    );
  });

  await test('audit.read is declared at class level, so every route needs it', () => {
    const required = Reflect.getMetadata(PERMISSIONS_KEY, AuditController);
    assert.deepStrictEqual(required, [PERMISSIONS.AUDIT_READ]);
    for (const h of HANDLERS) {
      assert.deepStrictEqual(
        reflector.getAllAndOverride(PERMISSIONS_KEY, [controller[h], AuditController]),
        [PERMISSIONS.AUDIT_READ],
        `${h} must resolve audit.read`,
      );
    }
  });

  await test('every audit route refuses a signed-in caller without audit.read', async () => {
    const guard = new PermissionsGuard(
      reflector as any,
      { forUser: async () => ['invoices.read', 'attachments.use', 'pettycash.read'] } as any,
    );
    for (const h of HANDLERS) {
      await assert.rejects(
        () => guard.canActivate(ctx(h)),
        (e: any) => e instanceof ForbiddenException,
        `${h} must refuse a caller without audit.read`,
      );
    }
  });

  await test('every audit route admits a caller holding audit.read', async () => {
    const guard = new PermissionsGuard(reflector as any, { forUser: async () => ['audit.read'] } as any);
    for (const h of HANDLERS) {
      assert.strictEqual(await guard.canActivate(ctx(h)), true, `${h} allows audit.read`);
    }
  });

  await test('a request without a user is rejected before any permission lookup', async () => {
    let looked = false;
    const guard = new PermissionsGuard(
      reflector as any,
      { forUser: async () => { looked = true; return ['audit.read']; } } as any,
    );
    assert.strictEqual(await guard.canActivate(ctx('findAll', null)), false);
    assert.strictEqual(looked, false, 'anonymous request must not reach PermissionsService');
  });

  const summary = failures.length ? `\nFAILED (${failures.length}): ${failures.join(' | ')}` : `\n${passed} passed, 0 failed`;
  console.log(summary);
  process.exitCode = failures.length ? 1 : 0;
})();
