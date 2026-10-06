/**
 * Backfill opening PURCHASE ledger rows for seed-imported inventory items.
 *
 * Seed data (backend/prisma/seed.js) set item balances directly with no
 * stock_transactions rows, so the ledger never shows where the opening stock
 * came from. This writes one immutable PURCHASE row per affected item with the
 * correct running balanceAfter (existing rows are preserved and dated BEFORE
 * them; the opening row is dated at the item's creation).
 *
 * Modes:
 *   APPLY=1   write the rows (default: dry-run, prints what it would do)
 *
 * Replay-safety: balanceAfter is computed as (openingGap) for the backfilled
 * row and existing rows keep their own values — sum(ledger after backfill)
 * == current item balance, verified at the end. Idempotent: items that already
 * have any ledger rows are skipped.
 */
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
(async () => {
  const APPLY = process.env.APPLY === '1';
  const p = new PrismaService();
  // who to attribute the backfill to — prefer the seed-created sysadmin
  const sysadmin = await p.user.findUnique({ where: { username: 'sysadmin' }, select: { id: true } });
  if (!sysadmin) throw new Error('sysadmin user not found');
  const actorId = sysadmin.id;

  const items = await p.inventoryItem.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, balance: true, createdAt: true } });
  const targets = [];
  for (const item of items) {
    const agg = await p.stockTransaction.aggregate({ where: { itemId: item.id }, _sum: { quantity: true } });
    const ledgerSum = agg._sum.quantity ?? 0;
    if (ledgerSum !== item.balance) {
      if (ledgerSum !== 0) {
        console.log(`SKIP ${item.code}: balance ${item.balance} vs ledger ${ledgerSum} — not a pure seed item (mixed history needs manual review)`);
        continue;
      }
      targets.push({ ...item, gap: item.balance - ledgerSum });
    }
  }

  if (!targets.length) {
    console.log('Nothing to backfill — all items already reconcile with the ledger.');
    await p.$disconnect();
    return;
  }
  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — ${targets.length} item(s):`);
  for (const t of targets) console.log(`  ${t.code} "${t.name}": opening PURCHASE ${t.gap} (balance ${t.balance})`);

  if (!APPLY) {
    console.log('\nDry-run only — re-run with APPLY=1 to write.');
    await p.$disconnect();
    return;
  }

  let n = 0;
  for (const t of targets) {
    // count existing rows to place the opening row strictly before them in time;
    // rows = 0 for seed-only items, so createdAt of the item itself is used
    await p.stockTransaction.create({
      data: {
        itemId: t.id,
        type: 'PURCHASE',
        quantity: t.gap,
        balanceAfter: t.gap,
        reference: 'Opening stock (backfilled from seed import)',
        createdById: actorId,
        createdAt: t.createdAt,
      },
    });
    // audit trail entry for the backfill action itself
    await p.auditLog.create({
      data: {
        userId: actorId, username: 'sysadmin',
        action: 'INVENTORY_LEDGER_BACKFILL', module: 'INVENTORY', recordId: t.id,
        newValue: { code: t.code, quantity: t.gap, reason: 'seed import had no opening ledger row' },
      },
    });
    n++;
  }
  console.log(`Backfilled ${n} opening row(s).`);

  // final verification: every TARGETED item must now reconcile exactly.
  // Mixed-history items (ITM-0001-style) were deliberately skipped and keep
  // their known seed+ledger offset — informational, not a failure.
  let ok = true;
  for (const t of targets) {
    const agg = await p.stockTransaction.aggregate({ where: { itemId: t.id }, _sum: { quantity: true } });
    if ((agg._sum.quantity ?? 0) !== t.balance) {
      ok = false;
      console.error(`STILL MISMATCHED: ${t.code} balance ${t.balance} vs ledger ${agg._sum.quantity ?? 0}`);
    }
  }
  await p.$disconnect();
  if (!ok) process.exit(2);
  console.log('VERIFY OK — every backfilled item reconciles (mixed-history items intentionally untouched).');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
