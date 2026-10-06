/** Inventory module functional e2e on the TESTING stack.
 *  Path A: create item (+opening ledger) → RBAC 403 → issue request → approve →
 *          AUTO-fulfill on FINAL_APPROVE → stock deduction + ISSUE ledger + requester notif.
 *  Path B: oversized issue → approve → OUT_OF_STOCK line, stock untouched, supply PENDING
 *          (Administration queue) → restock → manual fulfill → FULFILLED.
 *  Then: restock with price → spending report → reorder guards → delete guard. */
const BASE = 'http://127.0.0.1:3000/api';
(async () => {
  const login = async (u) => (await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'ChangeMe#2026' }) })).json());
  const adm = await login('sysadmin');
  const emp = await login('employee1');
  if (!adm.accessToken || !emp.accessToken) throw new Error('login failed');
  const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
  const j = async (r) => { const b = await r.text(); try { return JSON.parse(b); } catch { return b; } };
  const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };
  const balance = async (itemId) => (await j(await fetch(BASE + '/inventory/items', { headers: H(adm.accessToken) }))).find((i) => i.id === itemId).balance;
  const approve = async (id) => j(await fetch(BASE + `/requests/${id}/approve`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'e2e' }) }));
  const issue = async (itemId, qty) => j(await fetch(BASE + '/inventory/requests', { method: 'POST', headers: H(emp.accessToken), body: JSON.stringify({ items: [{ itemId, quantity: qty }] }) }));

  // 1) RBAC: employee must NOT create items
  const forbid = await fetch(BASE + '/inventory/items', { method: 'POST', headers: H(emp.accessToken), body: JSON.stringify({ name: 'X hack' }) });
  assert(forbid.status === 403, `employee item-create should be 403, got ${forbid.status}`);

  // 2) create item with opening stock 50 (ledger row expected)
  const item = await j(await fetch(BASE + '/inventory/items', { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ name: 'E2E Audit Item', category: 'STATIONERY', unit: 'pcs', balance: 50, minStock: 5, reorderLevel: 20 }) }));
  assert(item.id && item.code, 'item created with code: ' + JSON.stringify(item).slice(0, 120));
  let hist = await j(await fetch(BASE + `/inventory/items/${item.id}/history`, { headers: H(adm.accessToken) }));
  assert(hist.some((t) => t.type === 'PURCHASE' && t.quantity === 50 && t.balanceAfter === 50), 'opening stock recorded as PURCHASE ledger row');

  // ---- Path A: normal issue → auto-fulfill on approval
  const docA = await issue(item.id, 3);
  assert(docA.id && docA.docNumber, 'issue request created: ' + JSON.stringify(docA).slice(0, 120));
  await approve(docA.id);
  assert((await balance(item.id)) === 47, `auto-fulfill deducted 3 → balance 47, got ${await balance(item.id)}`);
  hist = await j(await fetch(BASE + `/inventory/items/${item.id}/history`, { headers: H(adm.accessToken) }));
  const issueRow = hist.find((t) => t.type === 'ISSUE' && t.quantity === -3);
  assert(issueRow && issueRow.balanceAfter === 47, 'ISSUE ledger row with correct balanceAfter');
  assert(issueRow.issuedTo && issueRow.issuedTo.length > 0, 'ISSUE row records who received: ' + JSON.stringify(issueRow));

  // ---- Path B: oversized issue → OUT_OF_STOCK, queued for Administration
  const docB = await issue(item.id, 999);
  assert(docB.id, 'oversized issue request created');
  await approve(docB.id);
  assert((await balance(item.id)) === 47, 'stock untouched when short (still 47)');
  const q = await j(await fetch(BASE + '/inventory/requests/pending', { headers: H(adm.accessToken) }));
  assert(q.some((d) => d.id === docB.id), `short doc in pending fulfillment queue (got ${q.length} rows)`);
  // employee got the out-of-stock notice
  const mine = await j(await fetch(BASE + '/inventory/requests/mine', { headers: H(emp.accessToken) }));
  const mineB = mine.find((d) => d.id === docB.id);
  assert(mineB, 'short request visible in requester history');

  // restock exactly enough → manual fulfill completes it
  const rs = await j(await fetch(BASE + '/inventory/restock', { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ itemId: item.id, quantity: 999, unitPrice: 500, supplier: 'E2E Supplier', reference: 'e2e restock' }) }));
  assert(rs.transaction?.balanceAfter === 1046, `restock applied: ${JSON.stringify(rs).slice(0, 120)}`);
  const fu = await j(await fetch(BASE + `/inventory/requests/${docB.id}/fulfill`, { method: 'POST', headers: H(adm.accessToken) }));
  assert(!fu.error && fu.newStatus === 'FULFILLED', 'manual fulfill after restock: ' + JSON.stringify(fu).slice(0, 150));
  assert((await balance(item.id)) === 47, '999 issued → balance back to 47');

  // ---- reports & guards
  const sp = await j(await fetch(BASE + '/inventory/spending', { headers: H(adm.accessToken) }));
  const row = sp.items.find((i) => i.itemId === item.id);
  // 999 restocked @500 + 50 opening stock valued at the fallback price → 1049 × 500
  assert(row && row.qty === 1049 && row.cost === 524500 && row.estimated === true, `spending row qty=1049 cost=524500 estimated, got ${JSON.stringify(row)}`);
  assert(sp.suppliers.some((s) => s.supplier === 'E2E Supplier'), 'supplier summary row present');
  const bad = await fetch(BASE + '/inventory/restock', { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ itemId: item.id, quantity: 0 }) });
  assert(bad.status === 400, `restock qty=0 should be 400, got ${bad.status}`);
  const over = await issue(item.id, 1); // fine; but a second line dedupe? just cleanup below
  const del = await fetch(BASE + `/inventory/items/${item.id}`, { method: 'DELETE', headers: H(adm.accessToken) });
  assert(del.status === 409, `delete-with-history should be 409, got ${del.status}`);
  const rec = await j(await fetch(BASE + '/inventory/reorder-suggestions', { headers: H(adm.accessToken) }));
  assert(!rec.some((r) => r.itemId === item.id), 'balance 47 > reorder level 20 → no suggestion');

  // ---- Path C: multi-line PARTIAL — one line issuable, one short → PARTIAL,
  // still in queue, fulfill-after-restock completes the rest
  const item2 = await j(await fetch(BASE + '/inventory/items', { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ name: 'E2E Partial Item', category: 'PAPER', unit: 'ream', balance: 5, minStock: 1, reorderLevel: 2 }) }));
  assert(item2.id, 'second item created');
  const docC = await j(await fetch(BASE + '/inventory/requests', { method: 'POST', headers: H(emp.accessToken), body: JSON.stringify({ items: [{ itemId: item.id, quantity: 1 }, { itemId: item2.id, quantity: 50 }] }) }));
  assert(docC.id, 'multi-line request created');
  await approve(docC.id);
  assert((await balance(item.id)) === 46, 'first line auto-issued (47→46)');
  assert((await balance(item2.id)) === 5, 'short second line untouched (5)');
  let q2 = await j(await fetch(BASE + '/inventory/requests/pending', { headers: H(adm.accessToken) }));
  assert(q2.some((d) => d.id === docC.id), 'PARTIAL request still in queue');
  // retry before restocking is idempotent: line re-checked against locked balance,
  // still short → shortage reported, request stays PARTIAL and queued (no 4xx)
  const fu2 = await j(await fetch(BASE + `/inventory/requests/${docC.id}/fulfill`, { method: 'POST', headers: H(adm.accessToken) }));
  assert(!fu2.error && fu2.newStatus === 'PARTIAL' && fu2.shortages?.length === 1, 'retry without stock reports shortage and stays PARTIAL: ' + JSON.stringify(fu2).slice(0, 150));
  q2 = await j(await fetch(BASE + '/inventory/requests/pending', { headers: H(adm.accessToken) }));
  assert(q2.some((d) => d.id === docC.id), 'still queued after the no-stock retry');
  await j(await fetch(BASE + '/inventory/restock', { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ itemId: item2.id, quantity: 50 }) }));
  const fu3 = await j(await fetch(BASE + `/inventory/requests/${docC.id}/fulfill`, { method: 'POST', headers: H(adm.accessToken) }));
  assert(!fu3.error && fu3.newStatus === 'FULFILLED', 'fulfill after restock completes PARTIAL: ' + JSON.stringify(fu3).slice(0, 120));
  assert((await balance(item2.id)) === 5, '50 issued from 55 → 5');
  q2 = await j(await fetch(BASE + '/inventory/requests/pending', { headers: H(adm.accessToken) }));
  assert(!q2.some((d) => d.id === docC.id), 'FULFILLED request left the queue');
  await fetch(BASE + `/inventory/items/${item2.id}`, { method: 'PATCH', headers: H(adm.accessToken), body: JSON.stringify({ isActive: false }) });

  // cleanup: deactivate the test item (cannot hard-delete — has ledger rows)
  await fetch(BASE + `/inventory/items/${item.id}`, { method: 'PATCH', headers: H(adm.accessToken), body: JSON.stringify({ isActive: false }) });
  console.log(`PASS — inventory full cycle OK (${item.code}: 50 → issue 3 auto-fulfilled → 47; short 999 → OUT_OF_STOCK queue → manual fulfill; spending 499,500)`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
