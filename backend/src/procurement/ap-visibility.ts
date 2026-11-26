import type { Request } from 'express';
import { grantedPermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';

/**
 * GLG rule: FINANCE must not learn which supplier a purchase or a bill belongs
 * to. Masking happens in these API projections — the invoice register
 * (invoices.read), the payment register / payables (payments.read) and an
 * asset's PO provenance + cost ledger (assets.read) — so the real identity
 * never leaves the server.
 *
 * procurement.read | procurement.manage is the full-supplier view; everyone
 * else keeps the amounts, statuses and match verdicts but not the supplier.
 */
const FULL_SUPPLIER_VIEW = [PERMISSIONS.PROCUREMENT_READ, PERMISSIONS.PROCUREMENT_MANAGE];
const MASKED_SUPPLIER = 'Supplier (hidden)';
const MASKED_BILL_NUMBER = 'Hidden';

/** True when this request must not receive supplier identity. */
export function hidesSupplier(req: Request): boolean {
  const granted = grantedPermissions(req);
  return !FULL_SUPPLIER_VIEW.some((code) => granted.includes(code));
}

/** Swaps a row's supplier name for the placeholder (the row keeps the supplier id). */
export function maskSupplierName(row: { supplier: { name: string } }): void {
  row.supplier.name = MASKED_SUPPLIER;
}

/** Both identity fields a bill row carries: supplier name + the vendor's own bill no. */
export function maskSupplierIdentity(row: { supplier: { name: string }; supplierInvoiceNumber: string }): void {
  maskSupplierName(row);
  row.supplierInvoiceNumber = MASKED_BILL_NUMBER;
}
