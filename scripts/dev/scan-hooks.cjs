/**
 * Rules-of-Hooks static scan (run: node scripts/dev/scan-hooks.cjs).
 *
 * The scanning worker runs via `node -e` with cwd inside the frontend share:
 * requiring modules from a script FILE on a UNC path crashes Node's package.json
 * walk (ERR_INVALID_PACKAGE_CONFIG), while -e resolves from the (real) cwd.
 * File I/O over UNC is fine — only module resolution is affected.
 */
const { spawnSync } = require('child_process');

const worker = `
const ts = require(String.raw` + '`' + String.raw`\\192.168.100.110\admin\frontend\node_modules\typescript\lib\typescript.js` + '`' + `);
const fs = require('fs');
const path = require('path');

const ROOT = String.raw` + '`' + String.raw`\\192.168.100.110\admin\frontend\src` + '`' + `;
const HOOK_RE = /^use[A-Z0-9]/;
const findings = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\\.(tsx|ts)$/.test(e.name)) scan(p);
  }
}

// does this function look like a React component (capitalised name + JSX-ish return)?
function looksComponent(fn, name) {
  if (/^[A-Z]/.test(name)) return true;
  const body = (fn.body && fn.body.getFullText && fn.body.getFullText()) || '';
  return /return\\s*[(<]/.test(body);
}

function scan(file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let insideComponent = false;

  function visit(node) {
    const wasInside = insideComponent;

    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      const name = (ts.isFunctionDeclaration(node) && node.name && node.name.text) || '';
      const inner = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
      if (inner || looksComponent(node, name)) insideComponent = true;
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HOOK_RE.test(node.expression.text)) {
      // 1) hook inside a nested function while in a component scope
      let anc = node.parent;
      while (anc) {
        if (ts.isFunctionLike(anc)) {
          if (!ts.isFunctionDeclaration(anc) && insideComponent) {
            const kind = ts.isFunctionExpression(anc) ? 'IIFE/nested fn' : 'arrow/callback fn';
            findings.push(file + ':' + (sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1) + ' — ' + node.expression.text + '() inside nested ' + kind);
          }
          break;
        }
        anc = anc.parent;
      }
      // 2) hook after an early return in the same block
      let block = node.parent;
      while (block && !ts.isBlock(block) && !ts.isSourceFile(block)) block = block.parent;
      if (block && insideComponent && block.statements) {
        let sawReturn = false;
        for (const st of block.statements) {
          if (st === node || st.getStart(sf) > node.getStart(sf)) break;
          if (ts.isReturnStatement(st) && st.expression) { sawReturn = true; break; }
        }
        if (sawReturn) {
          findings.push(file + ':' + (sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1) + ' — ' + node.expression.text + '() after an early return');
        }
      }
    }

    ts.forEachChild(node, visit);
    insideComponent = wasInside;
  }

  visit(sf);
}

walk(ROOT);
if (findings.length === 0) {
  console.log('OK — no rules-of-hooks violations found');
} else {
  findings.forEach((f) => console.log(f));
  console.log('\\n' + findings.length + ' potential violation(s)');
  process.exitCode = 1;
}
`;

const res = spawnSync(process.execPath, ['-e', worker], {
  cwd: '\\\\192.168.100.110\\admin\\frontend',
  encoding: 'utf8',
  timeout: 120000,
  windowsHide: true,
});
if (res.stdout && res.stdout.trim()) console.log(res.stdout.trim());
if (res.stderr && res.stderr.trim()) console.error(res.stderr.trim().slice(0, 3000));
console.log('exit code:', res.status);
process.exit(res.status === 0 ? 0 : 1);
