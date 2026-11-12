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

/** Interpolate-free zoom: a 12–19 px ODO row on a 720p photo has to be read at 3–5×. */
function zoom(g: Gray, k: number): Gray {
  if (k <= 1) return g;
  const w = g.w * k;
  const h = g.h * k;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / k) * g.w;
    for (let x = 0; x < w; x++) data[y * w + x] = g.data[row + Math.floor(x / k)];
  }
  return { w, h, data };
}

function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** How much a candidate row looks like the row a human marked on this dashboard. */
function fitScore(box: Box, prior: Box): number {
  const ix = Math.max(0, Math.min(box.x + box.w, prior.x + prior.w) - Math.max(box.x, prior.x));
  const iy = Math.max(0, Math.min(box.y + box.h, prior.y + prior.h) - Math.max(box.y, prior.y));
  const contain = (ix * iy) / Math.max(1, Math.min(box.w * box.h, prior.w * prior.h));
  const hRatio = Math.min(box.h, prior.h) / Math.max(1, Math.max(box.h, prior.h));
  const dx = (box.x + box.w / 2 - (prior.x + prior.w / 2)) / Math.max(1, prior.w);
  const dy = (box.y + box.h / 2 - (prior.y + prior.h / 2)) / Math.max(1, prior.h);
  return contain * 3 + hRatio * 1.5 - Math.min(1.5, Math.hypot(dx, dy));
}

interface Candidate {
  row: Comp[];
  all: Comp[];
  box: Box;
  polarity: 'light' | 'dark';
  score: number;
}

/**
 * Every plausible digit chain in one crop: both polarities × three thresholds,
 * de-duplicated by overlap.
 *
 * Blur and glare move Otsu's valley, so one cut is not enough; and because the
 * window around a prior also holds the clock and the speedo numerals, the caller
 * — not the first lucky chain — decides which candidate is the ODO row.
 */
function chainCandidates(g: Gray): Candidate[] {
  const base = otsu(g);
  const minArea = Math.max(4, Math.round(g.w * g.h * 0.00002));
  const out: Candidate[] = [];
  for (const polarity of ['light', 'dark'] as const) {
    for (const level of [1, 0.7, 1.35]) {
      const threshold = Math.max(8, Math.min(247, Math.round(base * level)));
      const raw = componentsFor(g, polarity, threshold, minArea);
      const shaped = raw.filter(glyphShape(g));
      for (const seed of shaped) {
        const row = chainFrom(seed, shaped);
        if (row.length < 5 || row.length > 8) continue;
        const box = bbox(row);
        if (box.w < g.w * 0.05 || box.w > g.w * 0.98) continue;
        if (box.h > g.h * 0.7) continue;
        const heights = row.map(height);
        const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
        const spread = (Math.max(...heights) - Math.min(...heights)) / Math.max(1, mean);
        if (spread > 0.35) continue;
        const label = labelLeftOf(row, raw);
        out.push({
          row,
          all: raw,
          box,
          polarity,
          score:
            row.length - spread * 3 + (label ? 1.2 : 0) + (row.length === 6 || row.length === 7 ? 0.6 : 0) - box.w / g.w,
        });
      }
    }
  }
  const keep: Candidate[] = [];
  for (const c of out.sort((a, b) => b.score - a.score)) {
    if (keep.every((k) => iou(k.box, c.box) < 0.6)) keep.push(c);
  }
  return keep;
}

/**
 * Read the row the prior points at by column projection.
 *
 * Connected components are the wrong tool at this size: on a 12–20 px row the
 * bars of two neighbouring digits touch after JPEG blur, the pair arrives as one
 * wide blob, and every shape test drops it. Projecting ink down the columns of a
 * band around the prior instead only asks "where is there ink, and where is
 * there a gap" — which is exactly what a seven-segment row is.
 */
interface ProfileSpans {
  band: { y0: number; y1: number; median: number; threshold: number; score: number };
  colScores: number[];
  glyphs: Box[];
  score: number;
}

