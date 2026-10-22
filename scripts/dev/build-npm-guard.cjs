#!/usr/bin/env node
/**
 * npm `build` interceptor — runs from ANY cwd (including the UNC workspace
 * `\\192.168.100.110\admin`) and always builds the frontend from a real
 * drive-letter cwd so package resolution works.
 *
 * npm always runs lifecycle scripts with cwd = the package.json directory. On
 * this workstation that directory is reached through a UNC path whenever the
 * workspace lives on the share (\\192.168.100.110\admin\frontend). Node's
 * package.json walk across SMB drops the UNC prefix, then esbuild/vite resolve
 * packages relative to that drive-less path and die with:
 *
 *   [plugin: externalize-deps] Failed to resolve entry for package vite
 *
 * The fix is structural: the real build runs through build-frontend.cjs, which
 * prefers the mapped Y:\frontend cwd (fallback: the UNC path itself) — so a
 * plain `npm run build` succeeds from anywhere. The drive-letter-cwd branch of
 * build-frontend.cjs runs vite directly with no extra process for callers
 * already on Y: (Docker / CI / local shells).
 *
 * (Same SMB package.json-walk issue documented in scan-hooks.cjs).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');

const args = process.argv.slice(2);

if (args[0] === 'build') {
  const mapped = 'Y:\\frontend';
  const cwd = fs.existsSync(`${mapped}\\package.json`)
    ? mapped
    : '\\\\192.168.100.110\\admin\\frontend'; // fallback if Y: is not mapped

  if (cwd !== mapped) {
    console.error(
      `WARNING: connected via UNC path — building from ${cwd} to avoid the ` +
        'esbuild "externalize-deps" resolve error (drive-letter cwd required).',
    );
  }

  const res = spawnSync(
    process.execPath,
    [String.raw`node_modules\vite\bin\vite.js`, 'build'],
    { cwd, encoding: 'utf8', timeout: 600000, windowsHide: true },
  );

  const out = (res.stdout || '').trim();
  const err = (res.stderr || '').trim();
  if (out) console.log(out.slice(-4000));
  if (err) console.error(err.slice(-2000));
  console.log('cwd:', cwd);
  console.log('exit code:', res.status);
  process.exit(res.status === 0 ? 0 : 1);
}
// Unknown script — hand back to npm normally (other scripts untouched).