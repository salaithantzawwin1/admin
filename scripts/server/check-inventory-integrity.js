/** Inventory integrity audit (read-only): run inside a backend container.
 *  Checks: negative balances, balance != last ledger balanceAfter,
 *  supply requests stuck between workflow and fulfillment, orphan lines. */
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
(async () => {
  const p = new PrismaService();
  const problems = [];

  const items = await p.inventoryItem.findMany({ select: { id: true, code: true, name: true, balance: true, minStock: true, isActive: true } });
  console.log(`items: ${items.length} (active ${items.filter((i) => i.isActive).length})`);

  // 1) negative balances
  for (const i of items.filter((i) => i.balance < 0)) problems.push(`NEGATIVE balance: ${i.code} = ${i.balance}`);

  // 2) balance must equal the newest ledger row's balanceAfter
  for (const i of items) {
    const last = await p.stockTransaction.findFirst({ where: { itemId: i.id }, orderBy: { createdAt: 'desc' }, select: { balanceAfter: true, createdAt: true } });
    if (last && last.balanceAfter !== i.balance) {
      problems.push(`LEDGER MISMATCH: ${i.code} balance=${i.balance} but last ledger balanceAfter=${last.balanceAfter} (${last.createdAt.toISOString()})`);
    }
  }

  // 3) sum of signed transactions must equal balance (full ledger replay)
  for (const i of items) {
    const agg = await p.stockTransaction.aggregate({ where: { itemId: i.id }, _sum: { quantity: true }, _count: { _all: true } });
    const sum = agg._sum.quantity ?? 0;
    if (sum !== i.balance) problems.push(`REPLAY MISMATCH: ${i.code} balance=${i.balance} but sum(transactions)=${sum} (${agg._count._all} rows)`);
  }

  // 4) supply requests: workflow APPROVED but supply still PENDING for > 7 days (stuck fulfillment)
  const stuck = await p.requestDocument.findMany({
    where: { docType: 'OFFICE_SUPPLY_REQUEST', status: 'APPROVED', supplyRequest: { status: 'PENDING' }, submittedAt: { lt: new Date(Date.now() - 7 * 864e5) } },
    select: { docNumber: true, submittedAt: true },
    take: 20,
  });
  for (const d of stuck) problems.push(`STUCK FULFILLMENT: ${d.docNumber} approved ${d.submittedAt.toISOString()} but supply still PENDING`);

  // 5) COMPLETED docs whose supply request never finished (fulfillment skipped)
  const ghost = await p.requestDocument.findMany({
    where: { docType: 'OFFICE_SUPPLY_REQUEST', status: 'COMPLETED', supplyRequest: { status: 'PENDING' } },
    select: { docNumber: true, updatedAt: true },
    take: 20,
  });
  for (const d of ghost) problems.push(`GHOST COMPLETED: ${d.docNumber} doc COMPLETED but supply PENDING (updated ${d.updatedAt.toISOString()})`);

  // 6) supply lines pointing at missing/inactive items
  const orphanLines = await p.supplyRequestLine.count({ where: { item: { isActive: false } } });
  if (orphanLines > 0) problems.push(`INACTIVE-ITEM LINES: ${orphanLines} supply line(s) reference inactive items`);

  // 7) duplicate item codes
  const all = await p.inventoryItem.findMany({ select: { code: true } });
  const seen = new Map();
  for (const i of all) seen.set(i.code, (seen.get(i.code) ?? 0) + 1);
  for (const [code, n] of seen) if (n > 1) problems.push(`DUPLICATE CODE: ${code} x${n}`);

  // 8) low-stock snapshot (informational)
  const low = items.filter((i) => i.isActive && i.balance <= i.minStock);
  console.log(`low-stock items: ${low.length}${low.length ? ' -> ' + low.slice(0, 8).map((i) => `${i.code}(${i.balance}/${i.minStock})`).join(', ') : ''}`);

  await p.$disconnect();
  if (problems.length) {
    console.log(`\nPROBLEMS (${problems.length}):`);
    for (const pr of problems) console.log('  ✗ ' + pr);
    process.exit(2);
  }
  console.log('\nPASS — ledger/balance integrity OK, no stuck or orphaned rows');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
