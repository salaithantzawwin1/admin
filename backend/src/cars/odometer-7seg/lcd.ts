import { Box, Gray, clampBox, crop, downscale, otsu } from './image';

/**
 * Finding the ODO row on a dashboard photo.
 *
 * Two facts drive the design:
 *
 *  1. A seven-segment row has a signature nothing else on a dashboard repeats:
 *     five to seven compact, equally tall glyphs on one baseline with even gaps,
 *     inside a dark LCD panel, with a short "ODO" label just to their left.
 *  2. A phone photo of a dashboard is hard: glare, blur, the speedometer's tick
 *     marks, the clock, the TRIP row. A pure bottom-up search over the whole
 *     frame finds tick marks as often as digits.
 *
 * So the first photo of a dashboard is marked by a human (the labelling screen
 * sends the box; see `analyze`/`label`), and that box is stored as a prior. From
 * then on the detector only has to search a window around the prior — which is
 * cheap and reliable — and a confident full-frame search is still used when no
 * prior exists yet.
 */

export interface DigitRow {
  /** the digits, in photo coordinates */
  row: Box;
  /** the "ODO" label to the left of the row, when one was seen */
  label: Box | null;
  glyphs: Box[];
  polarity: 'light' | 'dark';
  score: number;
}

interface Comp {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

function components(mask: Uint8Array, w: number, h: number, minArea: number): Comp[] {
  const seen = new Uint8Array(mask.length);
  const out: Comp[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let area = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % w;
      const y = (p - x) / w;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) {
        seen[p - 1] = 1;
        stack.push(p - 1);
      }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) {
        seen[p + 1] = 1;
        stack.push(p + 1);
      }
      if (y > 0 && mask[p - w] && !seen[p - w]) {
        seen[p - w] = 1;
        stack.push(p - w);
      }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) {
        seen[p + w] = 1;
        stack.push(p + w);
      }
    }
    if (area >= minArea) out.push({ x0, y0, x1, y1, area });
  }
  return out;
}

const height = (c: Comp) => c.y1 - c.y0 + 1;
const width = (c: Comp) => c.x1 - c.x0 + 1;
const centerY = (c: Comp) => (c.y0 + c.y1) / 2;

