/* Phase 0–4 in-process audit — runs inside a backend container against its DB.
 * Read-only: touches nothing. Exit 0 = all checks pass. */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const bad = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) bad.push(name);
}

async function main() {
  // ---------- Phase 0: doc housekeeping is git-level; verified separately ----------
  // (the workflows/seed items below double as Phase 0/2 evidence)

  // ---------- Phase 1: PR entity + Account/Asset foundation ----------
  const prDocs = await prisma.requestDocument.count({ where: { docType: 'PURCHASE_REQUEST' } });
  check('P1: PURCHASE_REQUEST documents exist', prDocs > 0, `${prDocs} docs`);
  const prSample = await prisma.purchaseRequest.findFirst({
    include: { items: { take: 2 }, request: { select: { docNumber: true, status: true } } },
  });
  check('P1: PR rows carry items', !!prSample && prSample.items.length > 0,
    prSample ? `${prSample.request.docNumber} (${prSample.request.status}), ${prSample.items.length} item(s) sampled` : 'none');

  // ---------- Phase 2: amount-band workflows (design §8) ----------
  const bands = await prisma.approvalWorkflow.findMany({
    where: { module: 'PURCHASE_REQUEST', active: true },
    orderBy: { minAmount: 'asc' },
  });
  check('P2: 4 amount-band workflows for PURCHASE_REQUEST', bands.length >= 4, bands.length + ' bands');
  // §8 seed semantics: the bands jointly cover every amount (null lower bound
  // + null upper bound); null-amount PRs fall back to GENERIC_REQUEST by design
  // (workflow-amount-routing.test.ts 'no default → GENERIC fallback' branch).
  const coversAll = bands.some((b) => b.minAmount === null) && bands.some((b) => b.maxAmount === null);
  check('P2: bands jointly cover all amounts (null lower + null upper bound exist)', coversAll);
  console.log('   bands: ' + bands.map((b) => `[${b.minAmount ?? 'null'}–${b.maxAmount ?? 'null'}] ${b.name.slice(17, 40)}`).join(' | '));

  // ---------- Phase 3: PO + GRN ----------
  const poCount = await prisma.purchaseOrder.count();
  check('P3: PurchaseOrder rows exist', poCount > 0, poCount + ' POs');
  const grnCount = await prisma.goodsReceipt.count();
  check('P3: GoodsReceipt rows exist', grnCount > 0, grnCount + ' GRNs');
  const grnPoItem = await prisma.goodsReceiptItem.findFirst({ include: { poItem: true } });
  check('P3: GRN lines reference PO items', !!grnPoItem, grnPoItem ? `ordered ${grnPoItem.poItem.quantity} vs accepted ${grnPoItem.acceptedQty}` : 'none');

  // ---------- Phase 3b: procurement master data ----------
  const [acctCats, assetCats, accounts, locations] = await Promise.all([
    prisma.accountCategory.count(), prisma.assetCategory.count(), prisma.account.count(), prisma.location.count(),
  ]);
  check('P3b: account categories seeded', acctCats >= 5, acctCats + ' categories');
  check('P3b: asset categories seeded', assetCats >= 8, assetCats + ' categories');
  check('P3b: chart of accounts seeded', accounts >= 13, accounts + ' accounts');
  check('P3b: location seeded', locations >= 1, locations + ' locations');

  // ---------- Phase 4: invoices + match ----------
  const invCount = await prisma.invoice.count();
  check('P4: invoices exist', invCount > 0, invCount + ' invoices');
  const posted = await prisma.invoice.findFirst({
    where: { status: 'POSTED' },
    include: { items: true, purchaseOrder: true },
  });
  check('P4: an invoice reached POSTED (full lifecycle)', !!posted, posted ? posted.invoiceNumber : 'none');
  if (posted) {
    check('P4: POSTED invoice has matchStatus', !!posted.matchStatus, 'match=' + posted.matchStatus);
    check('P4: POSTED invoice links a PO', !!posted.purchaseOrderId);
  }
  const statuses = await prisma.invoice.groupBy({ by: ['status'], _count: true });
  console.log('   invoice statuses: ' + statuses.map((s) => `${s.status}=${s._count}`).join(', '));

  console.log(bad.length === 0 ? '\nALL PHASE CHECKS PASSED' : `\nFAILED: ${bad.join(', ')}`);
  await prisma.$disconnect();
  process.exit(bad.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('AUDIT_ERROR:', e.message); process.exit(2); });
