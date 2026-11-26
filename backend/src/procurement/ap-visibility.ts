import type { Request } from 'express';
import { grantedPermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';

/**
 * GLG rule: FINANCE must not learn which supplier a purchase or a bill belongs
 * to. Enforcement therefore lives in the API projection of every AP surface —
 * the invoice register (invoices.read) and the payment register / payables
 * (payments.read) — so the masked values are what leaves the server; the UI is
 * free to render them as they are.
 *
 * A caller holding procurement.read or procurement.manage has the full vendor
 * view. Everyone else (FINANCE, and MANAGEMENT today) gets the placeholder:
 * bill numbers, amounts, statuses and match verdicts stay, the vendor's
 * identity does not.
 */
const FULL_VENDOR_VIEW: string[] = [PERMISSIONS.PROCUREMENT_READ, PERMISSIONS.PROCUREMENT_MANAGE];

export const MASKED_SUPPLIER_NAME = 'Supplier (hidden)';
export const MASKED_BILL_NUMBER = 'Hidden';

/** True when this request must not receive supplier identity. */
export function hidesVendor(req: Request): boolean {
  const granted = grantedPermissions(req);
  return !FULL_VENDOR_VIEW.some((code) => granted.includes(code));
}

/** Swaps a row's supplier name for the placeholder (row keeps the supplier id). */
export function maskSupplierName(row: { supplier: { name: string } }): void {
  row.supplier.name = MASKED_SUPPLIER_NAME;
}

/** Swaps the vendor's own bill number for the placeholder. */
export function maskBillNumber(row: { supplierInvoiceNumber: string }): void {
  row.supplierInvoiceNumber = MASKED_BILL_NUMBER;
}
