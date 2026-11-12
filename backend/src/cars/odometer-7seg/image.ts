const jpeg = require('jpeg-js') as {
  decode: (b: Buffer, opts?: unknown) => { width: number; height: number; data: Uint8Array };
};
const png = require('pngjs') as {
  PNG: {
    sync: {
      read: (b: Buffer) => { width: number; height: number; data: Uint8Array };
      write: (p: unknown) => Buffer;
    };
  };
};

/**
 * An 8-bit greyscale image.
 *
 * The whole seven-segment pipeline works on brightness only: the LCD is a small
 * bright patch inside a dark dashboard, and colour adds nothing that helps the
 * digit shapes. Keeping one type also makes the patches comparable as raw bytes.
 */
export interface Gray {
  w: number;
  h: number;
  data: Uint8Array;
}

/** Pixel rectangle, top-left origin. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * JPEG or PNG bytes → greyscale.
 *
 * null means "nothing to read" and is a normal answer, not an error: the upload
 * path also accepts WebP, which this decoder cannot open, and a truncated file
 * from Telegram must never blow up the capture that called us.
 */
export function decodeImage(buf: Buffer): Gray | null {
  if (!buf || buf.length < 32) return null;
  try {
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (isPng) {
      const img = png.PNG.sync.read(buf);
      return toGray(img.width, img.height, img.data);
    }
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
    return toGray(img.width, img.height, img.data);
  } catch {
    return null;
  }
}

function toGray(w: number, h: number, rgba: Uint8Array): Gray {
  const data = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return { w, h, data };
}

export function clampBox(b: Box, w: number, h: number): Box {
  const x = Math.max(0, Math.min(w - 1, Math.round(b.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(b.y)));
  const width = Math.max(1, Math.min(w - x, Math.round(b.w)));
  const height = Math.max(1, Math.min(h - y, Math.round(b.h)));
  return { x, y, w: width, h: height };
}

export function expandBox(b: Box, ratio: number, w: number, h: number): Box {
  const dx = b.w * ratio;
  const dy = b.h * ratio;
  return clampBox({ x: b.x - dx, y: b.y - dy, w: b.w + 2 * dx, h: b.h + 2 * dy }, w, h);
}

export function crop(g: Gray, b: Box): Gray {
  const box = clampBox(b, g.w, g.h);
  const data = new Uint8Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) {
    const from = (box.y + y) * g.w + box.x;
    data.set(g.data.subarray(from, from + box.w), y * box.w);
  }
  return { w: box.w, h: box.h, data };
}

/** Box-average downscale — cheap and stable on noisy phone photos. */
export function downscale(g: Gray, maxSide: number): Gray {
  const factor = Math.max(1, Math.ceil(Math.max(g.w, g.h) / maxSide));
  if (factor === 1) return g;
  const w = Math.max(1, Math.floor(g.w / factor));
  const h = Math.max(1, Math.floor(g.h / factor));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        const sy = y * factor + dy;
        if (sy >= g.h) break;
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          if (sx >= g.w) break;
          sum += g.data[sy * g.w + sx];
          n++;
        }
      }
      data[y * w + x] = n ? Math.round(sum / n) : 0;
    }
  }
  return { w, h, data };
}

/** Bilinear resize — used to normalise digit glyphs to a fixed patch size. */
export function resizeBox(g: Gray, tw: number, th: number): Gray {
  const w = Math.max(1, Math.round(tw));
  const h = Math.max(1, Math.round(th));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = h === 1 ? 0 : (y * (g.h - 1)) / (h - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(g.h - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = w === 1 ? 0 : (x * (g.w - 1)) / (w - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(g.w - 1, x0 + 1);
      const fx = sx - x0;
      const top = g.data[y0 * g.w + x0] * (1 - fx) + g.data[y0 * g.w + x1] * fx;
      const bottom = g.data[y1 * g.w + x0] * (1 - fx) + g.data[y1 * g.w + x1] * fx;
      data[y * w + x] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return { w, h, data };
}

/** Otsu — the split between "ink" and "background" for one region. */
export function otsu(g: Gray): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < g.data.length; i++) hist[g.data[i]]++;
  const total = g.data.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let sumBack = 0;
  let wBack = 0;
  let best = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wBack += hist[t];
    if (!wBack) continue;
    const wFore = total - wBack;
    if (wFore <= 0) break;
    sumBack += t * hist[t];
    const meanBack = sumBack / wBack;
    const meanFore = (sumAll - sumBack) / wFore;
    const between = wBack * wFore * (meanBack - meanFore) * (meanBack - meanFore);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

export function meanBrightness(g: Gray): number {
  let sum = 0;
  for (let i = 0; i < g.data.length; i++) sum += g.data[i];
  return g.data.length ? sum / g.data.length : 0;
}

/**
 * Contrast-stretch a patch to 0..255 so a dull, unlit LCD and a blown-out
 * backlit one produce comparable templates.
 */
export function stretch(data: Uint8Array): Uint8Array {
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range < 12) return new Uint8Array(data.length).fill(128);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.round(((data[i] - min) * 255) / range);
  return out;
}

/** Greyscale → PNG base64 (no data: prefix). The labelling UI shows these. */
export function encodeGrayPng(g: Gray, scale = 1): string {
  const src = scale === 1 ? g : resizeBox(g, g.w * scale, g.h * scale);
  const rgba = Buffer.alloc(src.w * src.h * 4);
  for (let i = 0, j = 0; i < src.data.length; i++, j += 4) {
    const v = src.data[i];
    rgba[j] = v;
    rgba[j + 1] = v;
    rgba[j + 2] = v;
    rgba[j + 3] = 255;
  }
  const buf = png.PNG.sync.write({ width: src.w, height: src.h, data: rgba });
  return buf.toString('base64');
}
