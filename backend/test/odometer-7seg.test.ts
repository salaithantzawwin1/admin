/**
 * Offline seven-segment odometer reader (docs/ODOMETER_OCR_PLAN.md).
 *
 * The pipeline has to survive real dashboards, which we cannot put in a test
 * fixture; what we CAN pin down is the contract: a cluster is found, the LCD row
 * is cut into one glyph per digit, a labelled glyph set recognises the same font
 * at a different size, and the reader refuses instead of guessing.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/odometer-7seg.test.ts
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

const { decodeImage, encodeGrayPng } = require('../src/cars/odometer-7seg/image');
const { findDigitRow, dashboardKey, sameDashboard } = require('../src/cars/odometer-7seg/lcd');
const { segmentDigits, patchOf, PATCH_W, PATCH_H, PATCH_BYTES } = require('../src/cars/odometer-7seg/segment');
const { classifyPatch, decodeTemplates, similarity } = require('../src/cars/odometer-7seg/classify');
const { OdometerSevenSegService } = require('../src/cars/odometer-7seg/seven-seg.service');

// ---------------------------------------------------------------------------
// a synthetic dashboard: dark cabin, bright cluster, dark LCD panel, lit digits

const SEGMENTS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abdeg',
  '3': 'abcdg',
  '4': 'bcfg',
  '5': 'acdfg',
  '6': 'acdefg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
};

function blank(w: number, h: number, value: number) {
  return { w, h, data: new Uint8Array(w * h).fill(value) };
}

function fillRect(g: any, x: number, y: number, w: number, h: number, value: number) {
  for (let yy = Math.max(0, y); yy < Math.min(g.h, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(g.w, x + w); xx++) g.data[yy * g.w + xx] = value;
  }
}

function drawDigit(g: any, digit: string, x: number, y: number, w: number, h: number, value: number) {
  const t = Math.max(2, Math.round(h * 0.16));
  const on = SEGMENTS[digit] ?? '';
  const bar = (bx: number, by: number, bw: number, bh: number) => fillRect(g, bx, by, bw, bh, value);
  if (on.includes('a')) bar(x, y, w, t);
  if (on.includes('d')) bar(x, y + h - t, w, t);
  if (on.includes('g')) bar(x, y + Math.round(h / 2) - Math.round(t / 2), w, t);
  if (on.includes('f')) bar(x, y, t, Math.round(h / 2));
  if (on.includes('e')) bar(x, y + Math.round(h / 2), t, Math.round(h / 2));
  if (on.includes('b')) bar(x + w - t, y, t, Math.round(h / 2));
  if (on.includes('c')) bar(x + w - t, y + Math.round(h / 2), t, Math.round(h / 2));
}

/** The geometry the "camera" sees: cluster box and the digit row inside it. */
function dashboard(digits: string, glyphH = 38) {
  const g = blank(1280, 720, 22);
  // instrument cluster (bright hood)
  fillRect(g, 180, 130, 920, 430, 108);
  // LCD panel: dark, wide, low in the cluster
  const lcd = { x: 470, y: 380, w: 340, h: 110 };
  fillRect(g, lcd.x, lcd.y, lcd.w, lcd.h, 34);
  // ODO label (short blobs the segmenter must ignore) then the digits
  const glyphW = Math.round(glyphH * 0.55);
  const gap = Math.round(glyphW * 0.45);
  let x = lcd.x + 90;
  fillRect(g, lcd.x + 20, lcd.y + 45, 16, 8, 210); // "label"
  fillRect(g, lcd.x + 40, lcd.y + 45, 8, 12, 210);
  for (const digit of digits) {
    drawDigit(g, digit, x, lcd.y + 40, glyphW, glyphH, 226);
    x += glyphW + gap;
  }
  const row = { x: lcd.x + 90, y: lcd.y + 40, w: x - gap - (lcd.x + 90), h: glyphH };
  return { image: g, cluster: { x: 180, y: 130, w: 920, h: 430 }, row };
}

