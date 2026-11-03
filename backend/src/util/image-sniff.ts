/**
 * File-signature detection.
 *
 * A browser-supplied Content-Type is just a claim: renaming `payload.html` to
 * `photo.png` makes it arrive as `image/png`. Everything the app stores is
 * therefore identified by its first bytes and, where the type matters for how
 * the file is later served, the claim must agree with the bytes.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface SniffedImage {
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  ext: 'jpg' | 'png' | 'webp';
}

/** JPEG / PNG / WebP only — the formats the asset photo pipeline accepts. */
export function sniffImageType(buf: Buffer): SniffedImage | null {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return { mime: 'image/png', ext: 'png' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

/** Any image an attachment may carry (GIF is allowed there, not for photos). */
export function sniffAnyImage(buf: Buffer): string | null {
  const photo = sniffImageType(buf);
  if (photo) return photo.mime;
  if (!buf || buf.length < 12) return null;
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  return null;
}

/**
 * The container types attachments may hold. `application/zip` also stands for
 * the OpenXML documents (.docx / .xlsx are zip archives) — the caller decides
 * whether the declared type is allowed to ride on a zip signature.
 */
export function sniffDocumentType(buf: Buffer): string | null {
  const image = sniffAnyImage(buf);
  if (image) return image;
  if (!buf || buf.length < 5) return null;
  if (buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'application/zip';
  // plain text / CSV: printable characters and no NUL bytes
  const sample = buf.subarray(0, 4096);
  if (!sample.includes(0x00) && !/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(sample.toString('latin1'))) {
    return 'text/plain';
  }
  return null;
}

/**
 * True when the declared MIME type is plausible for the file's bytes.
 * Anything else is refused before it is written to disk.
 */
export function declaredTypeMatchesBytes(declared: string, buf: Buffer): boolean {
  const sniffed = sniffDocumentType(buf);
  if (!sniffed) return false;
  if (sniffed === declared) return true;
  if (sniffed === 'application/zip') {
    return [
      'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ].includes(declared);
  }
  // a spreadsheet/CSV saved as text is still text
  if (sniffed === 'text/plain') return ['text/plain', 'text/csv'].includes(declared);
  return false;
}
