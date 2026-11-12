import { Box, Gray, crop, otsu, resizeBox, stretch } from './image';

/**
 * Seven-segment digits → one normalised patch each.
 *
 * A 7-seg LCD is not printed text: there are no anti-aliased glyph outlines to
 * recognise, only bars of light. That is why this stage does its own work instead
 * of leaning on an OCR engine (benchmarked in docs/ODOMETER_OCR_PLAN.md: PP-OCR
 * read confident nonsense on exactly these photos).
 *
 * The split is polarisation-agnostic: an unlit LCD is dark digits on a pale
 * green panel, a backlit one is bright digits on a dark panel, and the same photo
 * set contains both. We try both and keep whichever segments into a sane number
 * of glyph-like blobs.
 */

export const PATCH_W = 16;
export const PATCH_H = 24;
export const PATCH_BYTES = PATCH_W * PATCH_H;

export interface DigitGlyph {
  box: Box;
  /** 16×24, contrast-stretched — directly comparable with stored templates */
  patch: Uint8Array;
}

export interface Segmented {
  polarity: 'light' | 'dark';
  digits: DigitGlyph[];
  /** the row the digits were found in, in roi coordinates */
  rowBox: Box;
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

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Morphological close (square, radius d).
 *
 * On a phone photo the bars of one digit often do not touch: blur and low
 * contrast break the corner joins, so a "3" arrives as five separate blobs and a
 * naive labelling counts five digits instead of one. Closing bridges those
 * intra-digit gaps while the wider gap between two digits survives.
 */
function close(mask: Uint8Array, w: number, h: number, d: number): Uint8Array {
  if (d <= 0) return mask;
  const wide = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const from = Math.max(0, x - d);
      const to = Math.min(w - 1, x + d);
      for (let k = from; k <= to; k++) wide[y * w + k] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!wide[y * w + x]) continue;
      const from = Math.max(0, y - d);
      const to = Math.min(h - 1, y + d);
      for (let k = from; k <= to; k++) out[k * w + x] = 1;
    }
  }
  return out;
}

/**
 * Merge the closest neighbours until the row has the digit count we expect — but
 * only across gaps that are clearly INSIDE a digit. Two real digits sit ~0.25–0.4
 * glyph-heights apart; fusing them would turn one reading into another, so an
 * uncrossable gap means we hand back more blobs than expected and the caller
 * refuses the photo.
 */
function mergeTo(comps: Comp[], expect: number): Comp[] {
  const list = [...comps].sort((a, b) => a.x0 - b.x0);
  const heights = list.map((c) => c.y1 - c.y0 + 1).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 1;
  const maxGap = Math.max(1, medianHeight * 0.22);
  while (list.length > expect && list.length > 1) {
    let at = 0;
    let gap = Infinity;
    for (let i = 0; i < list.length - 1; i++) {
      const g = list[i + 1].x0 - list[i].x1;
      if (g < gap) {
        gap = g;
        at = i;
      }
    }
    if (gap > maxGap) break;
    const a = list[at];
    const b = list[at + 1];
    list.splice(at, 2, {
      x0: Math.min(a.x0, b.x0),
      y0: Math.min(a.y0, b.y0),
      x1: Math.max(a.x1, b.x1),
      y1: Math.max(a.y1, b.y1),
      area: a.area + b.area,
    });
  }
  return list;
}

