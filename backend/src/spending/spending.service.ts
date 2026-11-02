import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { Actor } from '../org/org.service';

/** What the money bought — mirrors the asset cost ledger's kinds. */
const COST_KINDS = ['SERVICE', 'REPAIR', 'PART', 'CONSUMABLE', 'PURCHASE', 'OTHER'] as const;
const MAINTENANCE_TYPES = ['PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'WARRANTY_SERVICE', 'EMERGENCY'] as const;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * "Administration Spend" — ONE entry for money that leaves the office.
 *
 * Before this, the same kyat had to be typed in three places (petty cash, the
 * asset's history, the service log) and the third one was usually forgotten,
 * which is how "paid but not recorded" gaps appear. Here one submission writes,
 * inside a single database transaction:
 *
 *   • petty cash EXPENSE (when the money came out of the float)
 *   • the asset cost row that attributes the money to the machine
 *   • optionally the maintenance record for that machine (history + next due)
 *   • optionally stock issued from the store to that machine
 *
 * Double counting is refused rather than silently allowed: stock issued from
 * the store was already paid for when it was bought, so such an entry carries
 * no amount — recording both would put the same money on the asset twice.
 */
@Injectable()
export class SpendingService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private numbering: NumberingService,
  ) {}

  async create(data: {
    date?: string; description?: string; amount?: number; payee?: string;
    accountId?: string; supplierId?: string; paidFrom?: string;
    assetId?: string; costKind?: string;
    maintenance?: { type?: string; problem?: string; workDone?: string; nextDueDate?: string };
    stockLines?: { itemId: string; quantity: number }[];
    /** Bought into the store this time: [{ itemId, quantity, unitPrice }]. */
    purchaseLines?: { itemId: string; quantity: number; unitPrice?: number }[];
  }, actor: Actor) {
    const stockLines = Array.isArray(data.stockLines) ? data.stockLines : [];
    const purchaseLines = Array.isArray(data.purchaseLines) ? data.purchaseLines : [];
    const amount = Number(data.amount ?? 0);
    const paidFrom = String(data.paidFrom ?? 'PETTY_CASH').toUpperCase();
    if (!['PETTY_CASH', 'OTHER'].includes(paidFrom)) {
      throw new BadRequestException('paidFrom must be PETTY_CASH or OTHER');
    }
    if (stockLines.length && amount > 0) {
      throw new BadRequestException(
        'Stock taken from the store was already paid for when it was bought — record the usage without an amount',
      );
    }
    if (purchaseLines.length && stockLines.length) {
      throw new BadRequestException('Buying stock and using stock are separate entries — record the purchase, then issue it');
    }
    if (!stockLines.length && !purchaseLines.length && !(amount > 0)) {
      throw new BadRequestException('Enter the amount spent, or the stock being used');
    }
    // buying into the store: the lines price the money when no total is typed
    const purchaseValue = round2(purchaseLines.reduce((s, l) => s + Number(l.unitPrice ?? 0) * l.quantity, 0));
    const money = amount > 0 ? amount : purchaseValue;
    const date = data.date ? new Date(data.date) : new Date();
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date');

    const costKind = String(data.costKind ?? 'OTHER').toUpperCase();
    if (money > 0 && !(COST_KINDS as readonly string[]).includes(costKind)) {
      throw new BadRequestException(`Unknown cost kind "${data.costKind}" (${COST_KINDS.join(', ')})`);
    }

    // references are resolved up front so a bad id fails before anything is written
    let asset: { id: string; assetCode: string; name: string } | null = null;
    if (data.assetId) {
      asset = await this.prisma.asset.findUnique({
        where: { id: data.assetId }, select: { id: true, assetCode: true, name: true },
      });
      if (!asset) throw new BadRequestException('Unknown asset');
    }
    if (data.accountId) {
      const account = await this.prisma.account.findUnique({ where: { id: data.accountId } });
      if (!account) throw new BadRequestException('Unknown account');
    }
    if (data.supplierId) {
      const supplier = await this.prisma.supplier.findUnique({ where: { id: data.supplierId } });
      if (!supplier) throw new BadRequestException('Unknown supplier');
    }
    for (const line of stockLines) {
      if (!line?.itemId) throw new BadRequestException('Every stock line needs an item');
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new BadRequestException('Stock quantity must be a positive whole number');
      }
      if (!asset) throw new BadRequestException('Stock can only be issued to a named asset');
    }
    for (const line of purchaseLines) {
      if (!line?.itemId) throw new BadRequestException('Every purchase line needs an item');
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new BadRequestException('Purchase quantity must be a positive whole number');
      }
      if (!Number.isFinite(Number(line.unitPrice ?? 0)) || Number(line.unitPrice ?? 0) < 0) {
        throw new BadRequestException('Purchase unit price must be zero or more');
      }
    }
    if (purchaseLines.length && asset) {
      throw new BadRequestException('A purchase into the store cannot also be charged to an asset — issue it to the asset when it is used');
    }
    const mType = data.maintenance
      ? String(data.maintenance.type ?? 'CORRECTIVE').toUpperCase()
      : null;
    if (mType && !(MAINTENANCE_TYPES as readonly string[]).includes(mType)) {
      throw new BadRequestException(`Unknown maintenance type "${data.maintenance?.type}"`);
    }
    if (data.maintenance && !asset) {
      throw new BadRequestException('A service log needs the asset it was done on');
    }

    // Codes are allocated BEFORE the transaction: NumberingService opens its own
    // transaction, and nesting one inside another would hold two connections for
    // the same work.
    const pcCode = paidFrom === 'PETTY_CASH' && money > 0
      ? await this.numbering.next('PC')
      : null;
    const mrcCode = mType ? await this.numbering.next('MRC', date, 2) : null;

    const result = await this.prisma.$transaction(async (tx) => {
      const out: {
        pettyCash: any; assetCost: any; maintenance: any;
        stock: { itemId: string; itemCode: string; quantity: number; balanceAfter: number }[];
        purchases: { itemId: string; itemCode: string; quantity: number; balanceAfter: number }[];
      } = { pettyCash: null, assetCost: null, maintenance: null, stock: [], purchases: [] };

      // 1. the money itself
      if (pcCode) {
        out.pettyCash = await tx.pettyCashTransaction.create({
          data: {
            code: pcCode,
            date,
            type: 'EXPENSE',
            amount: money,
            payee: data.payee?.trim() || data.supplierId || undefined,
            accountId: data.accountId || undefined,
            description: data.description?.trim() || undefined,
            createdById: actor.userId,
          },
        });
      }

      // 2. attribute the money to the machine (never alongside a stock issue)
      if (asset && money > 0 && !stockLines.length && !purchaseLines.length) {
        out.assetCost = await tx.assetCost.create({
          data: {
            assetId: asset.id,
            date,
            kind: costKind,
            amount,
            accountId: data.accountId || undefined,
            supplierId: data.supplierId || undefined,
            description: data.description?.trim() || undefined,
            sourceType: out.pettyCash ? 'PETTY_CASH' : 'MANUAL',
            sourceId: out.pettyCash?.id ?? null,
            createdById: actor.userId,
          },
        });
      }

      // 3. the service log (cost 0 — the money above is the cost)
      if (asset && mrcCode) {
        out.maintenance = await tx.maintenanceRecord.create({
          data: {
            code: mrcCode,
            assetId: asset.id,
            type: mType as string,
            status: 'COMPLETED',
            date,
            problem: data.maintenance?.problem?.trim() || undefined,
            workDone: data.maintenance?.workDone?.trim() || data.description?.trim() || undefined,
            vendorId: data.supplierId || undefined,
            costParts: 0,
            costLabor: 0,
            costOther: 0,
            nextDueDate: data.maintenance?.nextDueDate ? new Date(data.maintenance.nextDueDate) : undefined,
            createdById: actor.userId,
          },
        });
      }

      // 4. stock handed to the machine
      for (const line of stockLines) {
        const rows = await tx.$queryRaw<Array<{ id: string; balance: number; code: string; name: string; unit: string; lastUnitPrice: unknown }>>`
          SELECT id, balance, code, name, unit, "lastUnitPrice" FROM inventory_items WHERE id = ${line.itemId}::uuid FOR UPDATE`;
        const item = rows[0];
        if (!item) throw new NotFoundException('Item not found');
        const newBalance = item.balance - line.quantity;
        if (newBalance < 0) {
          throw new ConflictException(`Insufficient stock for ${item.name} — balance ${item.balance}, requested ${line.quantity}`);
        }
        await tx.inventoryItem.update({ where: { id: item.id }, data: { balance: newBalance } });
        const stockTx = await tx.stockTransaction.create({
          data: {
            itemId: item.id,
            type: 'ISSUE',
            quantity: -line.quantity,
            balanceAfter: newBalance,
            reference: `Spend entry${out.pettyCash ? ` ${pcCode}` : ''} — ${asset?.assetCode ?? ''}`.trim(),
            assetId: asset?.id,
            purpose: mrcCode ? 'MAINTENANCE' : 'ASSET_USE',
            createdById: actor.userId,
          },
        });
        const unitPrice = item.lastUnitPrice != null ? Number(item.lastUnitPrice) : 0;
        if (unitPrice > 0) {
          await tx.assetCost.create({
            data: {
              assetId: asset?.id as string,
              date,
              kind: 'CONSUMABLE',
              amount: round2(unitPrice * line.quantity),
              quantity: line.quantity,
              supplierId: data.supplierId || undefined,
              description: `${item.name} × ${line.quantity} ${item.unit} — ${item.code}`,
              sourceType: 'STOCK_ISSUE',
              sourceId: stockTx.id,
              createdById: actor.userId,
            },
          });
        }
        out.stock.push({ itemId: item.id, itemCode: item.code, quantity: line.quantity, balanceAfter: newBalance });
      }

      // 5. stock bought into the store, against the same account
      for (const line of purchaseLines) {
        const rows = await tx.$queryRaw<Array<{ id: string; balance: number; code: string; name: string }>>`
          SELECT id, balance, code, name FROM inventory_items WHERE id = ${line.itemId}::uuid FOR UPDATE`;
        const item = rows[0];
        if (!item) throw new NotFoundException('Item not found');
        const unitPrice = round2(Number(line.unitPrice ?? 0));
        const newBalance = item.balance + line.quantity;
        await tx.inventoryItem.update({
          where: { id: item.id },
          data: { balance: newBalance, ...(unitPrice > 0 ? { lastUnitPrice: unitPrice } : {}) },
        });
        await tx.stockTransaction.create({
          data: {
            itemId: item.id,
            type: 'PURCHASE',
            quantity: line.quantity,
            balanceAfter: newBalance,
            reference: `Purchase${out.pettyCash ? ` ${pcCode}` : ''} — ${data.description?.trim() || item.name}`,
            ...(unitPrice > 0 ? { unitPrice } : {}),
            ...(data.supplierId ? { supplierId: data.supplierId } : {}),
            ...(data.accountId ? { accountId: data.accountId } : {}),
            ...(out.pettyCash ? { pettyCashId: out.pettyCash.id } : {}),
            purpose: 'PURCHASE',
            createdById: actor.userId,
          },
        });
        out.purchases.push({ itemId: item.id, itemCode: item.code, quantity: line.quantity, balanceAfter: newBalance });
      }

      return out;
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SPEND_ENTRY_CREATED', module: 'ADMINISTRATION', recordId: result.pettyCash?.id ?? asset?.id ?? 'n/a',
      newValue: {
        amount: money, paidFrom, pettyCashCode: pcCode, assetCode: asset?.assetCode ?? null,
        costKind: amount > 0 && !stockLines.length ? costKind : null,
        maintenanceCode: mrcCode, stock: result.stock, purchases: result.purchases,
        description: data.description ?? null,
      },
    });

    return {
      pettyCash: result.pettyCash,
      assetCost: result.assetCost,
      maintenance: result.maintenance,
      stock: result.stock,
      purchases: result.purchases,
      total: money,
    };
  }
}
