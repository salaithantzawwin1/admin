const { spawnSync } = require('child_process');
const fs = require('fs');

// Build the frontend from a DRIVE-LETTER cwd. A UNC cwd (\\192.168.100.110\admin\frontend)
// breaks esbuild/vite package resolution — "[plugin: externalize-deps] Failed to
// resolve entry for package vite" — the same Node-over-SMB package.json walk issue
// documented in scan-hooks.cjs (observed 2026-10-16; the old UNC-cwd version failed
// exactly there). The share is mapped to Y: on this workstation, so Y:\frontend
// gives Node a real drive path while still editing files on the server.
const mapped = 'Y:\\frontend';
const cwd = fs.existsSync(`${mapped}\\package.json`)
  ? mapped
  : '\\\\192.168.100.110\\admin\\frontend'; // fallback if Y: is not mapped

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
