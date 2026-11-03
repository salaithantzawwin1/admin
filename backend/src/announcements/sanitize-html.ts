/**
 * Allow-list sanitizer for announcement rich-text content.
 *
 * The composer produces a small subset of HTML (bold, italic, underline,
 * strike, headings, lists, links). Announcement content is rendered with
 * `dangerouslySetInnerHTML` in the browser, so every byte that leaves this
 * function must be markup we emitted ourselves — anything else would be stored
 * XSS and could read a signed-in administrator's session token.
 *
 * HOW IT WORKS
 * - dangerous elements are removed with their content first (script/style/
 *   iframe/object/embed), so their text never becomes visible markup;
 * - the remaining string is split at every `<…>` and re-emitted from scratch:
 *   an allow-listed tag becomes a tag we build, anything else is dropped;
 * - all text between tags is HTML-escaped, so a stray `<` can never start a
 *   tag that the browser would parse (this closes the old bypass where
 *   `<img/onerror=alert(1)>` failed the tag regex and was passed through raw);
 * - attributes exist only on <a>, and only http(s) hrefs plus a fixed
 *   rel="noopener noreferrer" survive.
 *
 * Deliberately dependency-free: the tag set is tiny and stable, and the code
 * is auditable at a glance. backend/test/security.test.ts pins the bypasses.
 */

const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
  'h2', 'h3', 'br', 'p', 'div', 'span',
  'ul', 'ol', 'li',
  'a',
]);

/** Tags whose entire content is discarded (never render their inner text). */
const DROP_WITH_CONTENT = ['script', 'style', 'iframe', 'object', 'embed'];

const SAFE_HREF = /^https?:\/\/[^\s"'<>`]+$/i;

const escapeText = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** The single attribute set we are willing to emit: a safe absolute link. */
function safeAnchorAttributes(tag: string): string {
  const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
  const raw = (hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '').trim();
  if (!raw || !SAFE_HREF.test(raw)) return '';
  const href = raw.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return ` href="${href}" rel="noopener noreferrer" target="_blank"`;
}

/** Rebuild one `<…>` run: allow-listed tag or nothing at all. */
function renderTag(tag: string): string {
  const parsed = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
  if (!parsed) return ''; // <!doctype>, <!-- comment -->, <?xml …>, <  >
  const closing = parsed[1] === '/';
  const name = parsed[2].toLowerCase();
  if (!ALLOWED_TAGS.has(name)) return '';
  if (closing) return `</${name}>`;
  const selfClosing = /\/\s*>$/.test(tag);
  return `<${name}${name === 'a' ? safeAnchorAttributes(tag) : ''}${selfClosing ? ' /' : ''}>`;
}

export function sanitizeHtml(input: string): string {
  if (!input) return '';
  let out = input;

  // 1) remove dangerous elements together with their content
  for (const tag of DROP_WITH_CONTENT) {
    out = out.replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${tag}\\s*>`, 'gi'), '');
    // an opening or closing tag with no partner also goes
    out = out.replace(new RegExp(`<\\s*\\/?\\s*${tag}\\b[^>]*>`, 'gi'), '');
  }

  // 2) rebuild the string tag by tag; everything else is escaped text
  let result = '';
  let last = 0;
  for (const match of out.matchAll(/<[^>]*>/g)) {
    const at = match.index ?? 0;
    result += escapeText(out.slice(last, at));
    result += renderTag(match[0]);
    last = at + match[0].length;
  }
  result += escapeText(out.slice(last));

  return result;
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
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text without tags or entities — for comparisons / previews. */
export function htmlToPlain(input: string): string {
  return htmlToText(input);
}
