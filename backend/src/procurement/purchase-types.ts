import { BadRequestException } from '@nestjs/common';

/** GLG ERP §W4 (design §36) — purchase classification. */
export const PURCHASE_TYPES = ['NORMAL', 'EMERGENCY', 'DIRECT', 'PETTY_CASH'] as const;
export type PurchaseType = (typeof PURCHASE_TYPES)[number];

/** Types that must carry a written reason — the audited exception path (§36). */
const REASON_REQUIRED: ReadonlySet<string> = new Set(['EMERGENCY', 'DIRECT']);

export const TYPE_LABELS: Record<PurchaseType, string> = {
  NORMAL: 'Normal purchase',
  EMERGENCY: 'Emergency purchase',
  DIRECT: 'Direct purchase',
  PETTY_CASH: 'Petty cash purchase',
};

/**
 * Normalize + validate the incoming (type, reason) pair.
 * EMERGENCY/DIRECT require a non-empty reason; PETTY_CASH/NORMAL never store one.
 */
export function normalizePurchaseType(type?: string | null, reason?: string | null): {
  purchaseType: string;
  purchaseReason: string | undefined;
} {
  // '' must fall back to NORMAL too — ?? does not catch empty strings
  const purchaseType = (type ?? '').trim().toUpperCase() || 'NORMAL';
  if (!PURCHASE_TYPES.includes(purchaseType as never)) {
    throw new BadRequestException(`purchaseType must be one of ${PURCHASE_TYPES.join(' / ')}`);
  }
  const trimmed = reason?.trim() || undefined;
  if (REASON_REQUIRED.has(purchaseType) && !trimmed) {
    throw new BadRequestException(`A reason is required for a ${TYPE_LABELS[purchaseType as PurchaseType]} (design §36)`);
  }
  return { purchaseType, purchaseReason: REASON_REQUIRED.has(purchaseType) ? trimmed : undefined };
}
