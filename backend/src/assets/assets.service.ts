import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { Actor } from '../org/org.service';

const ASSET_STATUSES = ['ACTIVE', 'IN_STORAGE', 'MAINTENANCE', 'DISPOSED'] as const;

/** Movement rows audit the lifecycle (§16/§40): every register/transfer/
 *  status change leaves one append-only row. */
const MOVEMENT_FOR_TRANSITION: Record<string, string> = {
  'ACTIVE>DISPOSED': 'DISPOSE',
  'DISPOSED>ACTIVE': 'RESTORE',
  '>MAINTENANCE': 'MAINTENANCE',
  'MAINTENANCE>': 'RESTORE',
};

@Injectable()
export class AssetsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private numbering: NumberingService,
  ) {}

  /** Assets register — filters + text search; `category`/`location` included. */
  async list(filters: { q?: string; categoryId?: string; locationId?: string; status?: string }) {
    const where: any = {};
    if (filters.categoryId) where.categoryId = filters.categoryId;
    if (filters.locationId) where.locationId = filters.locationId;
    if (filters.status) {
      if (!ASSET_STATUSES.includes(filters.status as never)) throw new BadRequestException('Unknown asset status');
      where.status = filters.status;
    }
    if (filters.q) {
      where.OR = [
        { assetCode: { contains: filters.q, mode: 'insensitive' } },
        { name: { contains: filters.q, mode: 'insensitive' } },
        { serialNumber: { contains: filters.q, mode: 'insensitive' } },
        { custodian: { contains: filters.q, mode: 'insensitive' } },
      ];
    }
    return this.prisma.asset.findMany({
      where,
      orderBy: { assetCode: 'asc' },
      include: { category: true, location: true },
    });
  }

  /** One asset with its full movement history + procurement provenance (§39). */
  async detail(id: string) {
    const asset = await this.prisma.asset.findUnique({
      where: { id },
      include: {
        category: true,
        location: true,
        movements: {
          orderBy: { createdAt: 'desc' },
          include: { fromLocation: true, toLocation: true, createdBy: { select: { username: true, fullName: true } } },
        },
        poItems: { include: { purchaseOrder: { select: { poNumber: true, supplier: { select: { name: true } } } } } },
      },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    return asset;
  }

  async create(data: {
    name: string; assetCode?: string; categoryId?: string; brand?: string; model?: string;
    serialNumber?: string; custodian?: string; locationId?: string; purchaseDate?: string;
    purchaseCost?: number; description?: string;
  }, actor: Actor) {
    const assetCode = data.assetCode?.trim();
    if (assetCode) {
      const taken = await this.prisma.asset.findUnique({ where: { assetCode } });
      if (taken) throw new ConflictException(`Asset code "${assetCode}" already exists`);
    }
    await this.assertRefs(data.categoryId, data.locationId);
    if (data.purchaseCost !== undefined && data.purchaseCost !== null && data.purchaseCost < 0) {
      throw new BadRequestException('Purchase cost must be non-negative');
    }

    const asset = await this.prisma.asset.create({
      data: {
        assetCode: assetCode || (await this.numbering.next('AST')),
        name: data.name.trim(),
        categoryId: data.categoryId || undefined,
        brand: data.brand?.trim() || undefined,
        model: data.model?.trim() || undefined,
        serialNumber: data.serialNumber?.trim() || undefined,
        custodian: data.custodian?.trim() || undefined,
        locationId: data.locationId || undefined,
        purchaseDate: data.purchaseDate ? new Date(data.purchaseDate) : undefined,
        purchaseCost: data.purchaseCost ?? undefined,
        description: data.description?.trim() || undefined,
      },
      include: { category: true, location: true },
    });
    await this.prisma.assetMovement.create({
      data: {
        assetId: asset.id, type: 'REGISTER', toLocationId: asset.locationId,
        note: 'Registered', createdById: actor.userId,
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ASSET_CREATED', module: 'ASSETS', recordId: asset.id,
      newValue: { assetCode: asset.assetCode, name: asset.name, assetId: asset.id },
    });
    return asset;
  }

  /** Edit descriptive fields. Status and location changes move the lifecycle:
   *  status transitions write DISPOSE/RESTORE/MAINTENANCE movements; a
   *  location change writes a TRANSFER movement automatically (§40). */
  async update(id: string, data: {
    name?: string; categoryId?: string; brand?: string | null; model?: string | null;
    serialNumber?: string | null; custodian?: string | null; locationId?: string;
    purchaseDate?: string | null; purchaseCost?: number | null; description?: string | null; status?: string;
  }, actor: Actor) {
    const asset = await this.prisma.asset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Asset not found');
    if (data.status && !ASSET_STATUSES.includes(data.status as never)) {
      throw new BadRequestException('Unknown asset status');
    }
    await this.assertRefs(data.categoryId, data.locationId || undefined);
    if (data.purchaseCost != null && data.purchaseCost < 0) {
      throw new BadRequestException('Purchase cost must be non-negative');
    }

    const updated = await this.prisma.asset.update({
      where: { id },
      data: {
        name: data.name?.trim() || asset.name,
        categoryId: data.categoryId || asset.categoryId,
        brand: data.brand !== undefined ? (data.brand?.trim() || null) : undefined,
        model: data.model !== undefined ? (data.model?.trim() || null) : undefined,
        serialNumber: data.serialNumber !== undefined ? (data.serialNumber?.trim() || null) : undefined,
        custodian: data.custodian !== undefined ? (data.custodian?.trim() || null) : undefined,
        locationId: data.locationId || asset.locationId,
        purchaseDate: data.purchaseDate !== undefined ? (data.purchaseDate ? new Date(data.purchaseDate) : null) : undefined,
        purchaseCost: data.purchaseCost !== undefined ? data.purchaseCost : undefined,
        description: data.description !== undefined ? (data.description?.trim() || null) : undefined,
        status: data.status ?? asset.status,
      },
      include: { category: true, location: true },
    });

    if (asset.locationId !== updated.locationId) {
      await this.move(id, 'TRANSFER', asset.locationId, updated.locationId, 'Location changed via edit', actor);
    }
    const statusKey = `${asset.status}>${updated.status}`;
    const movementType = MOVEMENT_FOR_TRANSITION[statusKey];
    if (movementType) {
      await this.move(id, movementType, updated.locationId, updated.locationId, `Status ${asset.status} → ${updated.status}`, actor);
    }
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ASSET_UPDATED', module: 'ASSETS', recordId: id,
      oldValue: { status: asset.status, locationId: asset.locationId, name: asset.name },
      newValue: { status: updated.status, locationId: updated.locationId, name: updated.name },
    });
    return updated;
  }

  /** §40 transfer — location + custody in one auditable move. */
  async transfer(id: string, data: { toLocationId?: string; custodian?: string | null; note?: string }, actor: Actor) {
    const asset = await this.prisma.asset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Asset not found');
    if (asset.status === 'DISPOSED') throw new BadRequestException('A disposed asset cannot be transferred');
    if (data.toLocationId && data.toLocationId !== asset.locationId) await this.assertRefs(undefined, data.toLocationId);

    const updated = await this.prisma.asset.update({
      where: { id },
      data: {
        locationId: data.toLocationId || asset.locationId,
        custodian: data.custodian !== undefined ? (data.custodian?.trim() || null) : asset.custodian,
      },
      include: { location: true },
    });
    await this.move(id, 'TRANSFER', asset.locationId, updated.locationId, data.note?.trim() || undefined, actor);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ASSET_TRANSFERRED', module: 'ASSETS', recordId: id,
      oldValue: { locationId: asset.locationId, custodian: asset.custodian },
      newValue: { locationId: updated.locationId, custodian: updated.custodian },
    });
    return updated;
  }

  /** §66 policy — assets referenced by procurement history never hard-delete:
   *  dispose (status row) keeps the audit chain; only unlinked master rows go. */
  async remove(id: string, actor: Actor) {
    const asset = await this.prisma.asset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Asset not found');
    const [prCount, invCount, poCount] = await Promise.all([
      this.prisma.purchaseRequestItem.count({ where: { assetId: id } }),
      this.prisma.invoiceItem.count({ where: { assetId: id } }),
      this.prisma.purchaseOrderItem.count({ where: { assetId: id } }),
    ]);
    const used = prCount + invCount + poCount;
    if (used > 0) {
      throw new ConflictException(`Asset has ${used} procurement reference(s) — set status DISPOSED instead of deleting`);
    }
    await this.prisma.asset.delete({ where: { id } }); // movements cascade (FK CASCADE)
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ASSET_DELETED', module: 'ASSETS', recordId: id,
      oldValue: { assetCode: asset.assetCode, name: asset.name },
      severity: 'WARNING',
    });
    return { success: true };
  }

  /** §39 — register a fixed asset from a PO line: cost = accepted qty × unit
   *  price (falls back to the ordered qty before any GRN), purchase date =
   *  first GRN receipt. The PO line stores the back-reference; a second
   *  registration of the same line is refused. */
  async registerFromPoLine(poItemId: string, data: {
    name?: string; categoryId?: string; locationId?: string; serialNumber?: string;
    brand?: string; model?: string; custodian?: string; purchaseCost?: number;
  }, actor: Actor) {
    const item = await this.prisma.purchaseOrderItem.findUnique({
      where: { id: poItemId },
      include: {
        purchaseOrder: { include: { goodsReceipts: { orderBy: { receivedAt: 'asc' } } } },
        grnItems: true,
      },
    });
    if (!item) throw new NotFoundException('PO line not found');
    if (item.inventoryItemId) {
      throw new ConflictException('This PO line received consumables into stock — stock items never map to an asset');
    }
    if (item.assetId) {
      throw new ConflictException(`PO line already registered asset ${item.assetId}`);
    }

    const accepted = item.grnItems.reduce((s, g) => s + g.acceptedQty, 0);
    const cost = data.purchaseCost ?? Number(item.unitPrice) * (accepted > 0 ? accepted : item.quantity);
    if (cost < 0) throw new BadRequestException('Purchase cost must be non-negative');
    await this.assertRefs(data.categoryId, data.locationId);

    const asset = await this.prisma.asset.create({
      data: {
        assetCode: await this.numbering.next('AST'),
        name: data.name?.trim() || item.description,
        categoryId: data.categoryId || undefined,
        brand: data.brand?.trim() || undefined,
        model: data.model?.trim() || undefined,
        serialNumber: data.serialNumber?.trim() || undefined,
        custodian: data.custodian?.trim() || undefined,
        locationId: data.locationId || undefined,
        purchaseDate: item.purchaseOrder.goodsReceipts[0]?.receivedAt ?? new Date(),
        purchaseCost: cost,
        description: `Registered from ${item.purchaseOrder.poNumber} (line: ${item.description})`,
      },
      include: { category: true, location: true },
    });
    await this.prisma.purchaseOrderItem.update({ where: { id: poItemId }, data: { assetId: asset.id } });
    await this.prisma.assetMovement.create({
      data: {
        assetId: asset.id, type: 'REGISTER', toLocationId: asset.locationId,
        note: `Registered from ${item.purchaseOrder.poNumber}`, createdById: actor.userId,
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ASSET_REGISTERED_FROM_PO', module: 'ASSETS', recordId: asset.id,
      newValue: { assetCode: asset.assetCode, poNumber: item.purchaseOrder.poNumber, poItemId, cost },
    });
    return asset;
  }

  /** §41 asset register CSV — one row per asset incl. acquisition provenance. */
  async csv() {
    const rows = await this.prisma.asset.findMany({
      orderBy: { assetCode: 'asc' },
      include: {
        category: true, location: true,
        poItems: { include: { purchaseOrder: { select: { poNumber: true } } } },
      },
    });
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['Asset Code,Name,Category,Brand,Model,Serial,Custodian,Location,Status,Purchase Date,Cost MMK,Acquired via'];
    for (const a of rows) {
      lines.push([
        a.assetCode, a.name, a.category?.name ?? '', a.brand ?? '', a.model ?? '',
        a.serialNumber ?? '', a.custodian ?? '', a.location?.name ?? '', a.status,
        a.purchaseDate ? a.purchaseDate.toISOString().slice(0, 10) : '',
        a.purchaseCost != null ? a.purchaseCost.toFixed(2) : '',
        a.poItems.map((p) => p.purchaseOrder.poNumber).join('; '),
      ].map(esc).join(','));
    }
    return lines.join('\n');
  }

  private async move(assetId: string, type: string, fromLocationId: string | null, toLocationId: string | null, note: string | undefined, actor: Actor) {
    await this.prisma.assetMovement.create({
      data: {
        assetId, type, fromLocationId: fromLocationId || undefined, toLocationId: toLocationId || undefined,
        note, createdById: actor.userId,
      },
    });
  }

  private async assertRefs(categoryId?: string, locationId?: string) {
    if (categoryId) {
      const cat = await this.prisma.assetCategory.findUnique({ where: { id: categoryId } });
      if (!cat) throw new BadRequestException('Unknown asset category');
    }
    if (locationId) {
      const loc = await this.prisma.location.findUnique({ where: { id: locationId } });
      if (!loc) throw new BadRequestException('Unknown location');
    }
  }
}
