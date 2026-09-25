/**
 * Unit tests for the RBAC deny-memory + dedicated read gates.
 *
 * Covers the 2026-09 access-control fixes:
 *   1. seedPermissions() must never re-grant a code that was deliberately
 *      revoked (deny-memory: static DENIED_BY_ROLE + role_permissions_denied).
 *   2. syncDenyMemoryOnSave() records matrix revocations and clears re-grants.
 *   3. PermissionsGuard accepts flat codes + any-of sets (OR of ANDs) and
 *      denies when no set is fully held.
 *   4. Controller metadata: directory endpoints are gated by the dedicated
 *      matrix-editable codes (employees.read / departments.read /
 *      suppliers.read), NOT by legacy org.read / inventory.read OR-legs.
 *
 * Mock-Prisma spy harness, no DB, no HTTP — same style as cars-fixes.test.ts.
 * Run:  cd backend && node -r ts-node/register/transpile-only test/rbac-deny-memory.test.ts
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

/** In-memory emulation of the prisma models the seeder touches. */
function makePrisma() {
  const permissions = new Map<string, { id: string; code: string; description?: string }>();
  const roles = new Map<string, { id: string; name: string }>();
  const rolePermissions = new Set<string>(); // `${roleId}|${permissionId}`
  const denied = new Set<string>(); // `${roleId}|${permissionId}`

  let permSeq = 0;
  for (const code of [
    'users.read', 'users.manage', 'org.read', 'org.manage',
    'departments.read', 'departments.manage', 'employees.read', 'employees.manage',
    'requests.read.own', 'requests.create', 'suppliers.read', 'suppliers.manage',
    'inventory.read', 'inventory.manage', 'announcements.read',
  ]) {
    permissions.set(code, { id: `p-${++permSeq}`, code });
  }
  let roleSeq = 0;
  for (const name of ['FINANCE', 'ADMINISTRATION', 'PURCHASING', 'EMPLOYEE']) {
    roles.set(name, { id: `r-${++roleSeq}`, name });
  }

  const api: any = {
    permission: {
      findUnique: async ({ where: { code } }: any) => permissions.get(code) ?? null,
      upsert: async ({ where: { code }, update, create }: any) => {
        const existing = permissions.get(code);
        if (existing) Object.assign(existing, (update ?? {}) as object);
        else permissions.set(code, { ...(create ?? {}), code } as { id: string; code: string });
        return permissions.get(code)!;
      },
      findMany: async ({ where: { code: { in: codes } } }: any) =>
        [...permissions.values()].filter((p) => (codes ?? []).includes(p.code)),
    },
    role: {
      // seedPermissions looks roles up by name; syncDenyMemoryOnSave by id
      findUnique: async ({ where }: any) =>
        (where?.name && roles.get(where.name)) || (where?.id && [...roles.values()].find((r) => r.id === where.id)) || null,
    },
    rolePermission: {
      findFirst: async ({ where: { roleId, permissionId } }: any) =>
        rolePermissions.has(`${roleId}|${permissionId}`) ? { roleId, permissionId } : null,
      create: async ({ data }: any) => {
        rolePermissions.add(`${data.roleId}|${data.permissionId}`);
        return data;
      },
      createMany: async ({ data }: any) => {
        for (const d of data) rolePermissions.add(`${d.roleId}|${d.permissionId}`);
        return { count: data.length };
      },
      deleteMany: async ({ where: { roleId } }: any) => {
        let n = 0;
        for (const key of [...rolePermissions]) {
          if (key.startsWith(`${roleId}|`)) { rolePermissions.delete(key); n++; }
        }
        return { count: n };
      },
    },
    rolePermissionDenied: {
      findFirst: async ({ where: { roleId, permission: { code } } }: any) => {
        const pid = permissions.get(code)?.id;
        return pid && denied.has(`${roleId}|${pid}`) ? { roleId, permissionId: pid } : null;
      },
      deleteMany: async ({ where: { roleId, permission: { code: { in: codes } } } }: any) => {
        let n = 0;
        for (const code of codes ?? []) {
          const pid = permissions.get(code)?.id;
          if (pid && denied.delete(`${roleId}|${pid}`)) n++;
        }
        return { count: n };
      },
      upsert: async ({ where: { roleId_permissionId }, create }: any) => {
        const key = `${roleId_permissionId.roleId}|${roleId_permissionId.permissionId}`;
        denied.add(key);
        return create;
      },
      // some hosts lack the table (fresh DB pre-migration) — the seeder must not crash
      // (findFirst returning null covers that path)
    },
    $connect: async () => undefined,
  };
  // expose internals for assertions
  (api as any).__state = { permissions, roles, rolePermissions, denied };
  return api;
}

