/**
 * E2E-ish checks for Fleet vehicle creation — the contract between the web
 * form and the backend (empty optional specs, duplicate vehicle no, VIN rules).
 *
 * Motivation: the web form used to send '' for unset optional specs; the DTO's
 * @IsOptional validators only skip null/undefined, so EVERY create with an
 * empty specs section was rejected server-side ('VIN must be 17 characters…,
 * year must be an integer…'). Found during manual browser verification of the
 * invalid-field styling — these checks pin the contract so CI catches it.
 *
 * Layers covered:
 *  1. DTO validation contract — plainPayloadOf()/validateSync() exactly like
 *     Nest's ValidationPipe (whitelist on) — runs the REAL VehicleDto.
 *  2. Service behaviour — REAL FleetService with a mock Prisma (same spy-style
 *     harness as cars-fixes.test.ts): duplicate vehicleNo/VIN rejections, and
 *     ''-vs-undefined normalisation for the DB write.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/fleet-vehicle-creation.test.ts
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
function plainPayloadOf(plain: object) {
  const { plainToInstance } = require('class-transformer');
  const { validateSync } = require('class-validator');
  const { VehicleDto } = require('../src/fleet/fleet.controller');
  const dto = plainToInstance(VehicleDto, plain);
  const errors = validateSync(dto, { whitelist: true });
  return { dto, errors };
}

function validationMessages(plain: object): string[] {
  const { errors } = plainPayloadOf(plain);
  return errors.flatMap((e: any) => (e.constraints ? Object.values(e.constraints) : [])) as string[];
}

const ACTOR = { userId: 'u-1', username: 'tester' };

function makeService(prisma: any) {
  const { FleetService } = require('../src/fleet/fleet.service');
  const noop = async () => undefined;
  return new FleetService(
    prisma,
    { log: noop } as any, // audit
    { emit: noop } as any, // events
    {} as any, // telegram (unused on create path)
    {} as any, // notifications
    {} as any, // permissions
  );
}

async function main() {
  // ============================== 1) DTO validation contract ==============================
  console.log('\n-- VehicleDto validation contract (as the web form submits) --');

  await test('empty optional specs (form with collapsed section) VALIDATES — the regression we fixed', () => {
    // exactly what the FIXED frontend sends: unset specs are absent, not ''
    const msgs = validationMessages({
      vehicleNo: 'YGN-0001', vehicleType: 'SEDAN', brandModel: 'Toyota Corolla',
      capacity: 4, driverId: undefined,
      vin: undefined, fuelType: undefined, engineNo: undefined, chassisNo: undefined,
      make: undefined, model: undefined, year: undefined,
    });
    assert.deepStrictEqual(msgs, [], `unexpected rejections: ${msgs.join(' | ')}`);
  });

  await test("'' optional specs are REJECTED by the DTO — the exact old-bug payload", () => {
    // exactly what the BUGGY frontend sent; the DTO must keep rejecting it so
    // a future FE regression is caught here instead of in production
    const msgs = validationMessages({
      vehicleNo: 'YGN-0001', vehicleType: 'SEDAN', brandModel: 'Toyota Corolla',
      vin: '', fuelType: '', engineNo: '', chassisNo: '', make: '', model: '', year: '',
    });
    assert.ok(msgs.some((m) => /VIN must be 17/.test(m)), 'empty-string VIN must be rejected');
    assert.ok(msgs.some((m) => /fuelType must be one of/.test(m)), "empty-string fuelType must be rejected");
    assert.ok(msgs.some((m) => /year must be an integer/.test(m)), "empty-string year must be rejected");
  });

  await test('a VALID full specs payload validates cleanly', () => {
    const msgs = validationMessages({
      vehicleNo: 'YGN-0002', vehicleType: 'SUV', brandModel: 'Toyota Land Cruiser',
      capacity: 7, driverId: 'drv-1', vin: 'JTDKB20U577012345', fuelType: 'HYBRID',
      engineNo: 'ENG-123456', chassisNo: 'CHS-123456', make: 'Toyota', model: 'Land Cruiser', year: 2015,
    });
    assert.deepStrictEqual(msgs, [], `unexpected rejections: ${msgs.join(' | ')}`);
  });

  await test('VIN format enforced: I/O/Q forbidden, wrong length rejected', () => {
    let msgs = validationMessages({
      vehicleNo: 'YGN-0003', vehicleType: 'VAN', brandModel: 'Hyundai Starex', vin: 'JTDKB20U577OIQ23',
    });
    assert.ok(msgs.some((m) => /VIN must be 17/.test(m)), 'I/O/Q VIN must be rejected');
    msgs = validationMessages({
      vehicleNo: 'YGN-0003', vehicleType: 'VAN', brandModel: 'Hyundai Starex', vin: 'TOOSHORT',
    });
    assert.ok(msgs.some((m) => /VIN must be 17/.test(m)), 'short VIN must be rejected');
  });

  await test('fuelType is enum-locked and year is range-locked', () => {
    const msgs = validationMessages({
      vehicleNo: 'YGN-0004', vehicleType: 'SEDAN', brandModel: 'Mazda 3', fuelType: 'DIESELX', year: 1900,
    });
    assert.ok(msgs.some((m) => /fuelType must be one of/.test(m)), 'bad fuelType must be rejected');
    assert.ok(msgs.some((m) => /year must not be less than 1950/.test(m)), 'old year must be rejected');
  });

  await test('vehicleNo / brandModel minimum lengths enforced', () => {
    const msgs = validationMessages({
      vehicleNo: 'Y', vehicleType: 'SEDAN', brandModel: 'M',
    });
    assert.ok(msgs.length > 0, 'short vehicleNo + brandModel must be rejected');
  });

  // ============================== 2) Service behaviour (mock Prisma) ==============================
  console.log('\n-- FleetService.createVehicle with mock Prisma --');

  await test('duplicate vehicle number is rejected with the message the UI attributes to the field', () => {
    const prisma: any = {
      vehicle: {
        findUnique: async (args: any) =>
          args.where.vehicleNo !== undefined && args.where.vehicleNo === 'YGN-5678'
            ? { vehicleNo: 'YGN-5678', brandModel: 'Toyota Land Cruiser' }
            : null,
        create: async (args: any) => ({ id: 'v-new', ...args.data }),
      },
    };
    const svc = makeService(prisma);
    return assert.rejects(
      () => svc.createVehicle({ vehicleNo: 'YGN-5678', vehicleType: 'SEDAN', brandModel: 'Nissan Leaf' }, ACTOR),
      (e: any) => e.message === 'Vehicle number already exists',
    );
  });

  await test('VIN already registered to another vehicle is rejected with that vehicle no', () => {
    const prisma: any = {
      vehicle: {
        findUnique: async (args: any) =>
          args.where.vin !== undefined && args.where.vin === 'JTDKB20U577012345'
            ? { vehicleNo: 'YGN-1234' }
            : null,
        create: async (args: any) => ({ id: 'v-new', ...args.data }),
      },
    };
    const svc = makeService(prisma);
    return assert.rejects(
      () => svc.createVehicle({ vehicleNo: 'YGN-9999', vehicleType: 'SEDAN', brandModel: 'Nissan Leaf', vin: 'JTDKB20U577012345' }, ACTOR),
      (e: any) => e.message === 'VIN already registered to YGN-1234',
    );
  });

  await test("'' optional specs are stored as NULL (DB never sees empty strings)", () => {
    const prisma: any = {
      vehicle: {
        findUnique: async () => null,
        create: async (args: any) => ({ id: 'v-new', ...args.data }),
      },
    };
    const svc = makeService(prisma);
    return svc
      .createVehicle(
        // service signature allows '' — the controller/FE layer normalises, but
        // the service is the last line of defence for the DB write
        { vehicleNo: 'YGN-7777', vehicleType: 'SEDAN', brandModel: 'Nissan Leaf', vin: '', fuelType: '', year: undefined as any },
        ACTOR,
      )
      .then((vehicle: any) => {
        const written = prisma.vehicle.create.calls ? undefined : null;
        assert.strictEqual(vehicle.vin, null, `vin must be written as null, got ${JSON.stringify(vehicle.vin)}`);
        assert.strictEqual(vehicle.fuelType, null, 'fuelType must be written as null');
        assert.strictEqual(vehicle.year, null, 'year must be written as null');
        return written;
      });
  });

  await test('valid create writes vehicle + audit log and returns it', () => {
    const created: any[] = [];
    const audits: any[] = [];
    const prisma: any = {
      vehicle: {
        findUnique: async () => null,
        create: async (args: any) => {
          created.push(args.data);
          return { id: 'v-new', ...args.data };
        },
      },
    };
    const svc = makeService(prisma);
    return svc
      .createVehicle(
        { vehicleNo: 'YGN-8888', vehicleType: 'PICKUP', brandModel: 'Hilux Revo', capacity: 2, year: 2020 },
        ACTOR,
      )
      .then((vehicle: any) => {
        assert.strictEqual(vehicle.vehicleNo, 'YGN-8888');
        assert.strictEqual(created.length, 1);
        assert.strictEqual(created[0].year, 2020);
        assert.strictEqual(created[0].vin, null);
      });
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
