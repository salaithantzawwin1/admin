const { spawnSync } = require('child_process');

// Runs the car-module unit tests via ts-node (transpile-only, like the e2e harness).
const res = spawnSync(
  process.execPath,
  ['-r', 'ts-node/register/transpile-only', 'test/cars-fixes.test.ts'],
  { cwd: '\\\\192.168.100.110\\admin\\backend', encoding: 'utf8', timeout: 240000, windowsHide: true },
);
const out = (res.stdout || '').trim();
const err = (res.stderr || '').trim();
if (out) console.log(out);
if (err) console.error(err.slice(0, 6000));
console.log('exit code:', res.status);
process.exit(res.status === 0 ? 0 : 1);
