#!/usr/bin/env node
/**
 * UNC guard for `npm run build` (frontend/package.json).
 *
 * npm always runs lifecycle scripts with cwd = the package.json directory.
 * When the workspace is opened through the SMB share (\\192.168.100.110\admin),
 * that directory is a UNC path. Node's package.json walk across SMB drops the
 * UNC prefix ("\\\\server\\share" → "C:\\Program Files\\nodejs\..."), then
 * esbuild/vite resolve packages relative to that drive-less path and die with:
 *
 *   [plugin: externalize-deps] Failed to resolve entry for package vite
 *
 * Observed 2026-10-16 (see scripts/dev/build-frontend.cjs, which works around
 * it by building from the mapped Y:\frontend cwd). Failing here with one clear
 * line beats letting vite spray cryptic resolve errors; the build itself is
 * unchanged — only the cwd trap is intercepted.
 *
 * Behavior:
 *   - UNC cwd  → print the exact command to run instead, exit 1 (FAIL FAST).
 *   - drive-letter cwd (Y:\frontend, docker, CI, plain local shell) → exec the
 *     package's original build script, fully transparent.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const raw = process.cwd(); // e.g. \\192.168.100.110\admin\frontend
const isUnc = raw.startsWith('\\\\') || /^[a-z]:/i.test(raw) === false;

if (isUnc) {
  console.error(
    [
      '',
      'ERROR: npm run build cannot run from a UNC workspace path:',
      `       ${raw}`,
      '',
      'esbuild/vite lose the \\\\server\\share prefix and resolve packages',
      'against a drive-less path (externalize-deps: Failed to resolve entry',
      'for package vite) — documented in scripts/dev/build-frontend.cjs.',
      '',
      'Run the drive-letter-cwd wrapper instead:',
      '',
      '   node scripts\\\\dev\\\\build-frontend.cjs',
      '',
      '(The share is mapped to Y: on this workstation; the wrapper builds',
      'from Y:\\frontend automatically when it is mapped.)',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

// Drive-letter cwd — this IS the safe path; run the original chain unmodified.
const res = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:raw'], {
  stdio: 'inherit',
  cwd: raw,
  env: process.env,
});
process.exit(res.status === null ? 1 : res.status);