async function main() {
  const { seedPermissions, syncDenyMemoryOnSave } = require('../src/auth/permissions-seed');

  // ---------------------------------------------------- 1) deny-memory seeding
  await test('seedPermissions: FINANCE suppliers.read stays denied across restarts', async () => {
    const prisma = makePrisma();
    await seedPermissions(prisma as any);
    const { permissions, roles, rolePermissions } = (prisma as any).__state;
    const finance = roles.get('FINANCE');
    const supp = permissions.get('suppliers.read');
    assert.ok(!rolePermissions.has(`${finance.id}|${supp.id}`), 'deny-memory must block the suppliers.read re-grant');
    // but its other defaults ARE granted
    const inv = permissions.get('inventory.read');
    assert.ok(rolePermissions.has(`${finance.id}|${inv.id}`), 'unrelated defaults must still be granted');
  });

  await test('seedPermissions: static DENIED_BY_ROLE wins even with no deny row', async () => {
    const prisma = makePrisma();
    await seedPermissions(prisma as any);
    const { permissions, roles, rolePermissions } = (prisma as any).__state;
    const finance = roles.get('FINANCE');
    const supp = permissions.get('suppliers.read');
    assert.ok(!rolePermissions.has(`${finance.id}|${supp.id}`));
    // simulate a host that lost the deny row: re-seed must still not re-grant
    (prisma as any).__state.denied.clear();
    await seedPermissions(prisma);
    assert.ok(!rolePermissions.has(`${finance.id}|${supp.id}`), 'static DENIED_BY_ROLE must block re-grant');
  });

  await test('seedPermissions: grants every DEFAULT_GRANTS code when no deny exists', async () => {
    const prisma = makePrisma();
    await seedPermissions(prisma as any);
    const { permissions, roles, rolePermissions } = (prisma as any).__state;
    const admin = roles.get('ADMINISTRATION');
    for (const code of ['inventory.read', 'inventory.manage', 'suppliers.read', 'departments.manage']) {
      const p = permissions.get(code);
      assert.ok(rolePermissions.has(`${admin.id}|${p.id}`), `ADMINISTRATION must hold ${code}`);
    }
  });

  await test('seedPermissions: is idempotent (no duplicates, no errors)', async () => {
    const prisma = makePrisma();
    await seedPermissions(prisma as any);
    await seedPermissions(prisma as any);
    const { roles, permissions, rolePermissions } = (prisma as any).__state;
    const admin = roles.get('ADMINISTRATION');
    let count = 0;
    const pid = permissions.get('inventory.read').id;
    for (const key of rolePermissions) if (key === `${admin.id}|${pid}`) count++;
    assert.strictEqual(count, 1, 'exactly one grant row after two seeds');
  });

  // ---------------------------------------------------- 2) matrix-save sync
  await test('syncDenyMemoryOnSave: dropping a default code records the deny', async () => {
    const prisma = makePrisma();
    await seedPermissions(prisma as any);
    const { roles, permissions, denied } = (prisma as any).__state;
    const finance = roles.get('FINANCE');
    const invId = permissions.get('inventory.read').id;
    // admin revokes inventory.read from FINANCE via the matrix
    await syncDenyMemoryOnSave(prisma as any, finance.id, ['announcements.read']);
    assert.ok(denied.has(`${finance.id}|${invId}`), 'dropped default must be recorded as denied');
  });

  await test('syncDenyMemoryOnSave: re-granting a denied code clears the deny row', async () => {
    const prisma = makePrisma();
    await seedPermissions(prisma as any);
    const { roles, permissions, denied, rolePermissions } = (prisma as any).__state;
    const finance = roles.get('FINANCE');
    const suppId = permissions.get('suppliers.read').id;
    // admin re-ticks suppliers.read for FINANCE
    await syncDenyMemoryOnSave(prisma as any, finance.id, ['announcements.read', 'inventory.read', 'suppliers.read']);
    assert.ok(!denied.has(`${finance.id}|${suppId}`), 're-grant must clear the deny memory');
  });

  await test('syncDenyMemoryOnSave: non-default codes are never deny-recorded', async () => {
    const prisma = makePrisma();
    await seedPermissions(prisma as any);
    const { roles, permissions, denied } = (prisma as any).__state;
    const finance = roles.get('FINANCE');
    const usersId = permissions.get('users.read').id;
    await syncDenyMemoryOnSave(prisma as any, finance.id, []);
    assert.ok(!denied.has(`${finance.id}|${usersId}`), 'non-default code must not gain a deny row');
  });

  await test('syncDenyMemoryOnSave: unknown role is a safe no-op', async () => {
    const prisma = makePrisma();
    await syncDenyMemoryOnSave(prisma as any, 'r-nope', []);
  });

  // ---------------------------------------------------- 3) guard semantics
  const { PermissionsGuard } = require('../src/auth/permissions.guard');

  /** Minimal ExecutionContext stub. */
  const ctx = (perms: unknown, req: any = { user: { id: 'u1' } }) => ({
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  }) as any;
  const reflector = (value: unknown) => ({ getAllAndOverride: () => value }) as any;
  const permSvc = (codes: string[]) => ({ forUser: async () => codes }) as any;

  await test('PermissionsGuard: flat list requires ALL codes (AND)', async () => {
    const guard = new PermissionsGuard(reflector(['suppliers.read']), permSvc(['inventory.read']));
    await assert.rejects(
      () => guard.canActivate(ctx(['suppliers.read'])),
      /You do not have permission/,
      'missing code must throw Forbidden',
    );
  });

  await test('PermissionsGuard: passes when every code of a flat list is held', async () => {
    const guard = new PermissionsGuard(reflector(['suppliers.read', 'inventory.read']), permSvc(['suppliers.read', 'inventory.read']));
    const ok = await guard.canActivate(ctx(null));
    assert.strictEqual(ok, true);
  });

  await test('PermissionsGuard: any-of sets pass when ONE set is fully held (OR of ANDs)', async () => {
    const guard = new PermissionsGuard(
      reflector([['suppliers.read'], ['inventory.read', 'inventory.manage']]),
      permSvc(['inventory.read', 'inventory.manage']),
    );
    const req: any = { user: { id: 'u1' } };
    const ok = await guard.canActivate(ctx(null, req));
    assert.strictEqual(ok, true, 'holding the full second set must pass');
    assert.deepStrictEqual(req.userPermissions, ['inventory.read', 'inventory.manage'], 'grants must be cached on the request');
  });

  await test('PermissionsGuard: any-of sets pass when the FIRST set is held (order-independent)', async () => {
    const guard = new PermissionsGuard(
      reflector([['inventory.read'], ['suppliers.read']]),
      permSvc(['inventory.read']),
    );
    const ok = await guard.canActivate(ctx(null));
    assert.strictEqual(ok, true);
  });

  await test('PermissionsGuard: passes through when no metadata declared', async () => {
    const guard = new PermissionsGuard(reflector(undefined), null as any);
    const ok = await guard.canActivate(ctx(undefined, {}));
    assert.strictEqual(ok, true);
  });

  await test('PermissionsGuard: denies when the user holds no complete set', async () => {
    const guard = new PermissionsGuard(
      reflector([['suppliers.read'], ['inventory.manage']]),
      permSvc(['inventory.read', 'announcements.read']),
    );
    await assert.rejects(() => guard.canActivate(ctx(null)), /You do not have permission/);
  });

  await test('PermissionsGuard: denies when user id is missing (returns false, no throw)', async () => {
    const guard = new PermissionsGuard(reflector([['users.read']]), permSvc(['users.read']));
    const ok = await guard.canActivate(ctx(null, {}));
    assert.strictEqual(ok, false, 'no user id → canActivate false (request rejected upstream)');
  });

  // ---------------------------------------------------- 4) controller gate metadata
  function controllerMeta(controller: any) {
    const meta: Record<string, string[][]> = {};
    for (const methodName of Object.getOwnPropertyNames(controller.prototype)) {
      const raw = Reflect.getMetadata?.('ams_permissions', controller.prototype[methodName]);
      if (raw) meta[methodName] = (raw as any[]).map((entry: any) => (Array.isArray(entry) ? entry : [entry]));
    }
    return meta;
  }

  await test('OrgController: /org/employees requires employees.read only (no org.read OR-leg)', async () => {
    const { OrgController } = require('../src/org/org.controller');
    const meta = controllerMeta(OrgController);
    assert.deepStrictEqual(meta.employees, [['employees.read']], 'employees list must be gated by employees.read alone');
    assert.deepStrictEqual(meta.departments, [['departments.read']], 'departments list must be gated by departments.read alone');
    // branches: either dedicated read code (picker use), never legacy org.read
    const branches = meta.branches.flat();
    assert.ok(!branches.includes('org.read'), 'branches must not accept legacy org.read');
    assert.ok(branches.includes('departments.read') && branches.includes('employees.read'));
  });

  await test('OrgController: branches/departments/employees carry no legacy org.read leg', async () => {
    const { OrgController } = require('../src/org/org.controller');
    const meta = controllerMeta(OrgController);
    for (const m of ['branches', 'departments', 'employees']) {
      assert.ok(!meta[m].flat().includes('org.read'), `${m} must not accept org.read`);
    }
  });

  await test('OrgController: employee CRUD accepts org.manage OR employees.manage', async () => {
    const { OrgController } = require('../src/org/org.controller');
    const meta = controllerMeta(OrgController);
    const sets = meta.createEmployee;
    assert.ok(sets.length === 2, 'two alternate sets (OR)');
    assert.ok(sets.flat().includes('org.manage') && sets.flat().includes('employees.manage'));
  });

  await test('SuppliersController: read endpoints require suppliers.read only', async () => {
    const { SuppliersController } = require('../src/suppliers/suppliers.controller');
    const meta = controllerMeta(SuppliersController);
    for (const method of ['list', 'history', 'contactLogs', 'poDrafts']) {
      assert.deepStrictEqual(meta[method], [['suppliers.read']], `${method} must not accept inventory.read`);
    }
  });

  await test('SuppliersController: write endpoints keep the manage OR-gate (store staff)', async () => {
    const { SuppliersController } = require('../src/suppliers/suppliers.controller');
    const meta = controllerMeta(SuppliersController);
    const sets = meta.create.flat();
    assert.ok(sets.includes('inventory.manage') && sets.includes('suppliers.manage'), 'write path stays dual-gated');
  });

  await test('InventoryController: issued-items requires employees.read (no org.read OR-leg)', async () => {
    const { InventoryController } = require('../src/inventory/inventory.controller');
    const meta = controllerMeta(InventoryController);
    assert.deepStrictEqual(meta.employeeIssuedItems, [['employees.read']]);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    failures.forEach((f) => console.error('  FAIL: ' + f));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