/** Keep only glyph-sized blobs and split any that two digits share. */
function glyphsOf(roi: Gray, expect: number): { comps: Comp[]; polarity: 'light' | 'dark' } {
  const threshold = otsu(roi);
  const minArea = Math.max(6, Math.round(roi.w * roi.h * 0.0004));
  const passes: Array<{ comps: Comp[]; polarity: 'light' | 'dark' }> = [];

  for (const polarity of ['light', 'dark'] as const) {
    const mask = new Uint8Array(roi.data.length);
    for (let i = 0; i < mask.length; i++) {
      const v = roi.data[i];
      mask[i] = (polarity === 'light' ? v > threshold : v <= threshold) ? 1 : 0;
    }
    // bridge the gaps between the bars of one digit (see close())
    const all = components(close(mask, roi.w, roi.h, Math.max(1, Math.round(roi.h * 0.03))), roi.w, roi.h, minArea);
    // glyph-shaped: not a single pixel, not the cluster hood behind the panel
    const candidates = all.filter((c) => {
      const h = c.y1 - c.y0 + 1;
      const w = c.x1 - c.x0 + 1;
      // a digit filling the whole row is normal when the ROI was calibrated tight
      // the full-width blob behind the panel fails the width test on its own
      return w >= 2 && h >= 5 && h <= roi.h && w <= Math.max(roi.w * 0.5, h * 1.1);
    });
    if (!candidates.length) {
      passes.push({ comps: [], polarity });
      continue;
    }
    // Digits of one row share a height; the hood, the fuel bars and the clock do
    // not. The most popular height wins, so six digits beat one stray blob.
    const heights = candidates.map((c) => c.y1 - c.y0 + 1);
    let bestHeight = heights[0];
    let bestCount = 0;
    for (const h of heights) {
      const count = heights.filter((x) => Math.abs(x - h) <= Math.max(2, h * 0.25)).length;
      if (count > bestCount) {
        bestCount = count;
        bestHeight = h;
      }
    }
    const tall = candidates.filter((c) => {
      const h = c.y1 - c.y0 + 1;
      return Math.abs(h - bestHeight) <= Math.max(2, bestHeight * 0.25);
    });
    passes.push({ comps: tall, polarity });
  }

  // which polarity produced the more digit-like structure? (ties → the first pass)
  const score = (list: Comp[]) => {
    if (!list.length) return -Infinity;
    const heights = list.map((c) => c.y1 - c.y0 + 1);
    const spread = Math.max(...heights) - Math.min(...heights);
    return list.length - spread / Math.max(1, median(heights));
  };
  const chosenPass = score(passes[1]?.comps ?? []) > score(passes[0]?.comps ?? []) ? passes[1] : passes[0];
  const chosen = chosenPass?.comps ?? [];
  const polarity = chosenPass?.polarity ?? 'light';

  const sorted = [...chosen].sort((a, b) => a.x0 - b.x0);
  const mid = median(sorted.map((c) => c.x1 - c.x0 + 1));
  if (!mid) return { comps: sorted, polarity };

  // one blob per digit: split a blob two digits share, merge blobs one digit broke into
  const split: Comp[] = [];
  for (const c of sorted) {
    const w = c.x1 - c.x0 + 1;
    const parts = Math.max(1, Math.min(3, Math.round(w / mid)));
    if (parts === 1) {
      split.push(c);
      continue;
    }
    const step = w / parts;
    for (let i = 0; i < parts; i++) {
      const x0 = Math.round(c.x0 + i * step);
      const x1 = Math.round(c.x0 + (i + 1) * step) - 1;
      split.push({ x0, x1, y0: c.y0, y1: c.y1, area: Math.round(c.area / parts) });
    }
  }
  // expect <= 0 means "do not force a count": labelling must see what the photo
  // really has, otherwise a wrong number could be made to fit
  if (expect <= 0) return { comps: split, polarity };
  return { comps: mergeTo(split, expect), polarity };
}

/** One glyph box → the comparable 16×24 patch. */
export function patchOf(g: Gray, box: Box): Uint8Array {
  const pad = 1;
  const padded = crop(g, { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad });
  return stretch(resizeBox(padded, PATCH_W, PATCH_H).data);
}

function zoomed(b: Box, zoom: number): Box {
  if (zoom === 1) return b;
  return { x: b.x / zoom, y: b.y / zoom, w: b.w / zoom, h: b.h / zoom };
}

/** Find the digit row in a region and cut it into glyphs. */
export function segmentDigits(rawRoi: Gray, expect = 6): Segmented {
  const empty: Segmented = { polarity: 'light', digits: [], rowBox: { x: 0, y: 0, w: rawRoi.w, h: rawRoi.h } };
  if (rawRoi.w < 8 || rawRoi.h < 8) return empty;

  // These dashboards put the ODO row ~12 px tall in a 1280×720 phone photo: the
  // bars are barely two pixels thick and a one-pixel blur decides whether two of
  // them touch. Work on an upscaled copy — the geometry (gaps, aspect, joins)
  // only becomes reliable above ~40 px per glyph.
  const zoom = rawRoi.h < 160 ? Math.max(1, Math.min(4, Math.round(200 / rawRoi.h))) : 1;
  const roi = zoom === 1 ? rawRoi : resizeBox(rawRoi, rawRoi.w * zoom, rawRoi.h * zoom);

  const found = glyphsOf(roi, expect);
  const comps = found.comps;
  if (!comps.length) return empty;

  // refine the row band, then ignore blobs that stick out of it (a stalk of the
  // "ODO" label, the fuel gauge needle)
  const y0 = Math.min(...comps.map((c) => c.y0));
  const y1 = Math.max(...comps.map((c) => c.y1));
  const rowH = y1 - y0 + 1;
  const inRow = comps.filter((c) => {
    const cy = (c.y0 + c.y1) / 2;
    return Math.abs(cy - (y0 + rowH / 2)) <= rowH * 0.6;
  });
  const kept = inRow.length >= 4 ? inRow : comps;

  const digits: DigitGlyph[] = kept.map((c) => {
    const box: Box = { x: c.x0, y: c.y0, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1 };
    // the patch is cut from the upscaled copy (more detail), but the box is
    // reported in the caller's coordinates
    return { box: zoomed(box, zoom), patch: patchOf(roi, box) };
  });

  return {
    polarity: found.polarity,
    digits,
    rowBox: zoomed(
      {
        x: Math.min(...kept.map((c) => c.x0)),
        y: y0,
        w: Math.max(...kept.map((c) => c.x1)) - Math.min(...kept.map((c) => c.x0)) + 1,
        h: rowH,
      },
      zoom,
    ),
  };
}

/** Region of the photo the digits came from, in photo coordinates. */
export function digitBoxes(segmented: Segmented, roiX: number, roiY: number): Box[] {
  return segmented.digits.map((d) => ({ x: roiX + d.box.x, y: roiY + d.box.y, w: d.box.w, h: d.box.h }));
}
