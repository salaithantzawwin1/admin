/** Low-stock + reorder summary (read-only) — powers the Burmese digest for Administration. */
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
(async () => {
  const p = new PrismaService();
  const items = await p.inventoryItem.findMany({
    where: { isActive: true },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true, unit: true, balance: true, minStock: true, reorderLevel: true, lastUnitPrice: true },
  });
  // last 30 days issued qty per item (for burn-rate context)
  const since = new Date(Date.now() - 30 * 864e5);
  const issued = await p.stockTransaction.groupBy({
    by: ['itemId'],
    where: { type: 'ISSUE', quantity: { lt: 0 }, createdAt: { gte: since } },
    _sum: { quantity: true },
  });
  const burnBy = new Map(issued.map((r) => [r.itemId, Math.abs(r._sum.quantity ?? 0)]));

  const low = items.filter((i) => i.balance <= i.minStock);
  const reorder = items
    .map((i) => ({ ...i, target: i.reorderLevel ?? (i.minStock > 0 ? i.minStock * 3 : null) }))
    .filter((i) => i.target !== null && i.balance <= i.target)
    .map((i) => ({
      ...i,
      suggestedQty: Math.max(i.target - i.balance, i.minStock, 1),
      estCost: i.lastUnitPrice !== null ? Math.round(Number(i.lastUnitPrice) * Math.max(i.target - i.balance, i.minStock, 1) * 100) / 100 : null,
      burn30: burnBy.get(i.id) ?? 0,
    }));

  const healthy = items.length - new Set([...low, ...reorder].map((i) => i.id)).size;
  console.log(`items: ${items.length} active | healthy: ${healthy} | low-stock: ${low.length} | reorder queue: ${reorder.length}`);
  if (low.length) {
    console.log('\nLOW STOCK (balance <= threshold):');
    for (const i of low) console.log(`  ${i.code} ${i.name}: ${i.balance}/${i.minStock} ${i.unit}`);
  }
  if (reorder.length) {
    console.log('\nREORDER QUEUE (balance <= reorder level or ≈3× threshold):');
    for (const i of reorder) {
      const cost = i.estCost !== null ? ` ≈ ${i.estCost.toLocaleString()} MMK` : '';
      console.log(`  ${i.code} ${i.name}: at ${i.balance} ${i.unit} (target ${i.target}) → order ${i.suggestedQty} ${i.unit}${cost} | 30d issued ${i.burn30}`);
    }
  }
  if (!low.length && !reorder.length) console.log('\nAll items above their thresholds — nothing to restock.');
  await p.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
