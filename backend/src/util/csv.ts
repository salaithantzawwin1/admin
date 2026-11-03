/**
 * One CSV cell writer for every export (assets, inventory, budgets, petty cash,
 * payments).
 *
 * Quoting alone is not enough: Excel/Sheets evaluate a cell that begins with
 * `=`, `+`, `-`, `@` (or a control character) as a formula, so a supplier name
 * like `=HYPERLINK("http://evil","open")` becomes a live link in the finance
 * team's spreadsheet (CSV injection). Such cells get a leading apostrophe,
 * which spreadsheets treat as "text, do not evaluate".
 */
const RISKY_START = /^[=+\-@\t\r]/;
/** A plain number (including negatives) is not a formula and must stay numeric. */
const NUMERIC_LIKE = /^-?\d+(\.\d+)?$/;

export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (!NUMERIC_LIKE.test(s) && RISKY_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Joins one row, applying the cell rules to every value. */
export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',');
}
