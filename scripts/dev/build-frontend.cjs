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
const MAPPED = 'Y:\\frontend';
const UNC_PREFIX = '\\\\';

// Pure decision function (exported for scripts/dev/test-build-unc-guard.cjs):
// given the caller's cwd and whether Y:\frontend\package.json exists, return
// the action plus the cwd to build in.
function chooseBuildCwd(cwd, mappedOk) {
  if (mappedOk) return { action: 'build', cwd: MAPPED };
  // If already invoked from a non-UNC cwd (e.g. someone cd'd to a drive-letter
  // path on their own), build there. Only refuse the UNC-cwd case.
  if (cwd.startsWith(UNC_PREFIX)) return { action: 'fail-fast', cwd };
  return { action: 'build', cwd };
}

function failFastMessage(cwd) {
  return [
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
  ].join('\n');
}

function main() {
  const mappedOk = fs.existsSync(`${MAPPED}\\package.json`);
  const choice = chooseBuildCwd(process.cwd(), mappedOk);

  if (choice.action === 'fail-fast') {
    console.error(failFastMessage(choice.cwd));
    process.exit(1);
  }

  // Drive-letter cwd (Y:\frontend or any local path) — spawn vite there.
  const res = spawnSync(
    process.execPath,
    [String.raw`node_modules\vite\bin\vite.js`, 'build'],
    { cwd: choice.cwd, encoding: 'utf8', timeout: 600000, windowsHide: true },
  );

  const out = (res.stdout || '').trim();
  const err = (res.stderr || '').trim();
  if (out) console.log(out.slice(-4000));
  if (err) console.error(err.slice(-2000));
  console.log('cwd:', choice.cwd);
  console.log('exit code:', res.status);
  process.exit(res.status === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = { chooseBuildCwd, failFastMessage, MAPPED, UNC_PREFIX };
