import { PATCH_BYTES } from './segment';

/**
 * The classifier: nearest neighbour over digit glyphs cut from real photos.
 *
 * Deliberately not a trained network. A fleet has a handful of dashboard models,
 * a seven-segment font is a fixed geometry, and a labelled glyph of "3" from the
 * same LCD is a better reference than a model trained on printed type. It also
 * means the "training" is something an administrator can do from the panel:
 * label a photo, its glyphs become templates, and the reader gets better the same
 * minute — with no build, no dataset upload and no GPU.
 */

export interface Template {
  digit: string;
  patch: Uint8Array;
}

/**
 * A glyph is accepted at ≥ 0.80 correlation with a ≥ 0.04 lead over the runner-up.
 * The numbers come from test/odometer-7seg.test.ts: across a 30–44 px size change
 * the right digit scores 0.82–0.97, and the nearest wrong digit trails by 0.05+
 * even in the worst case. Below both, the reader stays silent.
 */
export const SCORE_MIN = 0.8;
/** ...and when the winner is clearly ahead of the runner-up (3 vs 8 vs 9). */
export const MARGIN_MIN = 0.04;

export interface Match {
  digit: string | null;
  score: number;
  margin: number;
  runnerUp: string | null;
  confident: boolean;
}

export function similarity(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  // Pearson correlation on the mean-removed patches: bar thickness changes a
  // little between a 30 px and a 44 px glyph, and a pixel difference punishes
  // that while a correlation does not. Mapped to 0..1 so 1 is identical.
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (!da || !db) return 0;
  return (1 + num / Math.sqrt(da * db)) / 2;
}

/** Best template per digit, so one bad sample cannot outvote its own digit. */
export function classifyPatch(patch: Uint8Array, templates: Template[]): Match {
  const best = new Map<string, number>();
  for (const t of templates) {
    if (!t.patch || t.patch.length !== patch.length) continue;
    const score = similarity(patch, t.patch);
    const prev = best.get(t.digit);
    if (prev === undefined || score > prev) best.set(t.digit, score);
  }
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { digit: null, score: 0, margin: 0, runnerUp: null, confident: false };

  const [digit, score] = ranked[0];
  const runnerUp = ranked[1] ?? null;
  const margin = runnerUp ? score - runnerUp[1] : score;
  return {
    digit,
    score,
    margin,
    runnerUp: runnerUp ? runnerUp[0] : null,
    confident: score >= SCORE_MIN && margin >= MARGIN_MIN,
  };
}

/** DB rows → templates; a row whose patch is the wrong size is skipped, not fatal. */
export function decodeTemplates(rows: Array<{ digit: string; patch: string }>): Template[] {
  const out: Template[] = [];
  for (const row of rows) {
    if (!row?.digit || !row.patch) continue;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(row.patch, 'base64');
    } catch {
      continue;
    }
    if (bytes.length !== PATCH_BYTES) continue;
    out.push({ digit: row.digit, patch: new Uint8Array(bytes) });
  }
  return out;
}
