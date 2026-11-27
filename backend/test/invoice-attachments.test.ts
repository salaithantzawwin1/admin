/**
 * A vendor bill carries its photo/PDF through the shared attachments module:
 *  - upload with ?invoiceId stores the row on the invoice and audits it;
 *  - a file can have one owner only (request / announcement / invoice);
 *  - attaching needs attachments.use and a real invoice;
 *  - a POSTED invoice's paper is audit evidence: removal is refused;
 *  - a draft invoice's paper can be removed by an attachments.use holder (with audit);
 *  - download needs procurement/invoices read permission.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/invoice-attachments.test.ts
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e: unknown) => {
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    });
}

const UPLOAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ams-invoice-attach-'));
process.env.UPLOAD_PATH = UPLOAD_ROOT;

const { AttachmentsService } = require('../src/attachments/attachments.service');

const USER = 'u-manager';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

function pdfFile(name = 'bill.pdf') {
  return { mimetype: 'application/pdf', size: PDF.length, buffer: PDF, originalname: name };
}

function makeSvc(opts: { invoiceStatus?: string | null; can?: string[]; uploadedById?: string } = {}) {
  const calls: any = { created: null, deleted: null, audits: [] as any[] };
  const allowed = new Set(opts.can ?? ['attachments.use']);
  const invoice = opts.invoiceStatus === null
    ? null
    : { id: 'inv-1', invoiceNumber: 'INV-202611-0016', status: opts.invoiceStatus ?? 'DRAFT' };

  const prisma = {
    invoice: {
      findUnique: async ({ where }: any) => (invoice && where.id === 'inv-1' ? { ...invoice } : null),
    },
    attachment: {
      create: async ({ data }: any) => {
        calls.created = data;
        return { id: 'att-1', ...data };
      },
      findUnique: async ({ where }: any) =>
        where.id === 'att-1'
          ? {
              id: 'att-1', invoiceId: 'inv-1', requestId: null, announcementId: null,
              filename: 'bill.pdf', storedName: 'missing-on-disk.pdf',
              uploadedById: opts.uploadedById ?? 'u-someone-else', vehicleDocuments: [],
            }
          : null,
      delete: async ({ where }: any) => { calls.deleted = where.id; return {}; },
      findMany: async () => [],
      count: async () => 0,
    },
    requestDocument: { findUnique: async () => ({ id: 'req-1', requesterId: USER }) },
    announcement: { findUnique: async () => null },
  };
  const audit = { log: async (row: any) => { calls.audits.push(row); } };
  const permissions = { userHas: async (_userId: string, code: string) => allowed.has(code) };
  const svc = new AttachmentsService(prisma as any, audit as any, permissions as any);
  return { svc, calls };
}

(async () => {
  await test('upload a bill PDF stores it on the invoice and audits the link', async () => {
    const { svc, calls } = makeSvc();
    const att: any = await svc.upload(pdfFile('vendor-bill.pdf') as any, undefined, USER, 'admin1', undefined, 'inv-1');
    assert.strictEqual(att.invoiceId, 'inv-1');
    assert.strictEqual(att.requestId, undefined);
    assert.strictEqual(calls.created.invoiceId, 'inv-1');
    assert.strictEqual(calls.created.mimeType, 'application/pdf');
    assert.ok(fs.existsSync(path.join(UPLOAD_ROOT, calls.created.storedName)), 'stored under UPLOAD_PATH');
    const a = calls.audits.find((x: any) => x.action === 'ATTACHMENT_UPLOADED');
    assert.ok(a, 'ATTACHMENT_UPLOADED audited');
    assert.strictEqual(a.newValue.invoiceId, 'inv-1');
    fs.unlinkSync(path.join(UPLOAD_ROOT, calls.created.storedName));
  });

  await test('one owner only — invoice + request is refused', async () => {
    const { svc, calls } = makeSvc();
    await assert.rejects(
      () => svc.upload(pdfFile() as any, 'req-1', USER, 'admin1', undefined, 'inv-1'),
      /one owner only/,
    );
    assert.strictEqual(calls.created, null);
  });

  await test('an unknown invoice is not found', async () => {
    const { svc } = makeSvc({ invoiceStatus: null });
    await assert.rejects(
      () => svc.upload(pdfFile() as any, undefined, USER, 'admin1', undefined, 'inv-1'),
      /Invoice not found/,
    );
  });

  await test('a caller without attachments.use cannot attach to an invoice', async () => {
    const { svc } = makeSvc({ can: ['procurement.manage'] });
    await assert.rejects(
      () => svc.upload(pdfFile() as any, undefined, USER, 'cy1', undefined, 'inv-1'),
      /Not allowed to attach/,
    );
  });

  await test('a POSTED invoice refuses removal (audit evidence)', async () => {
    const { svc, calls } = makeSvc({ invoiceStatus: 'POSTED' });
    await assert.rejects(() => svc.remove('att-1', USER, 'admin1'), /POSTED.*cannot be removed/);
    assert.strictEqual(calls.deleted, null);
  });

  await test('a draft invoice lets an attachments.use holder remove another user\'s file, audited', async () => {
    const { svc, calls } = makeSvc({ invoiceStatus: 'DRAFT', uploadedById: 'u-colleague' });
    const res: any = await svc.remove('att-1', USER, 'admin1');
    assert.strictEqual(res.success, true);
    assert.strictEqual(calls.deleted, 'att-1');
    const a = calls.audits.find((x: any) => x.action === 'ATTACHMENT_DELETED');
    assert.ok(a, 'ATTACHMENT_DELETED audited');
    assert.strictEqual(a.oldValue.invoiceId, 'inv-1');
    assert.strictEqual(a.severity, 'WARNING');
  });

  await test('removal without attachments.use is forbidden', async () => {
    const { svc, calls } = makeSvc({ invoiceStatus: 'DRAFT', can: ['procurement.manage'] });
    await assert.rejects(() => svc.remove('att-1', USER, 'admin1'), /Not allowed to remove this invoice attachment/);
    assert.strictEqual(calls.deleted, null);
  });

  await test('download without procurement/invoices read is forbidden', async () => {
    const { svc } = makeSvc({ can: ['attachments.use'] });
    await assert.rejects(() => svc.download('att-1', USER), /No access to this attachment/);
  });

  await test('download with invoices.read passes the guard', async () => {
    const { svc } = makeSvc({ can: ['invoices.read'] });
    // the stored file is intentionally absent — the guard is what is under test
    await assert.rejects(() => svc.download('att-1', USER), /File missing on disk/);
  });

  fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
})();
