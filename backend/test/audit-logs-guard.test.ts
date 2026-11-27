/**
 * The audit trail must require audit.read on every route: GET /audit-logs,
 * /audit-logs/filters, /audit-logs/export.csv and /audit-logs/:id.
 *
 * AuditController declares @RequirePermissions(AUDIT_READ) at class level but
 * lists only JwtAuthGuard in @UseGuards — the requirement is enforced by the
 * PermissionsGuard registered app-wide as an APP_GUARD in AppModule. That is
 * easy to overlook (and easy to delete), so this test pins both halves:
 *  - the controller still declares audit.read for every handler, and
 *  - AppModule still registers PermissionsGuard as a global guard.
 * It then exercises the guard itself: a signed-in caller without audit.read is
 * refused on every route, a holder is admitted, an anonymous one is rejected.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/audit-logs-guard.test.ts
 */
const assert = require('assert');
const { ForbiddenException } = require('@nestjs/common');
const { APP_GUARD } = require('@nestjs/core');
const { PERMISSIONS } = require('../src/auth/permissions');
const { PermissionsGuard, PERMISSIONS_KEY } = require('../src/auth/permissions.guard');
const { AuditController } = require('../src/audit/audit.controller');
const { AppModule } = require('../src/app.module');

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

  // resolves metadata the way Nest does: handler first, then controller class
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

  await test('audit.read is declared at class level, so every route needs it', () => {
    assert.deepStrictEqual(Reflect.getMetadata(PERMISSIONS_KEY, AuditController), [PERMISSIONS.AUDIT_READ]);
    for (const h of HANDLERS) {
      assert.deepStrictEqual(
        reflector.getAllAndOverride(PERMISSIONS_KEY, [controller[h], AuditController]),
        [PERMISSIONS.AUDIT_READ],
        `${h} must resolve audit.read`,
      );
    }
  });

  await test('AppModule enforces the metadata with a global PermissionsGuard', () => {
    const providers = Reflect.getMetadata('providers', AppModule) ?? [];
    assert.ok(
      providers.some((p: any) => p?.provide === APP_GUARD && p?.useClass === PermissionsGuard),
      'without the APP_GUARD registration @RequirePermissions on AuditController is inert',
    );
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

  await test('an anonymous request is rejected before any permission lookup', async () => {
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
