/* Static audit of table column alignment.
 *
 * For every table in the frontend sources — raw <table> markup AND the shared
 * <Table head={[...]}> component — pairs each <th> with the <td> occupying the
 * same column index and reports where the header's text-align disagrees with
 * its cell's (e.g. a right-aligned value under a left-aligned header: the
 * COST (MMK) case). Tailwind preflight makes th inherit, so the effective
 * alignment is: explicit class on the element, else the <tr> class, else
 * "start". For <Table>, header classes come from ui.tsx (CENTERED_COLS /
 * RIGHT_COLS), which are parsed so this audit can never drift from the
 * component.
 *
 *   node scripts/dev/audit-col-align.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'frontend', 'src');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

// className may be a double-quoted string or a JSX expression with a template
// literal (`className={`…`}`) — inside the literal only the part before the
// first ${ interpolation is static.
const clsOf = (el) => {
  const m = /className=\s*\{?\s*(?:"([^"]*)"|`([^`]*)`)/.exec(el);
  if (!m) return '';
  return (m[1] ?? m[2] ?? '').split('${')[0];
};
const alignOf = (cls = '') => {
  const m = /text-(center|right|left|start|end)\b/.exec(cls);
  return m ? m[1] : null;
};
// effective alignment: element class → <tr> tag class → default.
// Only the tr TAG may supply the fallback: scanning the whole row string
// would pick up a sibling cell's text-center and report a phantom mismatch.
const rowClsOf = (row) => /^<tr\b[^>]*/.exec(row)?.[0] || '';
const effective = (elCls, row) => alignOf(elCls) ?? alignOf(rowClsOf(row)) ?? 'start';
// normalise Tailwind/semantic synonyms for comparison
const norm = (a) => ({ start: 'left', end: 'right' }[a] ?? a);

const labelOf = (el) => (el.replace(/<[^>]+>/g, '') || '').trim();

/** Extract whole `<tag ...>...</tag>` (or self-closing) elements without
 *  letting a `>` inside a className template literal (`${x >= 1 ? ...}`) end
 *  the tag early — a plain regex truncates there and loses the class. */
function findTags(src, tag) {
  const out = [];
  const open = new RegExp('<' + tag + '\\b', 'g');
  let m;
  while ((m = open.exec(src))) {
    let i = m.index + tag.length + 1;
    let quote = null;
    let selfClose = false;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '>') {
        selfClose = src[i - 1] === '/';
        break;
      }
    }
    if (i >= src.length) break;
    if (selfClose) {
      out.push(src.slice(m.index, i + 1));
      continue;
    }
    const close = src.indexOf('</' + tag + '>', i);
    if (close < 0) break;
    out.push(src.slice(m.index, close + tag.length + 3));
  }
  return out;
}

const problems = [];

// --- header classes the shared Table component applies (parsed, not copied) ---
const uiSrc = fs.readFileSync(path.join(ROOT, 'components', 'ui.tsx'), 'utf8');
const setOf = (name) => {
  const m = new RegExp('const ' + name + ' = new Set\\(\\[([^\\]]*)\\]\\)').exec(uiSrc);
  return new Set(m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []);
};
const CENTERED_COLS = setOf('CENTERED_COLS');
const RIGHT_COLS = setOf('RIGHT_COLS');
const componentThAlign = (label) => {
  const k = label.trim().toUpperCase();
  if (CENTERED_COLS.has(k)) return 'center';
  if (RIGHT_COLS.has(k)) return 'right';
  return 'left';
};

const report = (file, ti, label, thAlign, tdAlign) => {
  problems.push({ file, table: ti, label, header: thAlign, cell: tdAlign });
};

const auditRows = (rows, getThAlign, file, ti, presetLabels) => {
  let headers = presetLabels ? { list: presetLabels, row: '' } : null;
  const bodyRows = [];
  for (const row of rows) {
    const ths = findTags(row, 'th');
    if (ths.length) {
      if (!headers) headers = { list: ths, row };
      continue;
    }
    const tds = findTags(row, 'td');
    // colspan rows (empty states) span the whole table — they carry no
    // per-column alignment and would report phantom mismatches
    if (tds.length && tds.some((td) => /\bcolSpan=/.test(td))) continue;
    if (tds.length) bodyRows.push({ list: tds, row });
  }
  if (!headers || !bodyRows.length) return;

  headers.list.forEach((th, i) => {
    const label = labelOf(th);
    // an empty <th /> renders nothing — there is no visible header to align
    if (!label) return;
    const thAlign = norm(getThAlign(th, label, i, headers.row));
    for (const body of bodyRows) {
      const td = body.list[i];
      if (!td) continue; // colspan row
      const tdAlign = norm(effective(clsOf(td), body.row));
      if (thAlign !== tdAlign) report(file, ti, label.slice(0, 24), thAlign, tdAlign);
    }
  });
};

for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');

  // raw <table ...> markup (no nesting in this codebase)
  const tables = src.match(/<table[\s\S]*?<\/table>/g) || [];
  tables.forEach((tbl, ti) => {
    const rows = tbl.match(/<tr[\s\S]*?<\/tr>/g) || [];
    auditRows(rows, (th, _label, _i, headerRow) => effective(clsOf(th), headerRow), rel, ti);
  });

  // shared <Table head={['A', 'B', ...]}>…</Table>
  const compRe = /<Table\s+head=\{\[([^\]]*)\]\}/g;
  let m;
  let ci = 0;
  while ((m = compRe.exec(src))) {
    const labels = [...m[1].matchAll(/['"]([^'"]*)['"]/g)].map((x) => x[1]);
    const end = src.indexOf('</Table>', m.index);
    if (end < 0) continue;
    const body = src.slice(m.index, end);
    const rows = body.match(/<tr[\s\S]*?<\/tr>/g) || [];
    // head array order defines the column order; ui.tsx decides header class
    auditRows(
      rows,
      (_th, _label, i) => componentThAlign(labels[i] ?? _label),
      rel,
      `component#${ci}`,
      labels,
    );
    ci++;
  }
}

if (!problems.length) {
  console.log('no header/value alignment mismatches found');
  process.exit(0);
}
// de-duplicate (one report per header/cell pair)
const seen = new Set();
const uniq = problems.filter((p) => {
  const k = `${p.file}|${p.table}|${p.label}|${p.header}|${p.cell}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
for (const p of uniq) {
  console.log(`${p.file}  [${p.table}]  "${p.label}": header=${p.header}  cell=${p.cell}`);
}
console.log(`\n${uniq.length} mismatch(es)`);
