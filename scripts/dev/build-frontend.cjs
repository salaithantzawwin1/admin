const { spawnSync } = require('child_process');

// Build the frontend with a correct UNC cwd (vite/esbuild fail when the parent
// process cwd is a UNC path; spawnSync sets the child's cwd cleanly).
const res = spawnSync(
  process.execPath,
  [String.raw`node_modules\vite\bin\vite.js`, 'build'],
  { cwd: '\\\\192.168.100.110\\admin\\frontend', encoding: 'utf8', timeout: 600000, windowsHide: true },
);
const out = (res.stdout || '').trim();
const err = (res.stderr || '').trim();
if (out) console.log(out.slice(-4000));
if (err) console.error(err.slice(-2000));
console.log('exit code:', res.status);
process.exit(res.status === 0 ? 0 : 1);
