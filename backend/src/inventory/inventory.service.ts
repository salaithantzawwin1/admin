import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ItemCategory, Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.module';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { WorkflowService } from '../workflow/workflow.service';
import { PermissionsService } from '../auth/permissions.service';
import { Actor } from '../org/org.service';

const DOC_PREFIX = 'OSR';

@Injectable()
export class InventoryService {
  constructor(
    private prisma: PrismaService,
    private numbering: NumberingService,
    private notifications: NotificationsService,
    private audit: AuditService,
    private workflow: WorkflowService,
    private permissions: PermissionsService,
  ) {}

  // ---------- items master ----------

  listItems(includeInactive = false) {
    return this.prisma.inventoryItem.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { code: 'asc' },
    });
  }

  /** Items + live low-stock computation for the management view. */
  async itemsWithAlerts() {
    const items = await this.prisma.inventoryItem.findMany({ orderBy: { code: 'asc' } });
    return items.map((i) => ({ ...i, low: i.balance <= i.minStock, out: i.balance <= 0 }));
  }

  private nextItemCode(): Promise<string> {
    // atomic sequence (row-locked upsert) — safe under concurrent creates;
    // seeds itself from the highest existing ITM-#### on first use
    return this.numbering.nextStable('ITM');
  }

  async createItem(data: { name: string; category?: string; unit?: string; balance?: number; minStock?: number; description?: string }, actor: Actor) {
    const item = await this.prisma.inventoryItem.create({
      data: {
        code: await this.nextItemCode(),
        name: data.name.trim(),
        category: (data.category || 'STATIONERY') as ItemCategory,
        unit: data.unit?.trim() || 'pcs',
        // opening balance is recorded as a PURCHASE transaction so the ledger stays complete
        balance: 0,
        minStock: data.minStock ?? 0,
        description: data.description,
      },
    });
    if (data.balance && data.balance > 0) {
      await this.applyTransaction(item.id, 'PURCHASE', data.balance, `Opening stock for ${item.code}`, undefined, actor);
    }
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'INVENTORY_ITEM_CREATED', module: 'INVENTORY', recordId: item.id,
      newValue: { code: item.code, name: item.name, unit: item.unit, openingBalance: data.balance ?? 0 },
    });
    return item;
  }

  async updateItem(id: string, data: { name?: string; category?: string; unit?: string; minStock?: number; description?: string; isActive?: boolean }, actor: Actor) {
    const item = await this.prisma.inventoryItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Item not found');
    // balance is never edited here — only via PURCHASE/ISSUE/RETURN/ADJUSTMENT transactions
    const updated = await this.prisma.inventoryItem.update({
      where: { id },
      data: {
        name: data.name?.trim(),
        category: data.category as ItemCategory | undefined,
        unit: data.unit?.trim(),
        minStock: data.minStock,
        description: data.description,
        isActive: data.isActive,
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'INVENTORY_ITEM_UPDATED', module: 'INVENTORY', recordId: id,
      oldValue: { name: item.name, category: item.category, unit: item.unit, minStock: item.minStock, isActive: item.isActive },
      newValue: data,
    });
    return updated;
  }

  /** Delete only when the item has no transaction history — otherwise deactivate. */
  // ---------- item images ----------

  private uploadRoot = process.env.UPLOAD_PATH || '/app/uploads';
  private static IMAGE_MIME: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  };

  /** Store an uploaded photo for an item (replaces any previous photo). */
  async setImage(id: string, file: Express.Multer.File | undefined, actor: Actor) {
    if (!file || !file.buffer?.length) throw new BadRequestException('No image provided');
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 6) || '.png';
    if (!InventoryService.IMAGE_MIME[ext]) throw new BadRequestException(`Not an image: ${ext}`);
    if (file.size > 5 * 1024 * 1024) throw new BadRequestException('Image too large (max 5 MB)');
    const item = await this.prisma.inventoryItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Item not found');

    if (!fs.existsSync(this.uploadRoot)) fs.mkdirSync(this.uploadRoot, { recursive: true });
    const storedName = `item-${crypto.randomUUID()}${ext}`;
    fs.writeFileSync(path.join(this.uploadRoot, storedName), file.buffer);

    const old = item.imageStoredName;
    const updated = await this.prisma.inventoryItem.update({ where: { id }, data: { imageStoredName: storedName } });
    if (old && old !== storedName) {
      const oldPath = path.join(this.uploadRoot, old);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'INVENTORY_ITEM_IMAGE_SET', module: 'INVENTORY', recordId: id,
      newValue: { code: item.code, name: item.name },
    });
    return updated;
  }

  /** Resolve the on-disk path + mime for an item photo (public — catalog thumbnails). */
  async getImage(id: string) {
    const item = await this.prisma.inventoryItem.findUnique({ where: { id }, select: { imageStoredName: true } });
    const name = item?.imageStoredName;
    if (!name) throw new NotFoundException('No image for this item');
    const filePath = path.join(this.uploadRoot, name);
    if (!fs.existsSync(filePath)) throw new NotFoundException('Image file missing on disk');
    const mime = InventoryService.IMAGE_MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
    return { filePath, mime };
  }

  async removeImage(id: string, actor: Actor) {
    const item = await this.prisma.inventoryItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Item not found');
    if (!item.imageStoredName) throw new NotFoundException('No image to remove');
    const filePath = path.join(this.uploadRoot, item.imageStoredName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await this.prisma.inventoryItem.update({ where: { id }, data: { imageStoredName: null } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'INVENTORY_ITEM_IMAGE_REMOVED', module: 'INVENTORY', recordId: id,
      oldValue: { code: item.code, name: item.name },
    });
    return { success: true };
  }

  async deleteItem(id: string, actor: Actor) {
    const item = await this.prisma.inventoryItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Item not found');
    const txCount = await this.prisma.stockTransaction.count({ where: { itemId: id } });
    const lineCount = await this.prisma.supplyRequestLine.count({ where: { itemId: id } });
    if (txCount > 0 || lineCount > 0) {
      throw new ConflictException(
        `Item ${item.code} has ${Math.max(txCount, lineCount)} transaction/request record(s) — deactivate it instead`,
      );
    }
    await this.prisma.inventoryItem.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'INVENTORY_ITEM_DELETED', module: 'INVENTORY', recordId: id,
      oldValue: { code: item.code, name: item.name },
      severity: 'WARNING',
    });
    return { success: true };
  }

  // ---------- core stock engine (transactional) ----------

  /**
   * Apply a stock movement inside a transaction: locks the item row, applies the
   * delta, prevents negative balance, writes the immutable ledger entry.
   * quantity > 0 = IN (PURCHASE/RETURN), quantity < 0 = OUT (ISSUE).
   */
  private async applyTransaction(
    itemId: string,
    type: 'PURCHASE' | 'ISSUE' | 'RETURN' | 'ADJUSTMENT',
    signedQty: number,
    reference: string | undefined,
    requestId: string | undefined,
    actor: Actor,
    client?: Prisma.TransactionClient,
    unitPrice?: number,
    supplier?: string,
    supplierId?: string,
  ) {
    const run = async (tx: Prisma.TransactionClient) => {
      // row lock so concurrent issues cannot both pass the balance check
      const item = await tx.$queryRaw<{ id: string; balance: number }[]>`
        SELECT id, balance FROM inventory_items WHERE id = ${itemId}::uuid FOR UPDATE`;
      if (!item[0]) throw new NotFoundException('Item not found');
      const newBalance = item[0].balance + signedQty;
      if (newBalance < 0) {
        throw new ConflictException(`Insufficient stock — balance ${item[0].balance}, requested ${Math.abs(signedQty)}`);
      }
      await tx.inventoryItem.update({
        where: { id: itemId },
        data: { balance: newBalance, ...(unitPrice !== undefined ? { lastUnitPrice: unitPrice } : {}) },
      });
      return tx.stockTransaction.create({
        data: {
          itemId, type, quantity: signedQty, balanceAfter: newBalance,
          reference, requestId, createdById: actor.userId,
          ...(unitPrice !== undefined ? { unitPrice } : {}),
          ...(supplier ? { supplier } : {}),
          ...(supplierId ? { supplierId } : {}),
        },
      });
    };
    return client ? run(client) : this.prisma.$transaction(run);
  }

  // ---------- issue requests (Plan §12: via the reusable approval workflow) ----------

  /** Employee submits an issue request (created as DRAFT then submitted to the workflow). */
  async createIssueRequest(
    data: { items: { itemId: string; quantity: number }[]; note?: string },
    actor: Actor,
  ) {
    if (!data.items?.length) throw new BadRequestException('At least one item is required');
    for (const line of data.items) {
      if (!line.itemId) throw new BadRequestException('itemId is required');
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new BadRequestException('Quantity must be a positive whole number');
      }
    }
    // validate items exist & are active
    const items = await this.prisma.inventoryItem.findMany({
      where: { id: { in: data.items.map((i) => i.itemId) }, isActive: true },
    });
    if (items.length !== new Set(data.items.map((i) => i.itemId)).size) {
      throw new BadRequestException('One of the items does not exist or is inactive');
    }

    const doc = await this.workflow.create({ title: 'Office supplies', docType: 'OFFICE_SUPPLY_REQUEST' }, actor);
    const supply = await this.prisma.officeSupplyRequest.create({
      data: { requestId: doc.id, note: data.note },
    });
    await this.prisma.supplyRequestLine.createMany({
      data: data.items.map((i) => ({ supplyRequestId: supply.id, itemId: i.itemId, quantity: i.quantity })),
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLY_REQUEST_CREATED', module: 'INVENTORY', recordId: doc.id,
      newValue: { docNumber: doc.docNumber, lines: data.items },
    });

    // straight into approval — issue requests have no editing phase
    await this.workflow.submit(doc.id, actor);
    return { ...doc, supplyRequestId: supply.id };
  }

  /** Detail for the request page / panels. */
  async findByRequest(requestId: string) {
    return this.prisma.officeSupplyRequest.findUnique({
      where: { requestId },
      include: { lines: { include: { item: { select: { code: true, name: true, unit: true, balance: true } } } } },
    });
  }

  /** My requests history for the employee view. */
  async myRequests(actor: Actor) {
    return this.prisma.requestDocument.findMany({
      where: { requesterId: actor.userId, docType: 'OFFICE_SUPPLY_REQUEST' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        supplyRequest: { include: { lines: { include: { item: { select: { code: true, name: true, unit: true } } } } } },
      },
    });
  }

  /** Administration queue: PENDING requests awaiting fulfillment decision. */
  async pendingRequests() {
    return this.prisma.requestDocument.findMany({
      where: { docType: 'OFFICE_SUPPLY_REQUEST', status: 'APPROVED', supplyRequest: { status: 'PENDING' } },
      orderBy: { submittedAt: 'asc' },
      include: {
        requester: { select: { username: true, fullName: true } },
        department: { select: { name: true } },
        supplyRequest: { include: { lines: { include: { item: { select: { code: true, name: true, unit: true, balance: true } } } } } },
      },
    });
  }

  /**
   * Fulfill an APPROVED supply request: per line, deduct stock inside one
   * transaction and mark the line FULFILLED (or OUT_OF_STOCK when the balance
   * is short). The whole request completes only when every line is fulfilled.
   * Called automatically on workflow FINAL_APPROVE, or manually by Administration.
   */
  async fulfill(requestId: string, actor: Actor) {
    const doc = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      include: { supplyRequest: { include: { lines: { include: { item: true } } } } },
    });
    if (!doc?.supplyRequest) throw new NotFoundException('Supply request not found');
    const supply = doc.supplyRequest;
    if (supply.status !== 'PENDING') throw new ConflictException(`Already ${supply.status}`);
    if (!['APPROVED', 'PENDING_APPROVAL', 'IN_PROGRESS'].includes(doc.status)) {
      throw new BadRequestException(`Workflow status is ${doc.status} — cannot fulfill yet`);
    }
    if (doc.status === 'PENDING_APPROVAL') {
      throw new BadRequestException('Request is still awaiting approval');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const shortages: { code: string; requested: number; available: number }[] = [];
      for (const line of supply.lines) {
        if (line.status !== 'PENDING') continue;
        // fresh, locked read — line.item.balance may be stale (another request
        // could have consumed stock between the load above and this transaction)
        const current = await tx.inventoryItem.findUnique({ where: { id: line.itemId }, select: { code: true, balance: true } });
        if (!current || line.quantity > current.balance) {
          await tx.supplyRequestLine.update({ where: { id: line.id }, data: { status: 'OUT_OF_STOCK' } });
          shortages.push({ code: current?.code ?? line.item.code, requested: line.quantity, available: current?.balance ?? 0 });
          continue;
        }
        // deduct via the ledger (row-locked, negative-proof)
        await this.applyTransaction(line.itemId, 'ISSUE', -line.quantity, doc.docNumber, doc.id, actor, tx);
        await tx.supplyRequestLine.update({
          where: { id: line.id },
          data: { status: 'FULFILLED', fulfilledQty: line.quantity },
        });
      }
      const after = await tx.supplyRequestLine.findMany({ where: { supplyRequestId: supply.id } });
      const allFulfilled = after.every((l) => l.status === 'FULFILLED');
      const anyFulfilled = after.some((l) => l.status === 'FULFILLED');
      const newStatus = allFulfilled ? 'FULFILLED' : anyFulfilled ? 'PARTIAL' : 'PENDING';
      await tx.officeSupplyRequest.update({
        where: { requestId: doc.id },
        data: { status: newStatus, fulfilledAt: allFulfilled ? new Date() : null },
      });
      if (doc.status === 'APPROVED') {
        await tx.requestDocument.update({ where: { id: doc.id }, data: { status: 'COMPLETED' } });
      }
      return { newStatus, shortages };
    });

    // low-stock alerts forAdministration after the deduction
    await this.alertLowStock(actor);
    if (result.shortages.length > 0) {
      await this.notifications.notify({
        userId: doc.requesterId, type: 'RETURNED' as never,
        title: `Request ${doc.docNumber} — some items are out of stock`,
        body: `Short items: ${result.shortages.map((s) => `${s.code} (need ${s.requested}, have ${s.available})`).join(', ')}. Administration will restock and fulfill later.`,
        link: `/requests/${doc.id}`, requestId: doc.id,
      });
    } else {
      await this.notifications.notify({
        userId: doc.requesterId, type: 'TRIP_COMPLETED' as never,
        title: `Supplies issued — ${doc.docNumber}`,
        body: 'Your supply request has been fulfilled. Please collect the items from the store.',
        link: `/requests/${doc.id}`, requestId: doc.id,
      });
    }

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLY_REQUEST_FULFILLED', module: 'INVENTORY', recordId: doc.id,
      newValue: { status: result.newStatus, shortages: result.shortages },
    });
    return result;
  }

  /**
   * Administration cancels an approved supply request — the requester gets a
   * CANCELLED notification (Telegram mirror included). Anything already issued
   * (FULFILLED lines) is left intact; only still-pending lines are closed.
   */
  async adminCancelSupply(requestId: string, reason: string | undefined, actor: Actor) {
    const doc = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      include: { supplyRequest: true },
    });
    if (!doc?.supplyRequest) throw new NotFoundException('Supply request not found');
    // COMPLETED here means "approved, auto-fulfill pending" (e.g. out-of-stock) —
    // still cancellable as long as nothing was actually issued from the store.
    if (!['APPROVED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'COMPLETED'].includes(doc.status)) {
      throw new BadRequestException(`Cannot cancel from status ${doc.status}`);
    }
    if (!['PENDING', 'REJECTED'].includes(doc.supplyRequest.status)) {
      throw new BadRequestException('Items were already issued from the store — this request can no longer be cancelled');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.supplyRequestLine.updateMany({
        where: { supplyRequestId: doc.supplyRequest!.id, status: { in: ['PENDING', 'OUT_OF_STOCK'] } },
        data: { status: 'REJECTED' },
      });
      await tx.officeSupplyRequest.update({
        where: { requestId },
        data: { status: 'REJECTED' },
      });
      await tx.requestDocument.update({ where: { id: requestId }, data: { status: 'CANCELLED' } });
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLY_REQUEST_CANCELLED', module: 'INVENTORY', recordId: requestId,
      newValue: { reason, previousStatus: doc.status },
    });
    await this.notifications.notify({
      userId: doc.requesterId, type: 'CANCELLED',
      title: `Request ${doc.docNumber} cancelled by Administration`,
      body: reason || 'Your supply request was cancelled by the Administration Department.',
      link: `/requests/${requestId}`, requestId,
    });
    return { success: true };
  }

  async rejectFulfillment(requestId: string, reason: string | undefined, actor: Actor) {
    const doc = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      include: { supplyRequest: true },
    });
    if (!doc?.supplyRequest) throw new NotFoundException('Supply request not found');
    if (doc.supplyRequest.status !== 'PENDING') throw new ConflictException(`Already ${doc.supplyRequest.status}`);

    // close everything atomically: pending lines → REJECTED, supply header → REJECTED,
    // and the workflow document itself leaves APPROVED/COMPLETED so it stops showing
    // as collectable in the UI (nothing was issued, so nothing needs rollback)
    await this.prisma.$transaction(async (tx) => {
      await tx.supplyRequestLine.updateMany({
        where: { supplyRequestId: doc.supplyRequest!.id, status: 'PENDING' },
        data: { status: 'REJECTED' },
      });
      await tx.officeSupplyRequest.update({
        where: { requestId },
        data: { status: 'REJECTED' },
      });
      await tx.requestDocument.update({
        where: { id: requestId },
        data: { status: 'CANCELLED' },
      });
    });
    await this.notifications.notify({
      userId: doc.requesterId, type: 'REJECTED',
      title: `Supply request ${doc.docNumber} not fulfilled`,
      body: reason || 'The Administration Department could not fulfill this request.',
      link: `/requests/${doc.id}`, requestId: doc.id,
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLY_REQUEST_REJECTED', module: 'INVENTORY', recordId: doc.id,
      newValue: { reason },
    });
    return { success: true };
  }

  // ---------- restock / purchases ----------

  async restock(data: { itemId: string; quantity: number; reference?: string; unitPrice?: number; supplier?: string; supplierId?: string }, actor: Actor) {
    if (!Number.isInteger(data.quantity) || data.quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive whole number');
    }
    if (data.unitPrice !== undefined && (!Number.isFinite(data.unitPrice) || data.unitPrice < 0)) {
      throw new BadRequestException('Unit price must be zero or a positive number');
    }
    const price = data.unitPrice !== undefined ? Math.round(data.unitPrice * 100) / 100 : undefined;
    // supplier by master id (preferred) or free-text fallback
    let supplierName = data.supplier?.trim() || undefined;
    let supplierId: string | undefined;
    if (data.supplierId) {
      const s = await this.prisma.supplier.findUnique({ where: { id: data.supplierId } });
      if (!s) throw new BadRequestException('Supplier not found');
      supplierId = s.id;
      supplierName = s.name;
    }
    const tx = await this.applyTransaction(data.itemId, 'PURCHASE', data.quantity, data.reference || 'Restock', undefined, actor, undefined, price, supplierName, supplierId);
    const item = await this.prisma.inventoryItem.findUnique({ where: { id: data.itemId } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'INVENTORY_RESTOCK', module: 'INVENTORY', recordId: data.itemId,
      newValue: { quantity: data.quantity, balanceAfter: tx.balanceAfter, reference: data.reference, unitPrice: price, supplier: supplierName },
    });
    return { transaction: tx, item };
  }

  // ---------- suppliers master ----------

  listSuppliers(includeInactive = false) {
    return this.prisma.supplier.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async createSupplier(data: { name: string; phone?: string; address?: string; note?: string }, actor: Actor) {
    const name = data.name.trim();
    if (!name) throw new BadRequestException('Supplier name is required');
    const exists = await this.prisma.supplier.findUnique({ where: { name } });
    if (exists) throw new ConflictException(`Supplier "${name}" already exists`);
    const supplier = await this.prisma.supplier.create({
      data: { name, phone: data.phone, address: data.address, note: data.note },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLIER_CREATED', module: 'INVENTORY', recordId: supplier.id,
      newValue: { name },
    });
    return supplier;
  }

  async updateSupplier(id: string, data: { name?: string; phone?: string; address?: string; note?: string; isActive?: boolean }, actor: Actor) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) throw new BadRequestException('Supplier name is required');
      const dup = await this.prisma.supplier.findFirst({ where: { name, id: { not: id } } });
      if (dup) throw new ConflictException(`Supplier "${name}" already exists`);
    }
    const updated = await this.prisma.supplier.update({ where: { id }, data: { name: data.name?.trim(), phone: data.phone, address: data.address, note: data.note, isActive: data.isActive } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLIER_UPDATED', module: 'INVENTORY', recordId: id,
      oldValue: { name: supplier.name, phone: supplier.phone, isActive: supplier.isActive },
      newValue: data,
    });
    return updated;
  }

  async deleteSupplier(id: string, actor: Actor) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    const txCount = await this.prisma.stockTransaction.count({ where: { supplierId: id } });
    if (txCount > 0) {
      throw new ConflictException(`Supplier has ${txCount} purchase record(s) — deactivate it instead`);
    }
    await this.prisma.supplier.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLIER_DELETED', module: 'INVENTORY', recordId: id,
      oldValue: { name: supplier.name },
      severity: 'WARNING',
    });
    return { success: true };
  }

  // ---------- history & alerts ----------

  itemHistory(itemId: string) {
    return this.prisma.stockTransaction.findMany({
      where: { itemId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { createdBy: { select: { fullName: true } } },
    });
  }

  lowStock() {
    return this.prisma.inventoryItem.findMany({
      where: { isActive: true, ...Prisma.validator<Prisma.InventoryItemWhereInput>()({}) },
    }).then((items) => items.filter((i) => i.balance <= i.minStock));
  }

  /**
   * Spending report — how much was spent per item in a period (Plan §12 purchasing).
   * Uses the unit price recorded on each PURCHASE; falls back to the item's latest
   * known price when an old entry has none.
   */
  async spendingReport(monthStart?: string, monthEnd?: string) {
    const now = new Date();
    const start = monthStart ? new Date(monthStart) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = monthEnd ? new Date(monthEnd) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('Invalid period');
    }

    const purchases = await this.prisma.stockTransaction.findMany({
      where: { type: 'PURCHASE', createdAt: { gte: start, lt: end }, item: { isActive: true } },
      select: { itemId: true, quantity: true, unitPrice: true, reference: true, supplier: true, supplierId: true, createdAt: true, item: { select: { code: true, name: true, unit: true, lastUnitPrice: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const byItem = new Map<string, { itemId: string; code: string; name: string; unit: string; qty: number; cost: number; estimated: boolean; lastUnitPrice: number | null; entries: { quantity: number; unitPrice: number | null; reference: string | null; createdAt: Date }[] }>();
    const bySupplier = new Map<string, { supplier: string; qty: number; cost: number; noPrice: boolean }>();
    for (const p of purchases) {
      const row = byItem.get(p.itemId) ?? {
        itemId: p.itemId, code: p.item.code, name: p.item.name, unit: p.item.unit,
        qty: 0, cost: 0, estimated: false,
        lastUnitPrice: p.item.lastUnitPrice !== null ? Number(p.item.lastUnitPrice) : null,
        entries: [],
      };
      const qty = p.quantity; // PURCHASE entries are positive
      const unit = p.unitPrice !== null ? Number(p.unitPrice) : p.item.lastUnitPrice !== null ? Number(p.item.lastUnitPrice) : null;
      row.qty += qty;
      if (unit !== null) row.cost += qty * unit;
      row.entries.push({ quantity: qty, unitPrice: p.unitPrice !== null ? Number(p.unitPrice) : null, reference: p.reference, createdAt: p.createdAt });
      byItem.set(p.itemId, row);

      // by-supplier summary (same window) — keyed by master id when linked
      const sKey = p.supplierId ?? (p.supplier?.trim() || 'Unspecified');
      const s = bySupplier.get(sKey) ?? { supplier: p.supplier?.trim() || 'Unspecified', qty: 0, cost: 0, noPrice: false };
      s.qty += qty;
      if (unit !== null) s.cost += qty * unit;
      else s.noPrice = true;
      bySupplier.set(sKey, s);
    }

    const items = [...byItem.values()].map((r) => ({
      ...r,
      avgUnitPrice: r.qty > 0 ? Math.round((r.cost / r.qty) * 100) / 100 : null,
      noPrice: r.lastUnitPrice === null && r.entries.every((e) => e.unitPrice === null),
      // some entries had no explicit price and were valued at the item's latest known price
      estimated: r.lastUnitPrice !== null && r.entries.some((e) => e.unitPrice === null),
    }));
    const total = Math.round(items.reduce((s, i) => s + i.cost, 0) * 100) / 100;
    const suppliers = [...bySupplier.values()]
      .map((s) => ({ ...s, cost: Math.round(s.cost * 100) / 100, avgUnitPrice: s.qty > 0 ? Math.round((s.cost / s.qty) * 100) / 100 : null }))
      .sort((a, b) => b.cost - a.cost);
    return { monthStart: start.toISOString(), monthEnd: end.toISOString(), total, suppliers, items: items.sort((a, b) => b.cost - a.cost) };
  }

  /** Lifetime purchased qty + cost per item (all months) — shown in the item ledger. */
  async purchaseTotals() {
    const rows = await this.prisma.stockTransaction.groupBy({
      by: ['itemId'],
      where: { type: 'PURCHASE' },
      _sum: { quantity: true, unitPrice: true },
    });
    // unitPrice is not additive — recompute cost per item from entries
    const items = await this.prisma.inventoryItem.findMany({
      select: { id: true, code: true, name: true, unit: true, lastUnitPrice: true },
    });
    const entries = await this.prisma.stockTransaction.findMany({
      where: { type: 'PURCHASE' },
      select: { itemId: true, quantity: true, unitPrice: true },
    });
    const byItem = new Map<string, { qty: number; cost: number; explicit: number; unpriced: number }>();
    for (const e of entries) {
      const row = byItem.get(e.itemId) ?? { qty: 0, cost: 0, explicit: 0, unpriced: 0 };
      row.qty += e.quantity;
      if (e.unitPrice !== null) {
        row.cost += e.quantity * Number(e.unitPrice);
        row.explicit++;
      } else {
        row.unpriced += e.quantity; // valued later at the item's fallback price, per unit
      }
      byItem.set(e.itemId, row);
    }
    return items
      .filter((i) => byItem.has(i.id))
      .map((i) => {
        const r = byItem.get(i.id)!;
        const fallback = i.lastUnitPrice !== null ? Number(i.lastUnitPrice) : null;
        const cost = Math.round((r.cost + (fallback !== null ? r.unpriced * fallback : 0)) * 100) / 100;
        return {
          itemId: i.id, code: i.code, name: i.name, unit: i.unit,
          qty: r.qty, cost,
          avgUnitPrice: r.qty > 0 ? Math.round((cost / r.qty) * 100) / 100 : null,
          noPrice: r.explicit === 0 && fallback === null,
          estimated: r.unpriced > 0 && fallback !== null,
        };
      })
      .sort((a, b) => b.cost - a.cost);
  }

  /** CSV of the monthly spending report (Excel-friendly BOM + commas). */
  async spendingCsv(monthStart?: string, monthEnd?: string) {
    const report = await this.spendingReport(monthStart, monthEnd);
    const esc = (v: string | number | null) => {
      const s = v === null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines: string[] = [];
    lines.push(['Item code', 'Item name', 'Unit', 'Qty in', 'Avg unit price', 'Cost'].join(','));
    for (const i of report.items) {
      lines.push([
        esc(i.code), esc(i.name), esc(i.unit), i.qty,
        i.avgUnitPrice ?? '', i.cost,
      ].join(','));
    }
    lines.push(['', '', '', '', 'TOTAL', report.total].join(','));
    if (report.suppliers.length > 0) {
      lines.push('');
      lines.push(['By supplier', 'Qty', 'Avg unit price', 'Cost'].join(','));
      for (const s of report.suppliers) {
        lines.push([esc(s.supplier), s.qty, s.avgUnitPrice ?? '', s.cost].join(','));
      }
    }
    const month = report.monthStart.slice(0, 7);
    return { filename: `purchases-${month}.csv`, content: '\ufeff' + lines.join('\r\n') };
  }

  /** Notify Administration when items drop to/below threshold (idempotent per state change). */
  async alertLowStock(actor?: Actor) {
    const items = await this.lowStock();
    let sent = 0;
    if (items.length > 0) {
      // RBAC-native: whoever manages inventory gets low-stock alerts
      const admins = await this.permissions.usersWithPermissions(['inventory.manage']);
      for (const item of items) {
        const recent = await this.prisma.notification.findFirst({
          where: { type: 'LOW_STOCK', title: `Low stock — ${item.name}`, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
          select: { id: true },
        });
        if (recent) continue;
        const suggested = item.minStock * 3 - item.balance;
        await this.notifications.notifyMany(admins, {
          type: 'LOW_STOCK',
          title: `Low stock — ${item.name}`,
          body: `${item.code} is at ${item.balance} ${item.unit} (threshold ${item.minStock}). Suggested restock: ${Math.max(suggested, item.minStock)} ${item.unit}.`,
          link: '/inventory',
        });
        sent++;
      }
    }
    if (sent > 0) console.log(`[inventory] low-stock alert(s) sent: ${sent}`);
    return sent;
  }

  /** Daily 08:00 — raise LOW_STOCK notifications + restock suggestions for Administration. */
  @Cron('0 0 8 * * *')
  async lowStockCron() {
    await this.alertLowStock();
  }
}