/**
 * Fit n evenly spaced cells to the row and let the column profile place each
 * separator in the emptiest column near where it should fall.
 *
 * This is what survives the two ways a 12–20 px seven-segment row breaks: blur
 * fuses two neighbouring digits into one blob, and the two bars of a "1" are far
 * enough apart to arrive as two blobs. A uniform grid does not care — it only
 * needs to find n−1 valleys, which the gaps between digits always are.
 */
function gridFit(
  colScores: number[],
  band: { y0: number; y1: number },
  x0: number,
  x1: number,
  n: number,
): { glyphs: Box[]; score: number } | null {
  const bandH = band.y1 - band.y0 + 1;
  const width = x1 - x0 + 1;
  const cell = width / n;
  if (cell < bandH * 0.25) return null;

  const bounds: number[] = [x0];
  for (let i = 1; i < n; i++) {
    const target = x0 + Math.round(i * cell);
    const reach = Math.max(1, Math.round(cell * 0.22));
    const from = Math.max(x0 + 1, target - reach);
    const to = Math.min(x1 - 1, target + reach);
    let at = target;
    let low = Infinity;
    for (let x = from; x <= to; x++) {
      if (colScores[x] < low) {
        low = colScores[x];
        at = x;
      }
    }
    bounds.push(at);
  }
  bounds.push(x1 + 1);

  const glyphs: Box[] = [];
  let inside = 0;
  for (let i = 0; i < n; i++) {
    const a = bounds[i];
    const b = bounds[i + 1] - 1;
    if (b - a + 1 < cell * 0.45) return null;
    glyphs.push({ x: a, y: band.y0, w: b - a + 1, h: bandH });
    for (let x = a; x <= b; x++) inside += colScores[x];
  }
  let total = 0;
  for (let x = x0; x <= x1; x++) total += colScores[x];
  const ratio = inside / Math.max(1, total);
  const mean = glyphs.reduce((s, g) => s + g.w, 0) / n;
  const spread = glyphs.reduce((s, g) => s + Math.abs(g.w - mean), 0) / n / Math.max(1, cell);
  return { glyphs, score: ratio - spread * 0.5 };
}

function profileSpans(g: Gray, prior: Box): ProfileSpans | null {
  const cy = prior.y + prior.h / 2;

  // 1. The band comes from the prior — the human marked this row, so only its
  //    height and a small vertical wobble are worth searching. Inside the band
  //    the panel is the median: a digit is whatever departs from it. (A global
  //    ink map does not work here: the bright panel itself out-inks the digits.)
  let band: { y0: number; y1: number; median: number; threshold: number; score: number } | null = null;
  for (const scale of [0.85, 1, 1.15]) {
    const bh = Math.max(6, Math.round(prior.h * scale));
    for (const dy of [0, -0.15, 0.15]) {
      const y0 = Math.max(0, Math.min(g.h - bh, Math.round(cy + dy * prior.h - bh / 2)));
      const y1 = y0 + bh - 1;
      let min = 255;
      let max = 0;
      const values = new Uint8Array(bh * g.w);
      let index = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = 0; x < g.w; x++) {
          const v = g.data[y * g.w + x];
          values[index++] = v;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      const range = max - min;
      if (range < 18) continue;
      const sorted = Array.from(values).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const threshold = Math.max(8, Math.round(range * 0.22));
      let total = 0;
      for (let i = 0; i < values.length; i++) if (Math.abs(values[i] - median) > threshold) total++;
      const off = Math.abs(y0 + bh / 2 - cy) / Math.max(1, prior.h);
      const score = total / bh - off * (g.h * 0.3);
      if (!band || score > band.score) band = { y0, y1, median, threshold, score };
    }
  }
  if (!band) return null;
  const bandH = band.y1 - band.y0 + 1;
  const anchor = band;
  const inked = (x: number) => {
    let n = 0;
    for (let y = anchor.y0; y <= anchor.y1; y++) {
      if (Math.abs(g.data[y * g.w + x] - anchor.median) > anchor.threshold) n++;
    }
    return n;
  };

  // 2. Glyphs: the row is a run of evenly spaced digits, so fit a uniform grid.
  const colScores: number[] = [];
  for (let x = 0; x < g.w; x++) colScores.push(inked(x));
  const x0 = Math.max(0, Math.min(g.w - 2, Math.round(prior.x)));
  const x1 = Math.max(x0 + 2, Math.min(g.w - 1, Math.round(prior.x + prior.w - 1)));
  let inkTotal = 0;
  for (let x = x0; x <= x1; x++) inkTotal += colScores[x];
  if (inkTotal < bandH * 2) return null;

  // 6 first: these odometers are six-digit, and a seven-cell fit always scores a
  // little higher (it can carve a valley out of any glyph), so it has to win by a
  // margin to be believed.
  let fitted: { glyphs: Box[]; score: number } | null = null;
  for (const n of [6, 7, 5]) {
    const fit = gridFit(colScores, anchor, x0, x1, n);
    if (fit && (!fitted || fit.score > fitted.score + 0.06)) fitted = fit;
  }
  if (!fitted) return null;
  return { band: anchor, colScores, glyphs: fitted.glyphs, score: fitted.score };
}

