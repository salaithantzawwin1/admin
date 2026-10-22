const { spawnSync } = require('child_process');
const fs = require('fs');

// Build the frontend from a real drive-letter cwd. A UNC cwd
// (\\192.168.100.110\admin\frontend) breaks esbuild/vite package resolution —
// "[plugin: externalize-deps] Failed to resolve entry for package vite" — the
// same Node-over-SMB package.json walk issue documented in scan-hooks.cjs
// (observed 2026-10-16; the old UNC-cwd version failed exactly there).
//
// The share is mapped to Y: on this workstation, so Y:\frontend gives Node a
// real drive path while still editing files on the server.
//
// FALLBACK: if Y: is not mapped, we fail fast with a clear message instead of
// letting esbuild emit the cryptic externalize-deps error.
const UNC_CWD = '\\\\192.168.100.110\\admin\\frontend';
const mapped = 'Y:\\frontend';
const mappedOk = fs.existsSync(`${mapped}\\package.json`);

if (!mappedOk) {
  const cwd = process.cwd();
  const isUnc = cwd.startsWith('\\\\');
  // If already invoked from a non-UNC cwd (e.g. someone cd'd to a drive-letter
  // path on their own), build there. Only refuse the UNC-cwd case.
  if (isUnc) {
    console.error(
      [
        '',
        'ERROR: Cannot build from a UNC workspace path:',
        `       ${cwd}`,
        '',
        'esbuild/vite lose the \\\\server\\share prefix and resolve packages',
        'against a drive-less path (externalize-deps: Failed to resolve entry',
        'for package vite) — observed 2026-10-16 on this workstation.',
        '',
        'Map the share to a drive letter, e.g.:',
        '',
        '   net use Y: \\\\192.168.100.110\\admin',
        '',
        'then run:',
        '',
        '   node scripts\\dev\\build-frontend.cjs',
        '',
        'This script will then use Y:\\frontend automatically.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

// Drive-letter cwd (Y:\frontend or any local path) — spawn vite there.
const cwd = mappedOk ? mapped : process.cwd();
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