function bbox(list: Comp[]): Box {
  const x0 = Math.min(...list.map((c) => c.x0));
  const y0 = Math.min(...list.map((c) => c.y0));
  const x1 = Math.max(...list.map((c) => c.x1));
  const y1 = Math.max(...list.map((c) => c.y1));
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Longest run of horizontally adjacent, same-height blobs. */
function chainFrom(seed: Comp, all: Comp[]): Comp[] {
  const h = height(seed);
  const same = all.filter(
    (c) =>
      Math.abs(centerY(c) - centerY(seed)) <= Math.max(2, h * 0.35) &&
      Math.abs(height(c) - h) <= Math.max(2, h * 0.25) &&
      width(c) <= h * 1.6,
  );
  same.sort((a, b) => a.x0 - b.x0);

  let best: Comp[] = [];
  let run: Comp[] = [];
  for (const c of same) {
    const last = run[run.length - 1];
    const gap = last ? c.x0 - last.x1 : 0;
    // a chain may skip one glyph (a thin "1" can be filtered out) — up to 1.3h
    if (last && gap >= -Math.max(1, h * 0.25) && gap <= Math.max(4, h * 1.3)) {
      run.push(c);
    } else {
      if (run.length > best.length) best = run;
      run = [c];
    }
  }
  if (run.length > best.length) best = run;
  return best;
}

/** A short blob immediately left of the row — the "ODO" (or "TRIP") label. */
function labelLeftOf(row: Comp[], all: Comp[]): Comp | null {
  const box = bbox(row);
  const h = box.h;
  let best: Comp | null = null;
  for (const c of all) {
    if (height(c) > h * 0.85 || width(c) > h * 1.1) continue;
    if (c.x1 > box.x || c.x0 < box.x - Math.max(8, h * 2.4)) continue;
    if (Math.abs(centerY(c) - (box.y + h / 2)) > h * 0.6) continue;
    if (!best || width(c) * height(c) > width(best) * height(best)) best = c;
  }
  return best;
}

function componentsFor(g: Gray, polarity: 'light' | 'dark', threshold: number, minArea: number): Comp[] {
  const mask = new Uint8Array(g.data.length);
  for (let i = 0; i < mask.length; i++) {
    const v = g.data[i];
    mask[i] = (polarity === 'light' ? v > threshold : v <= threshold) ? 1 : 0;
  }
  return components(mask, g.w, g.h, minArea);
}

/** Glyph-shaped components: compact, part-inked, not a tick or a wide letter. */
function glyphShape(g: Gray) {
  return (c: Comp): boolean => {
    const h = height(c);
    const w = width(c);
    const fill = c.area / (w * h);
    return (
      h >= Math.max(4, g.h * 0.02) &&
      h <= g.h * 0.35 &&
      w >= 2 &&
      // a seven-segment "1" is two thin bars: the narrowest legitimate glyph
      w / h >= 0.15 &&
      w / h <= 1.5 &&
      // a thin-barred seven-segment glyph can ink as little as a tenth of its box,
      // and a solid narrow "1" inks all of it — the aspect test is what keeps
      // the speedo's tick marks out, not the fill ceiling
      fill >= 0.1 &&
      c.area >= h * 1.8
    );
  };
}

/** Bottom-up search of one image (or window). Coordinates are image-local. */
function detect(g: Gray): DigitRow | null {
  const small = downscale(g, 640);
  const sx = g.w / small.w;
  const sy = g.h / small.h;
  const threshold = otsu(small);
  const minArea = Math.max(4, Math.round(small.w * small.h * 0.00002));

  let best: { row: Comp[]; all: Comp[]; polarity: 'light' | 'dark'; score: number } | null = null;

  for (const polarity of ['light', 'dark'] as const) {
    // the label ("ODO") is shorter and thinner than a digit, so it is looked for
    // among every blob, not only the glyph-shaped ones
    const raw = componentsFor(small, polarity, threshold, minArea);
    const all = raw.filter(glyphShape(small));
    for (const seed of all) {
      const row = chainFrom(seed, all);
      if (row.length < 5 || row.length > 8) continue;
      const box = bbox(row);
      if (box.w < small.w * 0.05 || box.w > small.w * 0.6) continue;

      const heights = row.map(height);
      const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
      const spread = (Math.max(...heights) - Math.min(...heights)) / Math.max(1, mean);
      if (spread > 0.35) continue;
      const label = labelLeftOf(row, raw);
      // equal heights, six or seven of them, a label beside them
      const score =
        row.length - spread * 3 + (label ? 1.2 : 0) + (row.length === 6 || row.length === 7 ? 0.6 : 0) - box.w / small.w;
      if (!best || score > best.score) best = { row, all: raw, polarity, score };
    }
  }
  if (!best) return null;

  const label = labelLeftOf(best.row, best.all);
  const sorted = [...best.row].sort((a, b) => a.x0 - b.x0);
  return {
    row: bbox(sorted),
    label: label ? { x: label.x0, y: label.y0, w: width(label), h: height(label) } : null,
    glyphs: sorted.map((c) => ({ x: c.x0, y: c.y0, w: width(c), h: height(c) })),
    polarity: best.polarity,
    score: best.score,
  };
}

/** Shift a detection made inside a crop back into frame coordinates. */
function shiftBox(b: Box, dx: number, dy: number, g: Gray): Box {
  return clampBox({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, g.w, g.h);
}

function scaled(row: DigitRow, kx: number, ky: number, g: Gray, dx = 0, dy = 0): DigitRow {
  return {
    row: shiftBox({ x: row.row.x * kx, y: row.row.y * ky, w: row.row.w * kx, h: row.row.h * ky }, dx, dy, g),
    label: row.label ? shiftBox({ x: row.label.x * kx, y: row.label.y * ky, w: row.label.w * kx, h: row.label.h * ky }, dx, dy, g) : null,
    glyphs: row.glyphs.map((b) => shiftBox({ x: b.x * kx, y: b.y * ky, w: b.w * kx, h: b.h * ky }, dx, dy, g)),
    polarity: row.polarity,
    score: row.score,
  };
}

/**
 * The ODO row on a dashboard photo, or null when nothing looks like one.
 * With a `prior` (a labelled row, in frame coordinates) only a window around it
 * is searched; without one the whole frame is.
 */
export function findDigitRow(g: Gray, prior: Box | null = null): DigitRow | null {
  if (prior) {
    const padX = Math.max(prior.w * 0.8, prior.h * 4);
    const padY = Math.max(prior.h * 5, g.h * 0.12);
    const win = clampBox(
      { x: prior.x - padX, y: prior.y - padY, w: prior.w + 2 * padX, h: prior.h + 2 * padY },
      g.w,
      g.h,
    );
    if (win.w > 8 && win.h > 8) {
      const sub = crop(g, win);
      const found = detect(sub);
      if (found) {
        const small = downscale(sub, 640);
        return scaled(found, sub.w / Math.max(1, small.w), sub.h / Math.max(1, small.h), g, win.x, win.y);
      }
    }
  }
  const full = detect(g);
  if (!full) return null;
  const kx = g.w / Math.max(1, downscale(g, 640).w);
  const ky = g.h / Math.max(1, downscale(g, 640).h);
  return scaled(full, kx, ky, g);
}

/** Median of previously labelled rows, as frame fractions (or null). */
export function medianPrior(rows: Array<{ rx: number; ry: number; rw: number; rh: number }>): Box | null {
  if (!rows.length) return null;
  const pick = (key: 'rx' | 'ry' | 'rw' | 'rh') => {
    const values = rows.map((r) => r[key]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : 0;
  };
  return { x: pick('rx'), y: pick('ry'), w: pick('rw'), h: pick('rh') };
}

/** A prior stored as fractions → frame pixels. */
export function priorBox(fractions: Box | null, g: Gray): Box | null {
  if (!fractions) return null;
  return clampBox({ x: fractions.x * g.w, y: fractions.y * g.h, w: fractions.w * g.w, h: fractions.h * g.h }, g.w, g.h);
}
