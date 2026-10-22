#!/usr/bin/env node
/**
 * npm `build` launcher — the single entry point from frontend/package.json.
 *
 * Two environments, one script:
 *
 *  1. Repo checkout (workstation, mapped Y:\frontend): the sibling
 *     ../scripts/dev/build-npm-guard.cjs exists — delegate to it. That guard
 *     refuses UNC cwds with a clear message and builds from the mapped
 *     Y:\frontend drive (see that file for the full SMB/esbuild story).
 *
 *  2. Docker/CI image: the build context is frontend/ only, so ../scripts
 *     does not exist inside the image (frontend/Dockerfile: COPY . .).
 *     The image cwd (/app) is a plain local path — never UNC — so run vite
 *     directly. This branch kept `npm run build` green in the production
 *     image after the UNC guard was introduced (deploy 2026-10-22).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoGuard = path.join(__dirname, '..', 'scripts', 'dev', 'build-npm-guard.cjs');
const useGuard = fs.existsSync(repoGuard);
const target = useGuard ? repoGuard : path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js');
const args = useGuard ? [repoGuard, 'build'] : [target, 'build'];

const res = spawnSync(process.execPath, args, {
  cwd: __dirname,
  stdio: 'inherit',
  timeout: 600000,
  windowsHide: true,
});

if (res.error) {
  console.error(res.error.message);
  process.exit(1);
}
process.exit(res.status === null ? 1 : res.status);
