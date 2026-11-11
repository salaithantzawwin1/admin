/**
 * Odometer OCR — shadow mode (docs/ODOMETER_OCR_PLAN.md).
 *
 * The reader is an observer: it reads the ODO value out of the driver's photo and
 * records what it saw, so the typed number can be checked afterwards. It must be
 * a silent no-op without a key, on a provider error, and over the daily budget.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/odometer-ocr-shadow.test.ts
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

const { OdometerReaderService } = require('../src/cars/odometer-reader.service');

const PHOTO = { buffer: Buffer.from('jpeg-bytes'), size: 10 };
const ON = [
  { key: 'odometer.ocr.enabled', value: 'true' },
  { key: 'odometer.ocr.api_key', value: 'test-key' },
  { key: 'odometer.ocr.mode', value: 'shadow' },
];

function build(opts: any = {}) {
  const updates: any[] = [];
  const audits: any[] = [];
  const rows = opts.rows ?? ON;
  const prisma: any = {
    systemSetting: {
      findMany: async (args: any) => {
        const wanted: string[] = args?.where?.key?.in ?? [];
        return rows.filter((r: any) => wanted.includes(r.key));
      },
    },
    carAssignment: {
      count: async () => opts.used ?? 0,
      findUnique: async () => ({ requestId: 'req-1', vehicle: { currentMileage: opts.floor ?? 340000 } }),
      update: async (args: any) => {
        updates.push(args);
        return {};
      },
    },
  };
  const audit = { log: async (e: any) => { audits.push(e); } };
  return { svc: new OdometerReaderService(prisma, audit), updates, audits };
}

function stubFetch(json: any, ok = true) {
  const seen: any[] = [];
  const real = global.fetch;
  (global as any).fetch = async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return { ok, status: ok ? 200 : 500, json: async () => json };
  };
  return { seen, restore: () => { (global as any).fetch = real; } };
}

const openai = (content: string) => ({ choices: [{ message: { content } }] });

async function main() {
  console.log('odometer OCR (shadow)');

  await test('disabled by default: no settings row, no call, no write', async () => {
    const h = build({ rows: [] });
    const f = stubFetch(openai('341363'));
    try {
      assert.strictEqual(await h.svc.read(PHOTO), null);
      await h.svc.readAndRecord('as-1', PHOTO);
      assert.strictEqual(f.seen.length, 0, 'no provider call without a key');
      assert.deepStrictEqual(h.updates, []);
    } finally {
      f.restore();
    }
  });

  await test('shadow mode reads the ODO and records what it saw', async () => {
    const h = build();
    const f = stubFetch(openai('341363'));
    try {
      const read = await h.svc.read(PHOTO);
      assert.strictEqual(read?.km, 341363);
      assert.strictEqual(read?.source, 'openai');
      const stored = await h.svc.readAndRecord('as-1', PHOTO);
      assert.strictEqual(stored?.km, 341363);
      const data = h.updates[0].data;
      assert.strictEqual(data.odoReadKm, 341363);
      assert.strictEqual(data.odoReadSource, 'openai');
      assert.strictEqual(data.odoReadConfidence, 'high');
      assert.ok(data.odoReadAt instanceof Date);
      assert.strictEqual(h.audits[0].action, 'CAR_ODOMETER_OCR_READ');
      assert.strictEqual(h.audits[0].newValue.mode, 'shadow', 'shadow mode is recorded as such');
    } finally {
      f.restore();
    }
  });

  await test('a Gemini-shaped response and separators are understood', async () => {
    const h = build({
      rows: [
        { key: 'odometer.ocr.enabled', value: 'true' },
        { key: 'odometer.ocr.api_key', value: 'k' },
        { key: 'odometer.ocr.provider', value: 'gemini' },
      ],
    });
    const f = stubFetch({ candidates: [{ content: { parts: [{ text: '341,325' }] } }] });
    try {
      const read = await h.svc.read(PHOTO);
      assert.strictEqual(read?.km, 341325);
      assert.ok(f.seen[0].url.includes(':generateContent'), 'the gemini endpoint is used');
    } finally {
      f.restore();
    }
  });

  await test('an unreadable photo is not a reading', async () => {
    const h = build();
    const f = stubFetch(openai('NONE'));
    try {
      assert.strictEqual(await h.svc.read(PHOTO), null);
      assert.deepStrictEqual(h.updates, []);
    } finally {
      f.restore();
    }
  });

  await test('a number under the car\'s own odometer is kept but flagged low', async () => {
    const h = build({ floor: 342000 });
    const f = stubFetch(openai('341363'));
    try {
      const read = await h.svc.readAndRecord('as-1', PHOTO);
      assert.strictEqual(read?.confidence, 'low', 'likely a TRIP reading, not the ODO');
      assert.strictEqual(h.updates[0].data.odoReadConfidence, 'low');
      assert.strictEqual(h.updates[0].data.odoReadKm, 341363, 'still evidence for the human');
    } finally {
      f.restore();
    }
  });

  await test('a provider failure is silent', async () => {
    const h = build();
    const f = stubFetch({ error: 'boom' }, false);
    try {
      assert.strictEqual(await h.svc.read(PHOTO), null);
      assert.strictEqual(await h.svc.readAndRecord('as-1', PHOTO), null);
      assert.deepStrictEqual(h.updates, []);
    } finally {
      f.restore();
    }
  });

  await test('the daily budget stops the reader', async () => {
    const h = build({
      used: 50,
      rows: [...ON, { key: 'odometer.ocr.daily_limit', value: '50' }],
    });
    const f = stubFetch(openai('341363'));
    try {
      assert.strictEqual(await h.svc.read(PHOTO), null);
      assert.strictEqual(f.seen.length, 0, 'no spend over the budget');
    } finally {
      f.restore();
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.error(` - ${f}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
