/**
 * Security regression tests — the fixes from the 2026-11-03 audit.
 *
 *  - announcement rich text: allow-list sanitizer that cannot be talked into
 *    emitting a tag or attribute it did not build (stored XSS);
 *  - CSV exports: spreadsheet formula injection (CSV injection);
 *  - password policy: one rule for every account-creating path;
 *  - uploads: declared type must match the file's actual bytes;
 *  - JWT secret: no known fallback outside development.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/security.test.ts
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

(async () => {
  const { sanitizeHtml, htmlToText } = require('../src/announcements/sanitize-html');
  const { csvCell, csvRow } = require('../src/util/csv');
  const { assertStrongPassword, PASSWORD_MIN_LENGTH } = require('../src/util/password-policy');
  const { sniffImageType, declaredTypeMatchesBytes } = require('../src/util/image-sniff');
  const { jwtSecret } = require('../src/util/jwt-secret');

  await test('sanitizer keeps the editor subset (bold, headings, lists, safe links)', () => {
    const out = sanitizeHtml(
      '<p><b>Loud</b> <i>and</i> <u>clear</u></p><h2>Title</h2><ul><li>one</li></ul>' +
      '<a href="https://example.com/x?a=1">link</a>',
    );
    assert.ok(out.includes('<b>Loud</b>'));
    assert.ok(out.includes('<h2>Title</h2>'));
    assert.ok(out.includes('<li>one</li>'));
    assert.ok(out.includes('href="https://example.com/x?a=1"'));
    assert.ok(out.includes('rel="noopener noreferrer"'), 'links open without a window handle');
  });

  await test('sanitizer drops script/style/iframe blocks with their content', () => {
    const out = sanitizeHtml('<p>ok</p><script>alert(1)</script><style>p{}</style><iframe src="//x"></iframe>');
    assert.strictEqual(out, '<p>ok</p>');
    assert.ok(!htmlToText('<p>a</p><script>alert(1)</script>').includes('alert'));
  });

  await test('sanitizer closes the slash-separated tag bypass (<img/onerror=…>)', () => {
    const out = sanitizeHtml('<img/onerror=alert(1) src=x><p>safe</p>');
    assert.ok(!/onerror/i.test(out), `attribute survived: ${out}`);
    assert.ok(!/<img/i.test(out), `tag survived: ${out}`);
    assert.ok(out.includes('<p>safe</p>'));
  });

  await test('sanitizer never emits javascript:/data: links', () => {
    for (const payload of [
      '<a href="javascript:alert(1)">x</a>',
      '<a/href="javascript:alert(1)">x</a>',
      '<a href=javascript:alert(1)>x</a>',
      '<a href="JaVaScRiPt:alert(1)">x</a>',
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
      '<a href="//evil.example">x</a>',
    ]) {
      const out = sanitizeHtml(payload);
      assert.ok(!/javascript:|data:|href="\/\//i.test(out), `payload survived: ${payload} → ${out}`);
    }
  });

  await test('sanitizer strips event handlers and unknown tags', () => {
    const out = sanitizeHtml('<p onclick="alert(1)" style="color:red">text</p><svg onload=alert(1)></svg><marquee>x</marquee>');
    assert.ok(!/onclick|onload|style=/i.test(out), `handler survived: ${out}`);
    assert.ok(!/<svg|<marquee/i.test(out));
    assert.ok(out.includes('<p>text</p>'));
  });

  await test('sanitizer escapes a stray "<" instead of passing it to the browser', () => {
    const out = sanitizeHtml('a < b and 1<2 <not a tag');
    assert.ok(!out.includes('< b'));
    assert.ok(out.includes('&lt; b'));
  });

  await test('sanitizer survives the classic nested/entity tricks', () => {
    const out = sanitizeHtml('<scr<script>ipt>alert(1)</scr</script>ipt>');
    assert.ok(!/<script/i.test(out), `script tag survived: ${out}`);
    const entity = sanitizeHtml('&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.ok(!/<script/i.test(entity), 'entities must not decode into tags');
  });

  await test('CSV: formula cells are neutralised, real numbers stay numbers', () => {
    assert.strictEqual(csvCell('=HYPERLINK("http://evil","open")'), `"'=HYPERLINK(""http://evil"",""open"")"`);
    assert.strictEqual(csvCell('+1'), `'+1`);
    assert.strictEqual(csvCell('@SUM(A1)'), `'@SUM(A1)`);
    assert.strictEqual(csvCell('-1+cmd|calc'), `'-1+cmd|calc`);
    assert.strictEqual(csvCell(-1250.5), '-1250.5', 'a plain number must not gain a quote');
    assert.strictEqual(csvCell('a,b'), '"a,b"');
    assert.strictEqual(csvCell('say "hi"'), '"say ""hi"""');
    assert.strictEqual(csvRow(['ok', '=1+1']), `ok,'=1+1`);
  });

  await test('password policy: length + letter + digit, one rule everywhere', () => {
    const strong = 'ChangeMe#2026';
    assert.strictEqual(strong.length >= PASSWORD_MIN_LENGTH, true);
    assert.doesNotThrow(() => assertStrongPassword(strong));
    for (const weak of ['short1', 'alllettersno', '1234567890', '', 'Aa1'.padEnd(PASSWORD_MIN_LENGTH - 1, 'x'), ' padded1pass ']) {
      assert.throws(() => assertStrongPassword(weak), `accepted weak password: ${JSON.stringify(weak)}`);
    }
  });

  await test('uploads: declared type must match the bytes', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32),
    ]);
    assert.strictEqual(sniffImageType(png)?.mime, 'image/png');
    assert.strictEqual(declaredTypeMatchesBytes('image/png', png), true);
    assert.strictEqual(declaredTypeMatchesBytes('image/jpeg', png), false, 'PNG claimed as JPEG');
    assert.strictEqual(declaredTypeMatchesBytes('image/png', Buffer.from('<html><script>alert(1)</script>')), false);
    assert.strictEqual(declaredTypeMatchesBytes('application/pdf', Buffer.from('%PDF-1.7\n...')), true);
    assert.strictEqual(declaredTypeMatchesBytes('application/pdf', Buffer.from('not a pdf at all')), false);
    // a .docx/.xlsx is a zip container, which is why those types are allowed on a zip signature
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    assert.strictEqual(declaredTypeMatchesBytes('application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip), true);
    assert.strictEqual(declaredTypeMatchesBytes('text/plain', Buffer.from('hello\nworld')), true);
    assert.strictEqual(declaredTypeMatchesBytes('text/plain', Buffer.from([0x00, 0x01, 0x02, 0x03])), false);
  });

  await test('JWT secret: refuses to run without one outside development', () => {
    const before = { secret: process.env.JWT_SECRET, env: process.env.APP_ENV, nodeEnv: process.env.NODE_ENV };
    try {
      process.env.APP_ENV = 'production';
      process.env.NODE_ENV = 'production';
      delete process.env.JWT_SECRET;
      assert.throws(() => jwtSecret(), /JWT_SECRET is not set/);
      process.env.JWT_SECRET = 'too-short';
      assert.throws(() => jwtSecret(), /too short/);
      process.env.JWT_SECRET = 'a-properly-long-production-secret';
      assert.strictEqual(jwtSecret(), 'a-properly-long-production-secret');

      process.env.APP_ENV = 'development';
      process.env.NODE_ENV = 'development';
      delete process.env.JWT_SECRET;
      assert.strictEqual(jwtSecret(), 'dev_only_secret_change_me', 'development keeps the local fallback');
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  const summary = failures.length ? `\nFAILED (${failures.length}): ${failures.join(' | ')}` : `\n${passed} passed, 0 failed`;
  console.log(summary);
  if (failures.length) process.exit(1);
})();
