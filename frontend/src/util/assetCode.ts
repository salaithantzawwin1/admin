/**
 * The Category_Code printed inside an auto asset code (AST-PRI-2611-0003).
 *
 * Mirrors categorySegment() in backend/src/assets/assets.service.ts line for
 * line, so the preview on the Asset Setup page and in the register dialog can
 * never drift from the code the API actually mints. Printer / Copier is a FIXED
 * code (PRI) rather than something derived from the name; anything else uses the
 * first three A-Z/0-9 characters ("IT Equipment" -> ITE).
 */
const FIXED_CATEGORY_CODES: Record<string, string> = {
  printer: 'PRI',
  copier: 'PRI',
  printercopier: 'PRI',
  copierprinter: 'PRI',
};

export function categorySegment(name?: string | null): string {
  const value = name ?? '';
  return (
    FIXED_CATEGORY_CODES[value.toLowerCase().replace(/[^a-z0-9]/g, '')] ??
    value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3)
  );
}
