import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../org/org.service';

/**
 * Supplier master — organization-level vendor data.
 * Used today by Inventory purchases (restock source); future modules
 * (Purchasing/PO, supplier bills, fleet maintenance vendors) share this master.
 */
@Injectable()
export class SuppliersService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  list(includeInactive = false) {
    return this.prisma.supplier.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async create(data: { name: string; phone?: string; address?: string; note?: string }, actor: Actor) {
    const name = data.name.trim();
    if (!name) throw new BadRequestException('Supplier name is required');
    const exists = await this.prisma.supplier.findUnique({ where: { name } });
    if (exists) throw new ConflictException(`Supplier "${name}" already exists`);
    const supplier = await this.prisma.supplier.create({
      data: { name, phone: data.phone, address: data.address, note: data.note },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLIER_CREATED', module: 'SUPPLIERS', recordId: supplier.id,
      newValue: { name },
    });
    return supplier;
  }

  async update(id: string, data: { name?: string; phone?: string; address?: string; note?: string; isActive?: boolean }, actor: Actor) {
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
      action: 'SUPPLIER_UPDATED', module: 'SUPPLIERS', recordId: id,
      oldValue: { name: supplier.name, phone: supplier.phone, isActive: supplier.isActive },
      newValue: data,
    });
    return updated;
  }

  /** Purchase history summary for one supplier (per-item lifetime totals). */
  async purchaseHistory(id: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    const txs = await this.prisma.stockTransaction.findMany({
      where: { supplierId: id, type: 'PURCHASE' },
      include: { item: { select: { name: true, unit: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const perItem = new Map<string, { name: string; unit: string; qty: number; cost: number }>();
    for (const t of txs) {
      const cur = perItem.get(t.itemId) ?? { name: t.item.name, unit: t.item.unit, qty: 0, cost: 0 };
      cur.qty += t.quantity;
      cur.cost += t.unitPrice ? Number(t.unitPrice) * t.quantity : 0;
      perItem.set(t.itemId, cur);
    }
    return {
      supplier: { id: supplier.id, name: supplier.name },
      totalCost: [...perItem.values()].reduce((s, x) => s + x.cost, 0),
      items: [...perItem.values()].sort((a, b) => b.cost - a.cost),
      recent: txs.slice(0, 50),
    };
  }

  async remove(id: string, actor: Actor) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    const txCount = await this.prisma.stockTransaction.count({ where: { supplierId: id } });
    if (txCount > 0) {
      throw new ConflictException(`Supplier has ${txCount} purchase record(s) — deactivate it instead`);
    }
    await this.prisma.supplier.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLIER_DELETED', module: 'SUPPLIERS', recordId: id,
      oldValue: { name: supplier.name },
      severity: 'WARNING',
    });
    return { success: true };
  }
}
