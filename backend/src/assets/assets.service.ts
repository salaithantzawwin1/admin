import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { Actor } from '../org/org.service';

const ASSET_STATUSES = ['ACTIVE', 'IN_STORAGE', 'MAINTENANCE', 'DISPOSED'] as const;

/** Asset Setup (New) master lists — each is a flat {id,name} table. */
export type SetupKind = 'categories' | 'locations' | 'custodians';

const SETUP_LABEL: Record<SetupKind, string> = {
  categories: 'Category', locations: 'Location', custodians: 'Custodian',
};

const SETUP_AUDIT: Record<SetupKind, string> = {
  categories: 'ASSET_CATEGORY', locations: 'ASSET_LOCATION', custodians: 'ASSET_CUSTODIAN',
};

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
    const category = await this.assertRefs(data.categoryId, data.locationId);
    if (data.purchaseCost !== undefined && data.purchaseCost !== null && data.purchaseCost < 0) {
      throw new BadRequestException('Purchase cost must be non-negative');
    }

    const asset = await this.prisma.asset.create({
      data: {
        assetCode: assetCode || (await this.nextAutoCode(category?.name)),
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
    name?: string; assetCode?: string; categoryId?: string | null; brand?: string | null; model?: string | null;
    serialNumber?: string | null; custodian?: string | null; locationId?: string | null;
    purchaseDate?: string | null; purchaseCost?: number | null; description?: string | null; status?: string;
  }, actor: Actor) {
    const asset = await this.prisma.asset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Asset not found');
    if (data.status && !ASSET_STATUSES.includes(data.status as never)) {
      throw new BadRequestException('Unknown asset status');
    }
    // editable asset code — the Edit dialog posts the row's own code, so only a
    // genuinely CHANGED code is uniqueness-checked (same 409 wording as create)
    const assetCode = data.assetCode?.trim();
    if (assetCode && assetCode !== asset.assetCode) {
      const taken = await this.prisma.asset.findUnique({ where: { assetCode } });
      if (taken && taken.id !== id) throw new ConflictException(`Asset code "${assetCode}" already exists`);
    }
    await this.assertRefs(data.categoryId ?? undefined, data.locationId ?? undefined);
    if (data.purchaseCost != null && data.purchaseCost < 0) {
      throw new BadRequestException('Purchase cost must be non-negative');
    }

    const updated = await this.prisma.asset.update({
      where: { id },
      data: {
        name: data.name?.trim() || asset.name,
        // code stays as-is when untouched/blank; a real change lands here
        assetCode: assetCode || undefined,
        // null clears the link ("— none —" in the form), undefined keeps it
        categoryId: data.categoryId !== undefined ? (data.categoryId || null) : asset.categoryId,
        brand: data.brand !== undefined ? (data.brand?.trim() || null) : undefined,
        model: data.model !== undefined ? (data.model?.trim() || null) : undefined,
        serialNumber: data.serialNumber !== undefined ? (data.serialNumber?.trim() || null) : undefined,
        custodian: data.custodian !== undefined ? (data.custodian?.trim() || null) : undefined,
        locationId: data.locationId !== undefined ? (data.locationId || null) : asset.locationId,
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
      oldValue: { status: asset.status, locationId: asset.locationId, name: asset.name, assetCode: asset.assetCode },
      newValue: { status: updated.status, locationId: updated.locationId, name: updated.name, assetCode: updated.assetCode },
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
    const poCategory = await this.assertRefs(data.categoryId, data.locationId);

    const asset = await this.prisma.asset.create({
      data: {
        assetCode: await this.nextAutoCode(poCategory?.name),
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

  /** Validates the optional category/location links and returns the category row
   *  (callers need its name to build a category-scoped asset code). */
  private async assertRefs(categoryId?: string, locationId?: string): Promise<{ name: string } | null> {
    let category: { name: string } | null = null;
    if (categoryId) {
      category = await this.prisma.assetCategory.findUnique({ where: { id: categoryId } });
      if (!category) throw new BadRequestException('Unknown asset category');
    }
    if (locationId) {
      const loc = await this.prisma.location.findUnique({ where: { id: locationId } });
      if (!loc) throw new BadRequestException('Unknown location');
    }
    return category;
  }

  /**
   * Auto codes are scoped to the asset's category: "IT Equipment" → AST-ITE-202610-0001
   * instead of the generic AST-202610-0001, so codes sort and read by type.
   * The segment is the first three A-Z/0-9 characters of the name uppercased;
   * a Latin-free (Burmese) name or no category keeps the plain AST- prefix.
   * Categories that share a segment share one counter — codes stay unique either way.
   */
  private autoPrefix(categoryName?: string | null): string {
    const seg = (categoryName ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
    return seg ? `AST-${seg}` : 'AST';
  }

  /** The sequence only knows its own rows: a hand-typed code can already occupy
   *  the slot it is about to hand out, so retry until a free code comes back. */
  private async nextAutoCode(categoryName?: string | null): Promise<string> {
    const prefix = this.autoPrefix(categoryName);
    for (let i = 0; i < 10; i++) {
      const code = await this.numbering.next(prefix);
      const taken = await this.prisma.asset.findUnique({ where: { assetCode: code } });
      if (!taken) return code;
    }
    throw new ConflictException('Could not allocate a free asset code — please enter one manually');
  }

  // ---------- Asset Setup master data: categories / locations / custodians ----------

  /** Rows used by the Asset Setup (New) tab. The usage count is what blocks a
   *  delete, so it is computed the same way in list and remove. */
  async listSetup(kind: SetupKind) {
    const rows: any[] = await this.setupModel(kind).findMany({ orderBy: { name: 'asc' } });
    const out = [] as Array<Record<string, unknown>>;
    for (const row of rows) {
      const { total } = await this.setupUsage(kind, row);
      out.push({ ...row, usage: total });
    }
    return out;
  }

  async createSetup(kind: SetupKind, data: { name: string }, actor: Actor) {
    const name = data.name?.trim();
    if (!name) throw new BadRequestException('Name is required');
    const taken = await this.setupModel(kind).findUnique({ where: { name } });
    if (taken) throw new ConflictException(`${SETUP_LABEL[kind]} "${name}" already exists`);
    const row = await this.setupModel(kind).create({ data: { name } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: `${SETUP_AUDIT[kind]}_CREATED`, module: 'ASSETS', recordId: row.id,
      newValue: { name },
    });
    return { ...row, usage: 0 };
  }

  async updateSetup(kind: SetupKind, id: string, data: { name: string }, actor: Actor) {
    const prev = await this.setupModel(kind).findUnique({ where: { id } });
    if (!prev) throw new NotFoundException(`${SETUP_LABEL[kind]} not found`);
    const name = data.name?.trim();
    if (!name) throw new BadRequestException('Name is required');
    if (name !== prev.name) {
      const taken = await this.setupModel(kind).findUnique({ where: { name } });
      if (taken) throw new ConflictException(`${SETUP_LABEL[kind]} "${name}" already exists`);
    }
    const row = await this.setupModel(kind).update({ where: { id }, data: { name } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: `${SETUP_AUDIT[kind]}_UPDATED`, module: 'ASSETS', recordId: id,
      oldValue: { name: prev.name }, newValue: { name },
    });
    const { total } = await this.setupUsage(kind, row);
    return { ...row, usage: total };
  }

  async removeSetup(kind: SetupKind, id: string, actor: Actor) {
    const prev = await this.setupModel(kind).findUnique({ where: { id } });
    if (!prev) throw new NotFoundException(`${SETUP_LABEL[kind]} not found`);
    const { total, parts } = await this.setupUsage(kind, prev);
    if (total > 0) {
      throw new ConflictException(
        `${SETUP_LABEL[kind]} "${prev.name}" is still used by ${parts.join(', ')} — reassign or clear those first`,
      );
    }
    await this.setupModel(kind).delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: `${SETUP_AUDIT[kind]}_DELETED`, module: 'ASSETS', severity: 'WARNING',
      recordId: id, oldValue: { name: prev.name },
    });
    return { success: true };
  }

  private setupModel(kind: SetupKind): any {
    return kind === 'categories' ? this.prisma.assetCategory
      : kind === 'locations' ? this.prisma.location
      : this.prisma.custodian;
  }

  /**
   * Referencing records that block a delete. Categories/locations are FKs with
   * ON DELETE SET NULL (deleting would silently rewrite asset rows and movement /
   * receipt history), and a custodian name is snapshotted onto assets the same way,
   * so all three are refused while still in use.
   */
  private async setupUsage(kind: SetupKind, row: { id: string; name: string }): Promise<{ total: number; parts: string[] }> {
    const label = (n: number, s: string) => (n ? [`${n} ${s}${n === 1 ? '' : 's'}`] : []);
    if (kind === 'categories') {
      const n = await this.prisma.asset.count({ where: { categoryId: row.id } });
      return { total: n, parts: label(n, 'asset') };
    }
    if (kind === 'custodians') {
      const n = await this.prisma.asset.count({ where: { custodian: row.name } });
      return { total: n, parts: label(n, 'asset') };
    }
    const [assets, receipts, from, to] = await Promise.all([
      this.prisma.asset.count({ where: { locationId: row.id } }),
      this.prisma.goodsReceipt.count({ where: { locationId: row.id } }),
      this.prisma.assetMovement.count({ where: { fromLocationId: row.id } }),
      this.prisma.assetMovement.count({ where: { toLocationId: row.id } }),
    ]);
    return {
      total: assets + receipts + from + to,
      parts: [...label(assets, 'asset'), ...label(receipts, 'goods receipt'),
        ...label(from + to, 'movement record')],
    };
  }
}
