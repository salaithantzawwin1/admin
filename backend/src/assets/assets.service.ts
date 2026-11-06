import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { Actor } from '../org/org.service';
import { stripPhotoMetadata } from './photo-metadata';
import { csvCell } from '../util/csv';
import { sniffImageType as sniffImageTypeImpl } from '../util/image-sniff';

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

/** One field a category asks for on its assets (e.g. a printer's Connection:
 *  USB / Network). `key` is the stable handle the stored values use. */
export interface SpecField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select';
  options?: string[];
}

/**
 * Category_Code for categories the office wants spelled out rather than derived
 * from the first three letters of the name. Keyed by the name with everything
 * but letters/digits stripped, so "Printer / Copier" becomes printercopier.
 */
const CATEGORY_CODES: Record<string, string> = {
  printer: 'PRI',
  copier: 'PRI',
  printercopier: 'PRI',
  copierprinter: 'PRI',
};

/** Asset cost ledger (§14.5) — what the money was spent on. The purchase
 *  price is NOT a kind here: it lives on Asset.purchaseCost, so the two can
 *  never disagree about what acquisition cost. */
const COST_KINDS = ['PURCHASE', 'SERVICE', 'REPAIR', 'PART', 'CONSUMABLE', 'OTHER'] as const;

const SPEC_TYPES = ['text', 'number', 'select'] as const;
const MAX_SPEC_FIELDS = 30;
const MAX_SPEC_VALUE = 200;

/** Asset photos: 5 MB, and only three raster formats. SVG is deliberately
 *  excluded — it can carry script, and this file is rendered inline. */
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_DIR = 'asset-photos';
const STORED_PHOTO_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

/**
 * Trust the bytes, not the browser-supplied Content-Type: a field named
 * "photo.png" carrying text/html must never reach the disk.
 */
export function sniffImageType(buf: Buffer): { mime: string; ext: string } | null {
  return sniffImageTypeImpl(buf);
}

/** 2-decimal money rounding — totals are compared and printed in kyat. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** "Connection type" → "connection_type" — the key stored on every asset. */
function specKeyFrom(label: string): string {
  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return key || 'field';
}

