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

/** Keep only glyph-sized blobs and split any that two digits share. */
function glyphsOf(roi: Gray): { comps: Comp[]; polarity: 'light' | 'dark' } {
  const threshold = otsu(roi);
  const minArea = Math.max(6, Math.round(roi.w * roi.h * 0.0004));
  const passes: Array<{ comps: Comp[]; polarity: 'light' | 'dark' }> = [];

  for (const polarity of ['light', 'dark'] as const) {
    const mask = new Uint8Array(roi.data.length);
    for (let i = 0; i < mask.length; i++) {
      const v = roi.data[i];
      mask[i] = (polarity === 'light' ? v > threshold : v <= threshold) ? 1 : 0;
    }
    const all = components(mask, roi.w, roi.h, minArea);
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
  return { comps: split, polarity };
}

/** One glyph box → the comparable 16×24 patch. */
export function patchOf(g: Gray, box: Box): Uint8Array {
  const pad = 1;
  const padded = crop(g, { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad });
  return stretch(resizeBox(padded, PATCH_W, PATCH_H).data);
}

/** Find the digit row in a region and cut it into glyphs. */
export function segmentDigits(roi: Gray, expect = 6): Segmented {
  const empty: Segmented = { polarity: 'light', digits: [], rowBox: { x: 0, y: 0, w: roi.w, h: roi.h } };
  if (roi.w < 8 || roi.h < 8) return empty;

  const found = glyphsOf(roi);
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
    return { box, patch: patchOf(roi, box) };
  });

  return {
    polarity: found.polarity,
    digits,
    rowBox: { x: Math.min(...kept.map((c) => c.x0)), y: y0, w: Math.max(...kept.map((c) => c.x1)) - Math.min(...kept.map((c) => c.x0)) + 1, h: rowH },
  };
}

/** Region of the photo the digits came from, in photo coordinates. */
export function digitBoxes(segmented: Segmented, roiX: number, roiY: number): Box[] {
  return segmented.digits.map((d) => ({ x: roiX + d.box.x, y: roiY + d.box.y, w: d.box.w, h: d.box.h }));
}
