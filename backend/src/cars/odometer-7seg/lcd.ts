import { Box, Gray, clampBox, downscale, expandBox, meanBrightness, otsu } from './image';

/**
 * Where the ODO digit row sits on a dashboard photo.
 *
 * Two steps, both cheap and both explainable:
 *
 *  1. the instrument cluster — the one big bright blob in the frame (a dashboard
 *     at night/day is dark around it, and every car in the fleet has one),
 *  2. the digit row inside it — anchored on the ODO label position LEARNED FROM
 *     LABELLED PHOTOS. A seven-segment LCD has no printed "ODO" glyph we could
 *     detect with a threshold, so the label is located once by a human (that is
 *     what `POST /cars/odometer/training/label` does) and the usual offset from
 *     the cluster is reused afterwards.
 *
 * With no calibration yet the pipeline falls back to the geometric prior of the
 * fleet's dashboards (row just under the needle hub, centred) — wide enough that
 * the segmenter usually still finds the digits, and the reader refuses to report
 * anything it is not sure about, so a bad guess costs a miss, never a wrong number.
 */

export interface Calibration {
  /** digit-row rectangle, expressed as a fraction of the cluster box */
  rx: number;
  ry: number;
  rw: number;
  rh: number;
}

/** The instrument cluster: largest bright blob, in full-resolution coordinates. */
export function findCluster(g: Gray): Box | null {
  const small = downscale(g, 192);
  const threshold = Math.max(otsu(small), meanBrightness(small) + 8);
  const mask = new Uint8Array(small.w * small.h);
  for (let i = 0; i < mask.length; i++) mask[i] = small.data[i] > threshold ? 1 : 0;

  const minArea = Math.round(small.w * small.h * 0.005);
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  let best: { x0: number; y0: number; x1: number; y1: number; area: number } | null = null;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let x0 = small.w;
    let y0 = small.h;
    let x1 = -1;
    let y1 = -1;
    let area = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % small.w;
      const y = (p - x) / small.w;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) {
        seen[p - 1] = 1;
        stack.push(p - 1);
      }
      if (x < small.w - 1 && mask[p + 1] && !seen[p + 1]) {
        seen[p + 1] = 1;
        stack.push(p + 1);
      }
      if (y > 0 && mask[p - small.w] && !seen[p - small.w]) {
        seen[p - small.w] = 1;
        stack.push(p - small.w);
      }
      if (y < small.h - 1 && mask[p + small.w] && !seen[p + small.w]) {
        seen[p + small.w] = 1;
        stack.push(p + small.w);
      }
    }
    if (area < minArea) continue;
    const width = x1 - x0 + 1;
    const height = y1 - y0 + 1;
    // a bright wall or a window can win on area alone — a cluster is wide and
    // roughly half as tall as it is wide
    const aspect = height / Math.max(1, width);
    if (aspect < 0.12 || aspect > 0.95) continue;
    if (!best || area > best.area) best = { x0, y0, x1, y1, area };
  }
  if (!best) return null;

  const sx = g.w / small.w;
  const sy = g.h / small.h;
  const box: Box = {
    x: best.x0 * sx,
    y: best.y0 * sy,
    w: (best.x1 - best.x0 + 1) * sx,
    h: (best.y1 - best.y0 + 1) * sy,
  };
  // the blob stops at the first dark pixel of the bezel
  return expandBox(clampBox(box, g.w, g.h), 0.05, g.w, g.h);
}

/**
 * The ODO digit row inside the cluster: the learned offset when we have one,
 * the fleet's geometric prior otherwise.
 */
export function anchorRoi(cluster: Box, calibration: Calibration | null): Box {
  const inside = (x: number, y: number, w: number, h: number): Box => {
    const left = Math.max(cluster.x, Math.min(cluster.x + cluster.w - 2, x));
    const top = Math.max(cluster.y, Math.min(cluster.y + cluster.h - 2, y));
    return {
      x: left,
      y: top,
      w: Math.max(2, Math.min(cluster.x + cluster.w - left, w)),
      h: Math.max(2, Math.min(cluster.y + cluster.h - top, h)),
    };
  };
  if (calibration) {
    return inside(
      cluster.x + calibration.rx * cluster.w,
      cluster.y + calibration.ry * cluster.h,
      calibration.rw * cluster.w,
      calibration.rh * cluster.h,
    );
  }
  return inside(cluster.x + cluster.w * 0.22, cluster.y + cluster.h * 0.55, cluster.w * 0.56, cluster.h * 0.27);
}

/** Median of the labelled rows — one odd photo cannot drag the ROI away. */
export function medianCalibration(rows: Calibration[]): Calibration | null {
  if (!rows.length) return null;
  const pick = (key: keyof Calibration) => {
    const values = rows.map((r) => r[key]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!values.length) return 0;
    return values[Math.floor(values.length / 2)];
  };
  return { rx: pick('rx'), ry: pick('ry'), rw: pick('rw'), rh: pick('rh') };
}
