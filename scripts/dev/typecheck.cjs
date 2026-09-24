const { spawnSync } = require('child_process');

const runs = [
  { name: 'backend tsc', cwd: '\\\\192.168.100.110\\admin\\backend', tsc: 'node_modules/typescript/bin/tsc', args: ['-p', 'tsconfig.json', '--noEmit'] },
  { name: 'frontend tsc', cwd: '\\\\192.168.100.110\\admin\\frontend', tsc: 'node_modules/typescript/bin/tsc', args: ['-b', '--noEmit'] },
];

let failed = false;
for (const run of runs) {
  console.log(`\n=== ${run.name} ===`);
  const res = spawnSync(process.execPath, [run.tsc, ...run.args], { cwd: run.cwd, encoding: 'utf8', timeout: 240000, windowsHide: true });
  const out = (res.stdout || '').trim();
  const err = (res.stderr || '').trim();
  if (out) console.log(out.slice(0, 8000));
  if (err) console.error(err.slice(0, 4000));
  console.log(`exit code: ${res.status}`);
  if (res.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