function profileRow(g: Gray, prior: Box): { row: Box; glyphs: Box[]; polarity: 'light' | 'dark' } | null {
  const found = profileSpans(g, prior);
  if (!found) return null;
  const band = found.band;
  const bandH = band.y1 - band.y0 + 1;
  const glyphs = found.glyphs;

  const x0 = Math.min(...glyphs.map((b) => b.x));
  const x1 = Math.max(...glyphs.map((b) => b.x + b.w - 1));

  // is the ink darker or lighter than the band it sits on?
  let inside = 0;
  let outside = 0;
  for (const glyph of glyphs) {
    for (let y = glyph.y; y < glyph.y + glyph.h; y++) {
      for (let x = glyph.x; x < glyph.x + glyph.w; x++) inside += g.data[y * g.w + x];
    }
  }
  const spanPixels = glyphs.reduce((n, b) => n + b.w * b.h, 0);
  let bandPixels = 0;
  for (let y = band.y0; y <= band.y1; y++) {
    for (let x = 0; x < g.w; x++) outside += g.data[y * g.w + x];
    bandPixels += g.w;
  }
  const polarity: 'light' | 'dark' = inside / Math.max(1, spanPixels) >= outside / Math.max(1, bandPixels) ? 'light' : 'dark';

  return { row: { x: x0, y: band.y0, w: x1 - x0 + 1, h: bandH }, glyphs, polarity };
}

/**
 * The ODO row on a dashboard photo, or null when nothing looks like one.
 * With a `prior` (a labelled row, in frame coordinates) only a window around it
 * is searched and nothing else; without one the whole frame is.
 */
