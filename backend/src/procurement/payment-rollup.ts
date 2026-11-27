/**
 * Invoice payment rollup (v2 BR-1) — the one writer of paidAmount/paymentStatus.
 *
 * Shared by the payments service and the petty-cash ledger so the two write
 * paths cannot disagree: both recompute the invoice from SUM(payments.amount)
 * inside the same transaction that wrote the payment row.
 */

/** Rounding window for balance arithmetic (MMK has no minor unit). */
export const PAYMENT_TOLERANCE = 0.01;

/** Recompute paidAmount + paymentStatus from the payment ledger. */
export async function syncInvoiceRollup(tx: any, invoiceId: string) {
  const agg = await tx.payment.aggregate({ where: { invoiceId }, _sum: { amount: true } });
  const paid = Number(agg._sum.amount ?? 0);
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { total: true } });
  const total = Number(inv.total);
  const paymentStatus = paid <= 0 ? 'UNPAID' : paid >= total - PAYMENT_TOLERANCE ? 'PAID' : 'PARTIALLY_PAID';
  return tx.invoice.update({ where: { id: invoiceId }, data: { paidAmount: paid, paymentStatus } });
}
