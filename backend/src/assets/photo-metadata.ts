/**
 * Strip identifying metadata from an asset photo before it is stored.
 *
 * A phone picture carries EXIF: GPS coordinates, the device serial, the capture
 * time. Keeping that in an internal register leaks where staff and equipment
 * were. The image data is copied byte-for-byte and only the metadata containers
 * are dropped, so no encoder (and no extra dependency) is needed and the file
 * stays in its original format.
 *
 * Only JPEG, PNG and WebP reach this function — the caller has already checked
 * the file signature with `sniffImageType`.
 */

/** Chunks that carry pixels or colour information. Everything else (tEXt,
 *  iTXt, zTXt, eXIf, tIME, …) is metadata and is dropped. */
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'iCCP',
  'bKGD', 'pHYs', 'sBIT', 'hIST', 'cICP', 'mDCv', 'cLLi',
  // animated PNG
  'acTL', 'fcTL', 'fdAT',
]);

/** APP1 holds EXIF and XMP; every other marker is copied unchanged. */
function stripJpeg(buf: Buffer): Buffer {
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  let changed = false;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) return buf; // not at a marker: leave the file untouched
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0xda) { // start of scan — everything after is pixel data
      parts.push(buf.subarray(i));
      return changed ? Buffer.concat(parts) : buf;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // standalone
      parts.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) return buf;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return buf; // truncated header
    if (marker === 0xe1) changed = true;
    else parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return buf; // no scan found — not a usable JPEG, keep it as uploaded
}

function stripPng(buf: Buffer): Buffer {
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  let changed = false;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (end > buf.length) return buf; // truncated chunk table
    if (PNG_KEEP.has(type)) parts.push(buf.subarray(i, end));
    else changed = true;
    i = end;
    if (type === 'IEND') break;
  }
  return changed ? Buffer.concat(parts) : buf;
}

function stripWebp(buf: Buffer): Buffer {
  const chunks: { type: string; data: Buffer }[] = [];
  let i = 12;
  let changed = false;
  while (i + 8 <= buf.length) {
    const type = buf.subarray(i, i + 4).toString('latin1');
    const len = buf.readUInt32LE(i + 4);
    const end = i + 8 + len;
    if (end > buf.length) return buf;
    if (type === 'EXIF' || type === 'XMP ') changed = true;
    else chunks.push({ type, data: buf.subarray(i + 8, end) });
    i = end + (len % 2); // RIFF chunks are padded to an even length
  }
  if (!changed) return buf;
  const body: Buffer[] = [];
  for (const c of chunks) {
    let data = c.data;
    // VP8X flags announce the metadata blocks: bit 3 = EXIF, bit 2 = XMP.
    if (c.type === 'VP8X' && data.length >= 1) {
      const copy = Buffer.from(data);
      copy[0] &= ~0x0c;
      data = copy;
    }
    const head = Buffer.alloc(8);
    head.write(c.type, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    body.push(head, data);
    if (data.length % 2) body.push(Buffer.alloc(1));
  }
  const payload = Buffer.concat(body);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + payload.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, payload]);
}

/** Returns the picture with EXIF/XMP (hence GPS) removed; unchanged when the
 *  file has none, and left alone when it cannot be parsed safely. */
export function stripPhotoMetadata(buf: Buffer, mime: string): Buffer {
  try {
    if (mime === 'image/jpeg') return stripJpeg(buf);
    if (mime === 'image/png') return stripPng(buf);
    if (mime === 'image/webp') return stripWebp(buf);
  } catch {
    /* unparseable: store what was signature-checked rather than failing */
  }
  return buf;
}
