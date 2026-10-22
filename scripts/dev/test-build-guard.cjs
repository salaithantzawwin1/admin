#!/usr/bin/env node
/**
 * Regression test for the UNC fail-fast build guard (build-frontend.cjs).
 *
 * Run: node scripts/dev/test-build-guard.cjs
 *
 * Asserts, without touching the network or needing Y: to be unmapped:
 *   1. chooseBuildCwd() refuses a UNC cwd when Y:\frontend is NOT mapped
 *      (exit path = the clear "net use Y:" message, never a cryptic esbuild
 *      externalize-deps error) — the regression this guard exists for.
 *   2. chooseBuildCwd() builds in Y:\frontend when the mapping exists.
 *   3. chooseBuildCwd() builds in-place for a drive-letter cwd when Y: is
 *      missing (Docker/CI/local shells).
 *   4. The fail-fast message tells the user the exact remediation command.
 *   5. frontend/package.json build -> build.cjs launcher, which delegates to
 *      build-npm-guard.cjs when the repo layout exists (workstation) and runs
 *      vite directly inside the Docker image where ../scripts is absent.
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const {
  chooseBuildCwd,
  failFastMessage,
  MAPPED,
  UNC_PREFIX,
} = require('./build-frontend.cjs');

const UNC_CWD = '\\\\192.168.100.110\\admin\\frontend';
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  OK  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
    process.exitCode = 1;
  }
}

check('UNC cwd + Y: unmapped -> fail-fast (the regression guard)', () => {
  const r = chooseBuildCwd(UNC_CWD, false);
  assert.strictEqual(r.action, 'fail-fast');
  assert.strictEqual(r.cwd, UNC_CWD);
});

check('UNC cwd + Y: mapped -> builds in Y:\\frontend', () => {
  const r = chooseBuildCwd(UNC_CWD, true);
  assert.deepStrictEqual(r, { action: 'build', cwd: MAPPED });
});

check('drive-letter cwd + Y: unmapped -> builds in place', () => {
  const r = chooseBuildCwd('C:\\repo', false);
  assert.deepStrictEqual(r, { action: 'build', cwd: 'C:\\repo' });
});

check('mapped-cwd constant is Y:\\frontend', () => {
  assert.strictEqual(MAPPED, 'Y:\\frontend');
  assert.strictEqual(UNC_PREFIX, '\\\\');
});

check('fail-fast message contains the net use remediation', () => {
  const msg = failFastMessage(UNC_CWD);
  assert.ok(msg.includes('ERROR: Cannot build from a UNC workspace path'));
  assert.ok(msg.includes('net use Y: \\\\192.168.100.110\\admin'));
  assert.ok(msg.includes(UNC_CWD));
});

check('both guard files pass node --check', () => {
  for (const f of ['build-frontend.cjs', 'build-npm-guard.cjs']) {
    const res = spawnSync(process.execPath, ['--check', f], {
      encoding: 'utf8',
      cwd: __dirname,
    });
    assert.strictEqual(
      res.status,
      0,
      `${f}: ${(res.stderr || '').split('\n')[0]}`,
    );
  }
});

check('npm build script points at the build.cjs launcher', () => {
  const pkg = require(path.join(__dirname, '..', '..', 'frontend', 'package.json'));
  assert.strictEqual(
    pkg.scripts.build,
    'node build.cjs',
    `frontend build script is: ${pkg.scripts.build}`,
  );
});

check('launcher delegates to the guard, vite-direct fallback for Docker', () => {
  const launcher = require('fs').readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'build.cjs'),
    'utf8',
  );
  assert.ok(
    launcher.includes('build-npm-guard.cjs'),
    'launcher no longer references the UNC guard',
  );
  assert.ok(launcher.includes('vite'), 'launcher lost its vite fallback');
  assert.strictEqual(
    spawnSync(process.execPath, ['--check', 'build.cjs'], {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..', '..', 'frontend'),
    }).status,
    0,
    'frontend/build.cjs fails node --check',
  );
});

console.log(
  process.exitCode
    ? `\nFAILED — ${passed} passed, at least one assertion failed`
    : `\nPASS — ${passed} assertions green`,
);