function pngBytes(g: any): Buffer {
  return Buffer.from(encodeGrayPng(g), 'base64');
}

/**
 * One labelled glyph, built the way the segmenter sees one: lit bars on a dark
 * panel, cropped to the ink (what `segmentDigits` would hand the classifier).
 * The classifier test is about recognition, so the geometry is exact here.
 */
function glyphTemplate(digit: string, glyphH = 44) {
  const w = Math.round(glyphH * 0.55);
  const g = blank(w + 20, glyphH + 20, 30);
  drawDigit(g, digit, 10, 10, w, glyphH, 230);
  let x0 = g.w;
  let x1 = -1;
  let y0 = g.h;
  let y1 = -1;
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (g.data[y * g.w + x] <= 60) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  assert.ok(x1 > x0 && y1 > y0, `glyph ${digit} drew nothing`);
  return patchOf(g, { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
}

function templatesFor(digits = '0123456789') {
  return [...digits].map((d) => ({ digit: d, patch: glyphTemplate(d) }));
}

function serviceWith(templates: any[], calibrations: any[] = [], photoPath?: string) {
  const created: any[] = [];
  const prisma: any = {
    odometerDigitSample: {
      findMany: async () => templates.map((t: any) => ({ digit: t.digit, patch: Buffer.from(t.patch).toString('base64') })),
      groupBy: async () => [],
      createMany: async (args: any) => {
        created.push(args);
        return { count: args.data.length };
      },
    },
    odometerLcdCalibration: {
      findMany: async () => calibrations,
      count: async () => calibrations.length,
      create: async (args: any) => {
        created.push(args);
        return args.data;
      },
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
  const audits: any[] = [];
  const audit = { log: async (e: any) => void audits.push(e) };
  const cars = {
    odometerPhotoFile: async () =>
      photoPath ? { filePath: photoPath, vehicleNo: 'YGN-1234', typedKm: null } : null,
  };
  return { svc: new OdometerSevenSegService(prisma, audit, cars), created, audits };
}

async function main() {
  await test('PNG encode/decode keeps the pixels', () => {
    const g = blank(24, 12, 0);
    fillRect(g, 4, 3, 6, 5, 220);
    const back = decodeImage(pngBytes(g));
    assert.ok(back, 'decode returned null');
    assert.strictEqual(back.w, 24);
    assert.strictEqual(back.h, 12);
    assert.strictEqual(back.data[4 * 24 + 6], 220);
    assert.strictEqual(back.data[0], 0);
  });

  await test('garbage bytes are a null, not a throw', () => {
    assert.strictEqual(decodeImage(Buffer.from('not an image at all, really not')), null);
    assert.strictEqual(decodeImage(Buffer.alloc(0)), null);
  });

  await test('the ODO row is found in a dark frame, with its label beside it', () => {
    const { image, row } = dashboard('341363');
    const found = findDigitRow(image);
    assert.ok(found, 'no row found');
    assert.strictEqual(found.glyphs.length, 6, `expected 6 glyphs, got ${found.glyphs.length}`);
    assert.ok(found.label, 'the ODO label left of the row was not seen');
    // the row must cover the digits the fixture drew
    assert.ok(found.row.x <= row.x + 4, `row starts too far right: ${found.row.x} vs ${row.x}`);
    assert.ok(found.row.x + found.row.w >= row.x + row.w - 6, 'row ends before the last digit');
    assert.ok(Math.abs(found.row.h - row.h) <= row.h * 0.35, `row height ${found.row.h} vs glyph ${row.h}`);
  });

  await test('the LCD row is cut into one glyph per digit', () => {
    const { image, row } = dashboard('341363');
    const data = new Uint8Array(row.w * row.h);
    for (let y = 0; y < row.h; y++) {
      for (let x = 0; x < row.w; x++) data[y * row.w + x] = image.data[(row.y + y) * image.w + row.x + x];
    }
    const seg = segmentDigits({ w: row.w, h: row.h, data }, 6);
    assert.strictEqual(seg.digits.length, 6, `expected 6 glyphs, got ${seg.digits.length}`);
    for (const glyph of seg.digits) {
      assert.strictEqual(glyph.patch.length, PATCH_BYTES);
      assert.strictEqual(glyph.box.h >= row.h * 0.5, true, 'glyph shorter than the row');
    }
  });

  await test('a labelled font recognises the same digits at another size', () => {
    const templates = templatesFor();
    const { image, row } = dashboard('341363', 30);
    const data = new Uint8Array(row.w * row.h);
    for (let y = 0; y < row.h; y++) {
      for (let x = 0; x < row.w; x++) data[y * row.w + x] = image.data[(row.y + y) * image.w + row.x + x];
    }
    const seg = segmentDigits({ w: row.w, h: row.h, data }, 6);
    const read = seg.digits.map((d: any) => classifyPatch(d.patch, templates));
    const shown = read.map((m: any) => `${m.digit}:${m.score.toFixed(3)}/${m.margin.toFixed(3)}`).join(' ');
    assert.strictEqual(read.map((m: any) => m.digit).join(''), '341363', `misread: ${shown}`);
    assert.ok(read.every((m: any) => m.confident), `a confident read was not confident: ${shown}`);
  });

  await test('a glyph that matches nothing is refused', () => {
    const templates = templatesFor();
    const blankPatch = new Uint8Array(PATCH_BYTES).fill(128);
    const match = classifyPatch(blankPatch, templates);
    assert.strictEqual(match.confident, false);
  });

  await test('without templates the classifier refuses instead of guessing', () => {
    const patch = glyphTemplate('3');
    const match = classifyPatch(patch, []);
    assert.strictEqual(match.digit, null);
    assert.strictEqual(match.confident, false);
    assert.strictEqual(similarity(patch, patch), 1);
  });

  await test('the reader refuses a photo where the row is not 5–7 glyphs', async () => {
    const { svc } = serviceWith(templatesFor());
    const { image } = dashboard('3413', 38);
    assert.strictEqual(await svc.read(pngBytes(image)), null);
  });

  await test('the reader refuses until something has been labelled', async () => {
    const { svc } = serviceWith([]);
    const { image } = dashboard('341363', 38);
    assert.strictEqual(await svc.read(pngBytes(image)), null);
  });

  await test('labelling one photo is enough for the reader to read the next one', async () => {
    // the production loop: label a photo, then read the same dashboard with what
    // that label taught us (glyph templates + where the row sat in the cluster)
    const { image } = dashboard('341363', 38);
    const file = path.join(os.tmpdir(), `odo-7seg-loop-${Date.now()}.png`);
    fs.writeFileSync(file, pngBytes(image));
    try {
      const { svc: teacher, created } = serviceWith([], [], file);
      await teacher.label({ assignmentId: 'a-loop', stage: 'READY', km: 341363 });
      const rows = created.find((c) => Array.isArray(c.data)).data;
      const calibration = created.find((c) => c.data && typeof c.data.rx === 'number').data;
      const templates = rows.map((r: any) => ({ digit: r.digit, patch: new Uint8Array(Buffer.from(r.patch, 'base64')) }));

      const { svc } = serviceWith(templates, [calibration]);
      const read = await svc.read(pngBytes(image));
      assert.ok(read, 'no read after labelling');
      assert.strictEqual(read.km, 341363);
      assert.strictEqual(read.digits, '341363');
      assert.strictEqual(read.confidence, 'high');
    } finally {
      fs.unlinkSync(file);
    }
  });

  await test('labelling a photo stores one sample per digit plus its calibration', async () => {
    const { image, cluster, row } = dashboard('341363', 38);
    const file = path.join(os.tmpdir(), `odo-7seg-${Date.now()}.png`);
    fs.writeFileSync(file, pngBytes(image));
    try {
      const { svc, created, audits } = serviceWith([], [], file);
      const result = await svc.label({ assignmentId: 'a-1', stage: 'READY', km: 341363, actor: { username: 'admin' } });
      assert.strictEqual(result.stored, 6);
      const samples = created.find((c) => c.data && Array.isArray(c.data));
      assert.ok(samples, 'no samples written');
      assert.deepStrictEqual(
        samples.data.map((s: any) => s.digit).join(''),
        '341363',
      );
      for (const sample of samples.data) {
        assert.strictEqual(Buffer.from(sample.patch, 'base64').length, PATCH_BYTES);
        assert.strictEqual(sample.vehicleNo, 'YGN-1234');
      }
      const calibration = created.find((c) => c.data && typeof c.data.rx === 'number');
      assert.ok(calibration, 'no calibration written');
      // the row the reader used (its prior, since nothing is calibrated yet) must
      // sit inside the cluster, and cover the digits we just labelled
      for (const key of ['rx', 'ry', 'rw', 'rh']) {
        assert.ok(calibration.data[key] >= 0 && calibration.data[key] <= 1, `calibration ${key} out of 0..1`);
      }
      assert.ok(calibration.data.rw > 0.02 && calibration.data.rh > 0.02, 'calibration row is too small');
      assert.ok(Math.abs(calibration.data.rh - row.h / cluster.h) < 0.2, 'calibration height is off');
      assert.strictEqual(audits.length, 1);
      assert.strictEqual(audits[0].action, 'CAR_ODOMETER_DIGIT_LABELLED');
    } finally {
      fs.unlinkSync(file);
    }
  });

  await test('labelling a wrong digit count is refused with the count it saw', async () => {
    const { image } = dashboard('341363', 38);
    const file = path.join(os.tmpdir(), `odo-7seg-bad-${Date.now()}.png`);
    fs.writeFileSync(file, pngBytes(image));
    try {
      const { svc } = serviceWith([], [], file);
      await assert.rejects(
        () => svc.label({ assignmentId: 'a-2', stage: 'BACK', km: 41363 }),
        /found 6 digit/,
      );
    } finally {
      fs.unlinkSync(file);
    }
  });

  await test('a marked row sent as frame fractions is cut from the right pixels', async () => {
    const { image, row } = dashboard('341363', 38);
    const file = path.join(os.tmpdir(), `odo-7seg-mark-${Date.now()}.png`);
    fs.writeFileSync(file, pngBytes(image));
    try {
      const { svc } = serviceWith([], [], file);
      const result = await svc.analyze({
        assignmentId: 'a-4',
        stage: 'READY',
        box: { x: row.x / 1280, y: row.y / 720, w: row.w / 1280, h: row.h / 720 },
      });
      assert.strictEqual(result.digits.length, 6);
      const first = result.digits[0].box;
      const last = result.digits[5].box;
      assert.ok(
        Math.abs(first.x - row.x) < 12 && Math.abs(last.x + last.w - (row.x + row.w)) < 12,
        `glyphs ${first.x}..${last.x + last.w} vs row ${row.x}..${row.x + row.w}`,
      );
    } finally {
      fs.unlinkSync(file);
    }
  });

  await test('a marked box holding two digits returns those two, not an error', async () => {
    const { image, row } = dashboard('341363', 38);
    const file = path.join(os.tmpdir(), `odo-7seg-mark2-${Date.now()}.png`);
    fs.writeFileSync(file, pngBytes(image));
    try {
      const { svc } = serviceWith([], [], file);
      const result = await svc.analyze({
        assignmentId: 'a-5',
        stage: 'READY',
        box: { x: row.x / 1280, y: row.y / 720, w: 51 / 1280, h: row.h / 720 },
      });
      assert.strictEqual(result.digits.length, 2);
    } finally {
      fs.unlinkSync(file);
    }
  });

  await test('a prior finds a 12px ODO row instead of falling back to the frame', () => {
    // the real photos carry the row at 12–19 px: one glyph is barely seven
    // pixels wide, and a cold full-frame search never survives that
    const { image, row } = dashboard('341363', 12);
    const prior = { x: row.x - 4, y: row.y - 4, w: row.w + 8, h: row.h + 8 };
    const found = findDigitRow(image, prior);
    assert.ok(found, 'no row found with a prior on a 12px row');
    assert.strictEqual(found.glyphs.length, 6, `expected 6 glyphs, got ${found.glyphs.length}`);
    assert.ok(Math.abs(found.row.y - row.y) <= 6, `row y ${found.row.y} vs ${row.y}`);
    assert.ok(Math.abs(found.row.x - row.x) <= 10, `row x ${found.row.x} vs ${row.x}`);
  });

  await test('a decoy row inside the window loses to the prior', () => {
    // every one of these dashboards puts a six-glyph clock right above the ODO
    // row; inside a padded window it is a perfectly good digit chain
    const { image, row } = dashboard('341363', 38);
    const glyphW = Math.round(52 * 0.55);
    let x = row.x;
    for (const d of '123456') {
      drawDigit(image, d, x, row.y - 70, glyphW, 52, 240);
      x += glyphW + 12;
    }
    const prior = { x: row.x - 6, y: row.y - 6, w: row.w + 12, h: row.h + 12 };
    const found = findDigitRow(image, prior);
    assert.ok(found, 'no row found');
    const centre = found.row.y + found.row.h / 2;
    assert.ok(
      Math.abs(centre - (row.y + row.h / 2)) <= row.h * 1.2,
      `picked the decoy: row centre ${Math.round(centre)} vs ODO ${Math.round(row.y + row.h / 2)}`,
    );
  });

  await test('a prior that matches nothing returns null, never a cold search', () => {
    const { image } = dashboard('341363', 38);
    // a dark corner of the cabin: the ODO row exists elsewhere in the frame, and
    // a full-frame search would happily return it — with a prior, silence is right
    const found = findDigitRow(image, { x: 40, y: 40, w: 90, h: 26 });
    assert.strictEqual(found, null, 'a prior with nothing under it fell back to the full frame');
  });

  await test('two dashboards get different keys, the same photo gets the same one', () => {
    const a = dashboard('341363', 38).image;
    const b = dashboard('341363', 38).image;
    const moved = dashboard('341363', 38).image;
    // the same cluster, photographed a little lower in the frame
    const shifted = { w: moved.w, h: moved.h, data: new Uint8Array(moved.w * moved.h) };
    for (let y = 0; y < moved.h; y++) {
      for (let x = 0; x < moved.w; x++) {
        const sy = Math.min(moved.h - 1, y + 40);
        shifted.data[y * moved.w + x] = moved.data[sy * moved.w + x];
      }
    }
    const keyA = dashboardKey(a);
    assert.strictEqual(keyA, dashboardKey(b), 'the same photo did not produce the same key');
    assert.ok(sameDashboard(keyA, dashboardKey(shifted)), 'the same cluster shifted in frame was not recognised');
    // a different dashboard: the cluster is elsewhere and a different size
    const other = blank(1280, 720, 22);
    fillRect(other, 520, 240, 420, 260, 108);
    fillRect(other, 640, 380, 220, 80, 34);
    assert.strictEqual(sameDashboard(keyA, dashboardKey(other)), false, 'two dashboards shared a key');
  });

  await test('an unknown stage is rejected', async () => {
    const { svc } = serviceWith([]);
    await assert.rejects(() => svc.analyze({ assignmentId: 'a-3', stage: 'MIDDLE' }), /READY or BACK/);
  });

  await test('stored templates of the wrong patch size are ignored', () => {
    const rows = [
      { digit: '3', patch: Buffer.alloc(PATCH_BYTES, 10).toString('base64') },
      { digit: '8', patch: Buffer.alloc(7, 10).toString('base64') },
    ];
    const templates = decodeTemplates(rows);
    assert.strictEqual(templates.length, 1);
    assert.strictEqual(templates[0].digit, '3');
    assert.strictEqual(PATCH_W, 16);
    assert.strictEqual(PATCH_H, 24);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error(failures.map((f) => ` - ${f}`).join('\n'));
    process.exit(1);
  }
}

void main();
