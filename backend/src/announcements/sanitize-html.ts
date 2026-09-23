/**
 * Tiny allow-list sanitizer for announcement rich-text content.
 *
 * The compose editor produces a small subset of HTML (Plan §18: bold, italic,
 * underline, strike, headings, lists, font). We store HTML but must never let
 * arbitrary markup reach the browser (XSS) — so everything except the allow-
 * listed tags is stripped, script/style blocks are dropped whole, and every
 * event handler / style attribute is removed.
 *
 * Deliberately dependency-free: the tag set is tiny and stable, and the
 * validator regex approach is auditable at a glance.
 */

const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
  'h2', 'h3', 'br', 'p', 'div', 'span',
  'ul', 'ol', 'li',
  'a',
]);

/** Tags whose entire content is discarded (never render their inner text). */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed']);

/** Attributes we allow on <a> (and nothing else carries attributes). */
const SAFE_HREF = /^https?:\/\//i;

function sanitizeAttributes(tag: string, attrs: string): string {
  if (tag !== 'a') return '';
  const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const url = href?.[2] ?? href?.[3] ?? href?.[4] ?? '';
  if (!url || !SAFE_HREF.test(url.trim())) return '';
  return ` href="${url.trim().replace(/"/g, '&quot;')}"`;
}

/** Strip anything that is not the allow-listed HTML subset (throws nothing). */
export function sanitizeHtml(input: string): string {
  if (!input) return '';
  let out = input;

  // 1) drop script/style/iframe blocks including their content
  for (const tag of DROP_WITH_CONTENT) {
    out = out.replace(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '')
             .replace(new RegExp(`<${tag}[^>]*>`, 'gi'), '');
  }

  // 2) walk remaining tags — keep only allowed ones with sanitized attributes
  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*)?)\s*(\/?)>/g, (match, rawTag: string, attrs: string, selfClose: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (match.startsWith('</')) return `</${tag}>`;
    const attributeHtml = sanitizeAttributes(tag, attrs ?? '');
    return `<${tag}${attributeHtml}${selfClose ? ' /' : ''}>`;
  });

  // 3) neutralise stray HTML entities that could smuggle markup back in
  out = out.replace(/&(?!(amp|lt|gt|quot|#39|nbsp);)/g, '&amp;');
  return out;
}

/** Reduce sanitized HTML to plain text (Telegram mirror / notification body). */
export function htmlToText(input: string): string {
  if (!input) return '';
  let text = sanitizeHtml(input);
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h2|h3|li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text without tags or entities — for comparisons / previews. */
export function htmlToPlain(input: string): string {
  return htmlToText(input);
}