export function findDigitRow(g: Gray, prior: Box | null = null): DigitRow | null {
  if (prior) {
    // A prior is authoritative: search its window only, and never fall back to a
    // cold full-frame search — a miss is fine, a row off the speedometer is not.
    const padX = Math.max(prior.w * 0.35, prior.h * 2.5);
    const padY = Math.max(prior.h * 2.5, g.h * 0.06);
    const win = clampBox(
      { x: prior.x - padX, y: prior.y - padY, w: prior.w + 2 * padX, h: prior.h + 2 * padY },
      g.w,
      g.h,
    );
    if (win.w < 8 || win.h < 8) return null;

    const sub = crop(g, win);
    // 12–19 px digits smear into their neighbours at 1×: read the window zoomed
    const k = Math.max(1, Math.min(5, Math.round(64 / Math.max(8, prior.h))));
    const big = zoom(sub, k);
    const priorLocal: Box = { x: (prior.x - win.x) * k, y: (prior.y - win.y) * k, w: prior.w * k, h: prior.h * k };

    const inv = 1 / k;
    const toFrame = (b: Box): Box =>
      clampBox({ x: win.x + b.x * inv, y: win.y + b.y * inv, w: b.w * inv, h: b.h * inv }, g.w, g.h);

    // projection first: it survives the blur that fuses neighbouring digits
    const prof = profileRow(big, priorLocal);
    if (prof) {
      const rowBox = toFrame(prof.row);
      return {
        row: rowBox,
        label: null,
        glyphs: prof.glyphs.map(toFrame),
        polarity: prof.polarity,
        score: fitScore(prof.row, priorLocal) + prof.glyphs.length,
      };
    }

    const cands = chainCandidates(big);
    if (!cands.length) return null;

    let best: { c: Candidate; total: number } | null = null;
    for (const c of cands) {
      const total = fitScore(c.box, priorLocal) + c.score;
      if (!best || total > best.total) best = { c, total };
    }
    if (!best) return null;

    const sorted = [...best.c.row].sort((a, b) => a.x0 - b.x0);
    const lab = labelLeftOf(sorted, best.c.all);
    return {
      row: toFrame(bbox(sorted)),
      label: lab ? toFrame({ x: lab.x0, y: lab.y0, w: width(lab), h: height(lab) }) : null,
      glyphs: sorted.map((c) => toFrame({ x: c.x0, y: c.y0, w: width(c), h: height(c) })),
      polarity: best.c.polarity,
      score: best.total,
    };
  }
  const full = detect(g);
  if (!full) return null;
  const kx = g.w / Math.max(1, downscale(g, 640).w);
  const ky = g.h / Math.max(1, downscale(g, 640).h);
  return scaled(full, kx, ky, g);
}

/**
 * Try every prior this dashboard has and keep the best-fitting result.
 *
 * Returns null when the list is empty — the caller decides whether a cold
 * full-frame search is worth it; with no prior there is nothing to be faithful to.
 */
export function findDigitRowAmong(g: Gray, priors: Box[]): DigitRow | null {
  let best: DigitRow | null = null;
  for (const p of priors) {
    const r = findDigitRow(g, p);
    if (r && (!best || r.score > best.score)) best = r;
  }
  return best;
}

/**
 * A coarse fingerprint of the dashboard in a photo.
 *
 * One dashboard puts its ODO row where another puts its clock, so a prior is
 * only meaningful for the dashboard it was labelled on. The key is 32×18 cells
 * thresholded at the frame's own mean: 576 bits, insensitive to exposure, and
 * different enough between two instrument clusters to keep their priors apart.
 */
export function dashboardKey(g: Gray): string {
  const small = downscale(g, 32);
  const cols = 32;
  const rows = 18;
  const cells = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    const sy = Math.min(small.h - 1, Math.floor((y * small.h) / rows));
    for (let x = 0; x < cols; x++) {
      const sx = Math.min(small.w - 1, Math.floor((x * small.w) / cols));
      cells[y * cols + x] = small.data[sy * small.w + sx];
    }
  }
  let sum = 0;
  for (let i = 0; i < cells.length; i++) sum += cells[i];
  const mean = sum / cells.length;
  let key = '';
  for (let i = 0; i < cells.length; i += 4) {
    let nibble = 0;
    for (let b = 0; b < 4; b++) if (cells[i + b] > mean) nibble |= 8 >> b;
    key += nibble.toString(16);
  }
  return key;
}

/** Hamming distance between two dashboard keys (Infinity when either is unset). */
export function keyDistance(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    if (!Number.isFinite(x)) return Infinity;
    let bits = x;
    while (bits) {
      d += bits & 1;
      bits >>= 1;
    }
  }
  return d;
}

/**
 * Measured on the stored dashboard photos (576 bits): the same cluster re-shot
 * from another angle sits 98–130 bits away, two different layouts 187+. 130 is
 * the line — past it the prior belongs to another dashboard, so it is not used.
 */
export const MAX_KEY_DISTANCE = 130;

/** Is this calibration from the same dashboard as this photo? */
export function sameDashboard(a: string | null | undefined, b: string | null | undefined): boolean {
  return keyDistance(a, b) <= MAX_KEY_DISTANCE;
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