@Injectable()
export class AssetsService {
  private uploadRoot = process.env.UPLOAD_PATH || '/app/uploads';

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private numbering: NumberingService,
  ) {}

  /** Assets register — filters + text search; `category`/`location` included. */
  async list(filters: { q?: string; categoryId?: string; locationId?: string; status?: string; specs?: Record<string, string> }) {
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
    // Specification filters ("Connection = USB"): the answers are JSONB, so each
    // one is an exact page on the field key the category defines. Combined with
    // q/status through AND, never by overwriting them.
    const specFilters = Object.entries(filters.specs ?? {})
      .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
      .map(([key, value]) => ({ specs: { path: [key], equals: value.trim() } }));
    if (specFilters.length) {
      where.AND = [...(where.AND ?? []), ...specFilters];
    }
    const rows = await this.prisma.asset.findMany({
      where,
      orderBy: { assetCode: 'asc' },
      include: { category: true, location: true },
    });
    return rows.map((r) => this.withPhoto(r));
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
        // parts fitted into this asset (a cartridge in a printer) and, for a part,
        // the machine it currently sits in — both sides of the same link
        installedParts: {
          orderBy: [{ removedAt: 'asc' }, { installedAt: 'desc' }],
          include: {
            component: {
              select: {
                id: true, assetCode: true, name: true, status: true, purchaseCost: true,
                category: { select: { name: true } },
              },
            },
          },
        },
        installedIn: {
          orderBy: [{ removedAt: 'asc' }, { installedAt: 'desc' }],
          include: { parent: { select: { id: true, assetCode: true, name: true, status: true } } },
        },
        // the cost ledger, newest first — "how much has this asset cost us"
        costs: {
          orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
          include: {
            account: { select: { id: true, code: true, name: true } },
            supplier: { select: { id: true, name: true } },
            createdBy: { select: { username: true } },
          },
        },
      },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    // Total cost of ownership = what we paid for it + everything spent since.
    // Computed on read (never stored on the asset row) so a ledger correction
    // can never leave a stale total behind.
    const purchaseCost = asset.purchaseCost != null ? Number(asset.purchaseCost) : 0;
    const recordedCost = asset.costs.reduce((sum, c) => sum + Number(c.amount), 0);
    return {
      ...this.withPhoto(asset),
      costSummary: {
        purchaseCost: round2(purchaseCost),
        recordedCost: round2(recordedCost),
        totalCost: round2(purchaseCost + recordedCost),
        entries: asset.costs.length,
      },
    };
  }

  async create(data: {
    name: string; assetCode?: string; categoryId?: string; brand?: string; model?: string;
    serialNumber?: string; custodian?: string; locationId?: string; purchaseDate?: string;
    purchaseCost?: number; description?: string; specs?: Record<string, string> | null;
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
        // only the fields this category defines survive; blanks are dropped
        specs: this.normalizeSpecs(category?.specFields, data.specs) ?? undefined,
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
      newValue: { assetCode: asset.assetCode, name: asset.name, assetId: asset.id, specs: asset.specs },
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
    specs?: Record<string, string> | null;
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

    // Specifications follow the category: a changed category re-validates the
    // stored answers (stale keys from the old category are dropped), and a
    // blank `specs` clears them.
    const specsTouched = data.specs !== undefined || data.categoryId !== undefined;
    const nextCategoryId = data.categoryId !== undefined ? (data.categoryId || null) : asset.categoryId;
    let nextSpecs: Record<string, string> | null = null;
    if (specsTouched) {
      const fields = nextCategoryId
        ? (await this.prisma.assetCategory.findUnique({ where: { id: nextCategoryId }, select: { specFields: true } }))?.specFields
        : null;
      nextSpecs = this.normalizeSpecs(fields, data.specs !== undefined ? data.specs : asset.specs);
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
        specs: specsTouched ? (nextSpecs ?? Prisma.DbNull) : undefined,
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
      oldValue: { status: asset.status, locationId: asset.locationId, name: asset.name, assetCode: asset.assetCode, specs: asset.specs },
      newValue: { status: updated.status, locationId: updated.locationId, name: updated.name, assetCode: updated.assetCode, specs: updated.specs },
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

  /**
   * Record money spent on this asset AFTER it was acquired (§14.5): a service
   * visit, a spare part, consumables used on it, freight. The purchase price
   * itself is not entered here — it belongs to the asset's own row, so the
   * total never counts the same kyat twice.
   */
  async addCost(assetId: string, data: {
    kind: string; amount: number; date?: string; quantity?: number;
    accountId?: string; supplierId?: string; description?: string;
  }, actor: Actor) {
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId }, select: { id: true, assetCode: true } });
    if (!asset) throw new NotFoundException('Asset not found');

    const kind = String(data.kind ?? '').trim().toUpperCase();
    if (!(COST_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException(`Unknown cost kind "${data.kind}" — use one of ${COST_KINDS.join(', ')}`);
    }
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be greater than 0');
    }
    if (data.date && Number.isNaN(new Date(data.date).getTime())) {
      throw new BadRequestException('Invalid cost date');
    }
    if (data.accountId) {
      const account = await this.prisma.account.findUnique({ where: { id: data.accountId } });
      if (!account) throw new BadRequestException('Unknown account');
    }
    if (data.supplierId) {
      const supplier = await this.prisma.supplier.findUnique({ where: { id: data.supplierId } });
      if (!supplier) throw new BadRequestException('Unknown supplier');
    }

    const row = await this.prisma.assetCost.create({
      data: {
        assetId,
        kind,
        amount,
        date: data.date ? new Date(data.date) : undefined,
        quantity: data.quantity ?? undefined,
        accountId: data.accountId || undefined,
        supplierId: data.supplierId || undefined,
        description: data.description?.trim() || undefined,
        sourceType: 'MANUAL',
        createdById: actor.userId,
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ASSET_COST_ADDED', module: 'ASSETS', recordId: assetId,
      newValue: { assetCode: asset.assetCode, kind, amount: round2(amount), date: data.date ?? null, description: row.description },
    });
    return row;
  }

  /** Remove a hand-typed cost row. Rows posted from an invoice are refused —
   *  deleting one would leave the finance document and this ledger disagreeing;
   *  the invoice is where that correction belongs. */
  async removeCost(assetId: string, costId: string, actor: Actor) {
    const row = await this.prisma.assetCost.findUnique({ where: { id: costId } });
    if (!row || row.assetId !== assetId) throw new NotFoundException('Cost entry not found');
    if (row.sourceType !== 'MANUAL') {
      throw new ConflictException('This cost came from a posted invoice — correct it on the invoice, not here');
    }
    await this.prisma.assetCost.delete({ where: { id: costId } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ASSET_COST_DELETED', module: 'ASSETS', recordId: assetId,
      oldValue: { kind: row.kind, amount: Number(row.amount), date: row.date, description: row.description },
      severity: 'WARNING',
    });
    return { success: true };
  }

  /** §66 policy — assets referenced by procurement history never hard-delete:
   *  dispose (status row) keeps the audit chain; only unlinked master rows go. */
  /**
   * Fit a part asset into this asset (a cartridge into a printer).
   *
   * A cartridge bought as an asset is still a COMPONENT: the machine's cost of
   * ownership has to carry its price, and the part must stop looking like a
   * free-standing asset in the store. Installing does both — one active link per
   * part, the price posted to the parent's ledger, the movement trail on the part.
   * Consumables that are never reused are better kept as Inventory stock and
   * issued to the asset (StockTransaction ASSET_USE) instead.
   */
  async installComponent(
    parentId: string,
    data: { componentAssetId?: string; note?: string },
    actor: Actor,
  ) {
    const componentAssetId = (data.componentAssetId ?? '').trim();
    if (!componentAssetId) throw new BadRequestException('Pick the asset to install');
    if (componentAssetId === parentId) throw new BadRequestException('An asset cannot be installed in itself');

    const [parent, component] = await Promise.all([
      this.prisma.asset.findUnique({ where: { id: parentId }, select: { id: true, assetCode: true, name: true, status: true } }),
      this.prisma.asset.findUnique({
        where: { id: componentAssetId },
        select: { id: true, assetCode: true, name: true, status: true, purchaseCost: true },
      }),
    ]);
    if (!parent) throw new NotFoundException('Asset not found');
    if (!component) throw new NotFoundException('Component asset not found');
    if (parent.status === 'DISPOSED') throw new BadRequestException(`${parent.assetCode} is disposed — restore it first`);
    if (component.status === 'DISPOSED') throw new BadRequestException(`${component.assetCode} is disposed — restore it first`);

    // one physical part sits in one machine: its other holder must remove it first
    const active = await this.prisma.assetInstallation.findFirst({
      where: { componentAssetId, removedAt: null },
      include: { parent: { select: { assetCode: true } } },
    });
    if (active) {
      throw new ConflictException(
        `${component.assetCode} is already installed in ${active.parent.assetCode} — remove it there first`,
      );
    }

    const cost = component.purchaseCost != null ? Number(component.purchaseCost) : 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.assetInstallation.create({
        data: {
          parentAssetId: parentId,
          componentAssetId,
          note: data.note?.trim() || null,
          createdById: actor.userId,
          costTransferred: cost > 0 ? cost : null,
        },
      });
      await tx.asset.update({ where: { id: componentAssetId }, data: { status: 'IN_USE' } });
      await tx.assetMovement.create({
        data: {
          assetId: componentAssetId,
          type: 'INSTALL',
          createdById: actor.userId,
          note: `Installed in ${parent.assetCode} — ${parent.name}${data.note?.trim() ? ` (${data.note.trim()})` : ''}`,
        },
      });
      // the part's price belongs to the machine's cost of ownership from now on
      if (cost > 0) {
        await tx.assetCost.create({
          data: {
            assetId: parentId,
            kind: 'CONSUMABLE',
            amount: cost,
            quantity: 1,
            description: `${component.assetCode} — ${component.name} installed`,
            sourceType: 'ASSET_INSTALL',
            sourceId: component.id,
            createdById: actor.userId,
          },
        });
      }
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ASSET_COMPONENT_INSTALLED', module: 'ASSETS', recordId: parentId,
      newValue: { parent: parent.assetCode, component: component.assetCode, cost },
    });
    return this.detail(parentId);
  }

  /** Take a fitted part out: back to the store, or retired when it is used up. */
  async removeComponent(parentId: string, linkId: string, data: { retire?: boolean } = {}, actor: Actor) {
    const link = await this.prisma.assetInstallation.findUnique({
      where: { id: linkId },
      include: {
        component: { select: { id: true, assetCode: true, name: true } },
        parent: { select: { assetCode: true } },
      },
    });
    if (!link || link.parentAssetId !== parentId) throw new NotFoundException('That part is not installed on this asset');
    if (link.removedAt) throw new BadRequestException('This part was already removed');

    const retire = data.retire === true;
    await this.prisma.$transaction([
      this.prisma.assetInstallation.update({ where: { id: linkId }, data: { removedAt: new Date() } }),
      this.prisma.asset.update({
        where: { id: link.componentAssetId },
        data: { status: retire ? 'DISPOSED' : 'IN_STORAGE' },
      }),
      this.prisma.assetMovement.create({
        data: {
          assetId: link.componentAssetId,
          type: retire ? 'DISPOSE' : 'UNINSTALL',
          createdById: actor.userId,
          note: retire
            ? `Used up — removed from ${link.parent.assetCode}`
            : `Removed from ${link.parent.assetCode} — back to store`,
        },
      }),
    ]);

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: retire ? 'ASSET_COMPONENT_RETIRED' : 'ASSET_COMPONENT_REMOVED', module: 'ASSETS', recordId: parentId,
      newValue: { parent: link.parent.assetCode, component: link.component.assetCode, retired: retire },
    });
    return this.detail(parentId);
  }

  /**
   * Printable QR label for one asset: the SVG encodes this asset's own page on
   * whatever origin served the request (:80 or :8030), so scanning it opens the
   * asset for anyone already signed in — no token is baked into the label.
   */
  async qrLabel(id: string, req: { protocol?: string; headers: Record<string, unknown> }) {
    const asset = await this.prisma.asset.findUnique({
      where: { id },
      select: { id: true, assetCode: true, name: true },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
    const proto = forwarded || req.protocol || 'http';
    const host = String(req.headers['host'] ?? 'localhost');
    const url = `${proto}://${host}/asset-register?asset=${encodeURIComponent(asset.assetCode)}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 320, errorCorrectionLevel: 'M' });
    return { url, svg, assetCode: asset.assetCode, name: asset.name };
  }

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
    this.unlinkPhoto(asset.photoStoredName); // the picture goes with the row
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ASSET_DELETED', module: 'ASSETS', recordId: id,
      oldValue: { assetCode: asset.assetCode, name: asset.name },
      severity: 'WARNING',
    });
    return { success: true };
  }

  // ---------- asset photo ----------

  /** The public shape of an asset: the on-disk file name never leaves the API. */
  private withPhoto<T extends { photoStoredName?: string | null; photoMime?: string | null; photoSize?: number | null; photoUpdatedAt?: Date | null }>(asset: T) {
    const { photoStoredName, photoMime, photoSize, photoUpdatedAt, ...rest } = asset;
    return {
      ...rest,
      photo: photoStoredName
        ? { mimeType: photoMime ?? null, size: photoSize ?? null, updatedAt: photoUpdatedAt ?? null }
        : null,
    };
  }

  /** Only the exact uuid + known extension this service writes may be opened —
   *  a tampered row can never point outside the photo directory. */
  private photoPath(storedName: string): string {
    if (!STORED_PHOTO_NAME.test(storedName)) throw new NotFoundException('No photo');
    return path.join(this.uploadRoot, PHOTO_DIR, storedName);
  }

  /** Best effort: a missing/orphaned file must never block the DB update. */
  private unlinkPhoto(storedName?: string | null) {
    if (!storedName) return;
    try {
      const file = this.photoPath(storedName);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore — the row is the source of truth */
    }
  }

  /**
   * Upload or replace the asset's photo. Everything is checked BEFORE a byte is
   * written: size, and the real file signature (never the client's MIME type).
   * The file is renamed to a random uuid with an extension derived from those
   * bytes, so a crafted name can neither collide nor execute.
   */
  async setPhoto(assetId: string, file: Express.Multer.File | undefined, actor: Actor) {
    if (!file?.buffer?.length) throw new BadRequestException('No file provided');
    const asset = await this.prisma.asset.findUnique({
      where: { id: assetId },
      select: { id: true, assetCode: true, photoStoredName: true },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    if (file.size > PHOTO_MAX_BYTES) throw new BadRequestException('Photo too large (max 5 MB)');
    if (file.size !== file.buffer.length) throw new BadRequestException('Upload was truncated — please try again');
    const kind = sniffImageType(file.buffer);
    if (!kind) throw new BadRequestException('Only JPEG, PNG or WebP images are allowed');

    const dir = path.join(this.uploadRoot, PHOTO_DIR);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const storedName = `${crypto.randomUUID()}.${kind.ext}`;
    // EXIF/GPS never reaches the volume: a photo of a machine should not say
    // where and when it was taken.
    const stored = stripPhotoMetadata(file.buffer, kind.mime);
    fs.writeFileSync(path.join(dir, storedName), stored, { mode: 0o600 });

    let updated: { photoUpdatedAt: Date | null; photoMime: string | null; photoSize: number | null };
    try {
      updated = await this.prisma.asset.update({
        where: { id: assetId },
        data: { photoStoredName: storedName, photoMime: kind.mime, photoSize: stored.length, photoUpdatedAt: new Date() },
        select: { photoUpdatedAt: true, photoMime: true, photoSize: true },
      });
    } catch (e) {
      this.unlinkPhoto(storedName); // never leave an orphan when the row failed
      throw e;
    }
    this.unlinkPhoto(asset.photoStoredName); // replaced picture is gone for good

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: asset.photoStoredName ? 'ASSET_PHOTO_REPLACED' : 'ASSET_PHOTO_ADDED',
      module: 'ASSETS', recordId: assetId,
      newValue: { assetCode: asset.assetCode, mimeType: kind.mime, size: stored.length },
    });
    return {
      photo: { mimeType: updated.photoMime, size: updated.photoSize, updatedAt: updated.photoUpdatedAt },
    };
  }

  /** Path for the guarded photo route; 404 whenever there is nothing to show. */
  async photoFile(assetId: string) {
    const asset = await this.prisma.asset.findUnique({
      where: { id: assetId },
      select: { id: true, assetCode: true, photoStoredName: true, photoMime: true },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    if (!asset.photoStoredName) throw new NotFoundException('This asset has no photo');
    const filePath = this.photoPath(asset.photoStoredName);
    if (!fs.existsSync(filePath)) throw new NotFoundException('This asset has no photo');
    return { asset, filePath, mimeType: asset.photoMime ?? 'application/octet-stream' };
  }

  async removePhoto(assetId: string, actor: Actor) {
    const asset = await this.prisma.asset.findUnique({
      where: { id: assetId },
      select: { id: true, assetCode: true, photoStoredName: true },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    if (!asset.photoStoredName) throw new NotFoundException('This asset has no photo');
    await this.prisma.asset.update({
      where: { id: assetId },
      data: { photoStoredName: null, photoMime: null, photoSize: null, photoUpdatedAt: null },
    });
    this.unlinkPhoto(asset.photoStoredName);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ASSET_PHOTO_REMOVED', module: 'ASSETS', recordId: assetId,
      oldValue: { assetCode: asset.assetCode }, severity: 'WARNING',
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
    specs?: Record<string, string> | null;
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
        specs: this.normalizeSpecs(poCategory?.specFields, data.specs) ?? undefined,
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

  /**
   * §39 — receiving registers the asset: one row per accepted unit of a
   * non-stock PO line, provenance in the description, cost = that line's unit
   * price, purchase date = the GRN date. Returns what it created so the
   * receiving screen can name the new codes.
   */
  async registerFromGrnLine(data: {
    poItemId: string;
    name: string;
    quantity: number;
    unitPrice: number;
    receivedAt: Date;
    locationId?: string;
    poNumber: string;
    grnNumber: string;
  }, actor: Actor) {
    const quantity = Math.max(1, Math.floor(Number(data.quantity) || 1));
    const category = await this.assertRefs(undefined, data.locationId);
    const unitCost = round2(Math.max(0, Number(data.unitPrice) || 0));
    const created: { id: string; assetCode: string; name: string }[] = [];
    for (let i = 0; i < quantity; i++) {
      const asset = await this.prisma.asset.create({
        data: {
          assetCode: await this.nextAutoCode(category?.name),
          name: (data.name || 'Received asset').trim().slice(0, 160),
          locationId: data.locationId || undefined,
          purchaseDate: data.receivedAt,
          purchaseCost: unitCost,
          description: `Received on ${data.grnNumber} from ${data.poNumber}${quantity > 1 ? ` (unit ${i + 1}/${quantity})` : ''}`,
        },
      });
      await this.prisma.assetMovement.create({
        data: {
          assetId: asset.id,
          type: 'REGISTER',
          toLocationId: asset.locationId,
          note: `Registered on receipt ${data.grnNumber}`,
          createdById: actor.userId,
        },
      });
      created.push({ id: asset.id, assetCode: asset.assetCode, name: asset.name });
    }
    // the PO line keeps a back-reference to the first unit registered from it
    const item = await this.prisma.purchaseOrderItem.findUnique({
      where: { id: data.poItemId },
      select: { assetId: true },
    });
    if (!item?.assetId && created[0]) {
      await this.prisma.purchaseOrderItem.update({ where: { id: data.poItemId }, data: { assetId: created[0].id } });
    }
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ASSET_REGISTERED_ON_RECEIPT', module: 'ASSETS', recordId: created[0]?.id ?? data.poItemId,
      newValue: { poNumber: data.poNumber, grnNumber: data.grnNumber, codes: created.map((c) => c.assetCode), unitCost },
    });
    return created;
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
      return csvCell(v);
    };
    const lines = ['Asset Code,Name,Category,Specifications,Brand,Model,Serial,Custodian,Location,Status,Purchase Date,Cost MMK,Acquired via'];
    for (const a of rows) {
      lines.push([
        a.assetCode, a.name, a.category?.name ?? '', this.specsText(a.category?.specFields, a.specs),
        a.brand ?? '', a.model ?? '',
        a.serialNumber ?? '', a.custodian ?? '', a.location?.name ?? '', a.status,
        a.purchaseDate ? a.purchaseDate.toISOString().slice(0, 10) : '',
        a.purchaseCost != null ? a.purchaseCost.toFixed(2) : '',
        a.poItems.map((p) => p.purchaseOrder.poNumber).join('; '),
      ].map(esc).join(','));
    }
    return lines.join('\n');
  }

  /** "Connection: Network (LAN); Color: Mono" — labels from the category so the
   *  sheet reads without a key, in the order the category defines. */
  private specsText(fields: unknown, specs: unknown): string {
    const defs = Array.isArray(fields) ? (fields as SpecField[]) : [];
    const values = (specs && typeof specs === 'object' && !Array.isArray(specs) ? specs : {}) as Record<string, string>;
    return defs
      .filter((f) => f?.key && values[f.key])
      .map((f) => `${f.label}: ${values[f.key]}`)
      .join('; ');
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
  private async assertRefs(categoryId?: string, locationId?: string): Promise<{ name: string; specFields?: unknown } | null> {
    let category: { name: string; specFields?: unknown } | null = null;
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

  // ---------- category specification fields ----------

  /** Replace a category's specification field definitions (Asset Setup tab).
   *  Empty input clears them; existing asset values are kept as-is — they are
   *  only pruned when that asset is next saved with its (new) field list. */
  async setCategorySpecFields(id: string, input: unknown, actor: Actor) {
    const prev = await this.prisma.assetCategory.findUnique({ where: { id } });
    if (!prev) throw new NotFoundException('Asset category not found');
    const fields = this.normalizeSpecFields(input);
    const row = await this.prisma.assetCategory.update({
      where: { id },
      data: { specFields: fields.length ? (fields as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ASSET_CATEGORY_SPECS_UPDATED', module: 'ASSETS', recordId: id,
      oldValue: { name: prev.name, specFields: prev.specFields },
      newValue: { name: row.name, specFields: row.specFields },
    });
    const { total } = await this.setupUsage('categories', row);
    return { ...row, usage: total };
  }

  /** Validate + normalise the field list a category defines. Keys stay stable:
   *  a field keeps the key it was saved with, so existing values survive a
   *  label edit; a brand-new field derives its key from the label. */
  private normalizeSpecFields(input: unknown): SpecField[] {
    if (!Array.isArray(input)) throw new BadRequestException('Specification fields must be a list');
    if (input.length > MAX_SPEC_FIELDS) {
      throw new BadRequestException(`At most ${MAX_SPEC_FIELDS} specification fields per category`);
    }
    const out: SpecField[] = [];
    const seen = new Set<string>();
    // Two fields with the same label would show up as two identical questions
    // in the asset form (and read the same in the CSV), so labels stay unique.
    const seenLabels = new Set<string>();
    for (const raw of input) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BadRequestException('Each specification field must be an object');
      }
      const src = raw as Record<string, unknown>;
      const label = String(src.label ?? '').trim();
      if (!label) throw new BadRequestException('Every specification field needs a label');
      if (label.length > 60) throw new BadRequestException(`Field label "${label}" is too long (max 60)`);
      const labelId = label.toLowerCase();
      if (seenLabels.has(labelId)) {
        throw new BadRequestException(`Duplicate field label "${label}" — every field needs its own name`);
      }
      seenLabels.add(labelId);
      const type = String(src.type ?? 'text') as SpecField['type'];
      if (!(SPEC_TYPES as readonly string[]).includes(type)) {
        throw new BadRequestException(`Unknown field type "${type}"`);
      }
      const base = String(src.key ?? '').trim() ? specKeyFrom(String(src.key)) : specKeyFrom(label);
      let key = base;
      for (let n = 2; seen.has(key); n++) key = `${base}_${n}`;
      seen.add(key);
      const field: SpecField = { key, label, type };
      if (type === 'select') {
        // De-dupe case-insensitively — typing "USB, usb" must not create two
        // identical <option>s — and keep the order the admin typed.
        const options: string[] = [];
        const seenOptions = new Set<string>();
        for (const rawOption of Array.isArray(src.options) ? src.options : []) {
          const option = String(rawOption ?? '').trim();
          if (!option) continue;
          if (option.length > MAX_SPEC_VALUE) {
            throw new BadRequestException(`Option "${option.slice(0, 30)}…" is too long (max ${MAX_SPEC_VALUE})`);
          }
          const optionId = option.toLowerCase();
          if (seenOptions.has(optionId)) continue;
          seenOptions.add(optionId);
          options.push(option);
        }
        if (!options.length) throw new BadRequestException(`Field "${label}" needs at least one option`);
        if (options.length > MAX_SPEC_FIELDS) {
          throw new BadRequestException(`Field "${label}" has too many options (max ${MAX_SPEC_FIELDS})`);
        }
        field.options = options;
      }
      out.push(field);
    }
    return out;
  }

  /** Keep only the values whose key the category defines, trimmed; blanks and
   *  an empty result are stored as NULL so "not filled in" stays visible. */
  private normalizeSpecs(fields: unknown, input: unknown): Record<string, string> | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const defs = Array.isArray(fields) ? (fields as SpecField[]) : [];
    const out: Record<string, string> = {};
    for (const f of defs) {
      if (!f?.key) continue;
      const raw = (input as Record<string, unknown>)[f.key];
      if (raw === undefined || raw === null) continue;
      // A nested object/array is not a specification answer — String() would
      // have stored "[object Object]" in the register.
      if (typeof raw === 'object') {
        throw new BadRequestException(`"${f.label}" must be a single value`);
      }
      const value = String(raw).trim();
      if (!value) continue;
      if (value.length > MAX_SPEC_VALUE) {
        throw new BadRequestException(`"${f.label}" is too long (max ${MAX_SPEC_VALUE} characters)`);
      }
      if (f.type === 'number') {
        // "1,200" is how this office types amounts — accept it, store the number
        const n = Number(value.replace(/,/g, ''));
        if (!Number.isFinite(n)) throw new BadRequestException(`"${f.label}" must be a number`);
        out[f.key] = String(n);
        continue;
      }
      if (f.type === 'select') {
        const allowed = f.options ?? [];
        const match = allowed.find((o) => o.toLowerCase() === value.toLowerCase());
        if (!match) {
          throw new BadRequestException(`"${f.label}" must be one of: ${allowed.join(', ')}`);
        }
        out[f.key] = match;
        continue;
      }
      out[f.key] = value;
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * Auto codes are scoped to the asset's category: "IT Equipment" → AST-ITE-2611-0001
   * instead of the generic AST-2611-0001, so codes sort and read by type.
   * The year is two digits (YYMM, e.g. 2611) — short enough to read, still
   * ordered by month. Only the stamp follows the month: the running number is
   * one global counter that never restarts (NumberingService.nextAssetCode).
   * A Latin-free (Burmese) name or no category keeps the plain AST- prefix.
   */
  private autoPrefix(categoryName?: string | null): string {
    const seg = this.categorySegment(categoryName);
    return seg ? `AST-${seg}` : 'AST';
  }

  /** The Category_Code printed between AST and the stamp: fixed for the names in
   *  CATEGORY_CODES (Printer / Copier → PRI), otherwise the first three A-Z/0-9
   *  characters of the category name uppercased. */
  private categorySegment(categoryName?: string | null): string {
    const name = categoryName ?? '';
    const fixed = CATEGORY_CODES[name.toLowerCase().replace(/[^a-z0-9]/g, '')];
    return fixed ?? name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  }

  /** The sequence only knows its own rows: a hand-typed code can already occupy
   *  the slot it is about to hand out, so retry until a free code comes back. */
  private async nextAutoCode(categoryName?: string | null): Promise<string> {
    const prefix = this.autoPrefix(categoryName);
    for (let i = 0; i < 10; i++) {
      const code = await this.numbering.nextAssetCode(prefix);
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
