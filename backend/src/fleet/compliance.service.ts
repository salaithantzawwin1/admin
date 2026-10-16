import { Injectable } from '@nestjs/common';
import { VehicleType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { expiryStatus, daysUntilExpiry, ymd as ymdShort } from './expiry';

/**
 * VMS Phase B (Vehicle spec §6.5 + §7.3/§8.2-step-6) — document compliance rules.
 *
 * Leaf service (no module imports — PrismaService is @Global) so BOTH the fleet
 * module (list/detail chips) and the cars module (assign/reassign/dispatch
 * block) can depend on it without creating an import cycle.
 *
 * Rules, per spec:
 *  - §6.5: every ACTIVE document type flagged `mandatoryForDispatch` must have a
 *    current (non-superseded) record for the vehicle with a usable expiry date.
 *    A missing record, a dateless record on a type that requires dates, or an
 *    EXPIRED record blocks assignment/dispatch. DUE_TODAY does NOT block (the
 *    spec blocks on "expired or missing" — today is not yet expired).
 *  - §6.5 type scope: a type applies when vehicleType is NULL (all vehicles) or
 *    matches the vehicle — anything else is NOT_APPLICABLE, never a violation.
 *  - §7.3/§8.2 step 6: the assigned driver's licence is checked only when the
 *    data is maintained (an expiry date exists). A blank licence is a data gap,
 *    not a violation — the spec validates licence validity "where available".
 *
 * mandatoryForDispatch seeds FALSE (migration 53): nothing blocks until
 * Administration opts a type in (gap analysis decision #2).
 */
export interface ComplianceViolation {
  vehicleId: string;
  vehicleNo: string;
  kind: 'DOCUMENT' | 'DRIVER_LICENSE';
  docTypeId?: string;
  /** display name of the document type / driver */
  docType?: string;
  /** MISSING = no record · NO_EXPIRY_DATE = record without the required date · EXPIRED = past today */
  reason: 'MISSING' | 'NO_EXPIRY_DATE' | 'EXPIRED';
  /** human message used by the assign/dispatch error and the UI chips */
  detail: string;
  /** whole business-local days until expiry (negative = overdue) */
  daysLeft?: number;
}

type VehicleRow = { id: string; vehicleNo: string; vehicleType: string; driverId?: string | null };

@Injectable()
export class FleetComplianceService {
  constructor(private prisma: PrismaService) {}

  /** Active mandatory document types applicable to a vehicle type. */
  private mandatoryTypes(vehicleType: string) {
    return this.prisma.vehicleDocumentType.findMany({
      where: {
        active: true,
        mandatoryForDispatch: true,
        OR: [{ vehicleType: null }, { vehicleType: vehicleType as never }],
      },
      orderBy: { sortOrder: 'asc' },
    });
  }

  /** Violations for one vehicle. `opts.driverId` overrides the vehicle's default
   *  driver (pass null for a driver-less assignment — no licence check then). */
  async violationsFor(
    vehicle: VehicleRow,
    opts: { driverId?: string | null; now?: Date } = {},
  ): Promise<ComplianceViolation[]> {
    const now = opts.now ?? new Date();
    const types = await this.mandatoryTypes(vehicle.vehicleType);
    const docs = types.length
      ? await this.prisma.vehicleDocument.findMany({
          where: { vehicleId: vehicle.id, supersededById: null, documentTypeId: { in: types.map((t) => t.id) } },
          include: { documentType: true },
        })
      : [];
    const violations = docViolations(vehicle, types, docs, now);

    const driverId = 'driverId' in opts ? opts.driverId : vehicle.driverId;
    if (driverId) {
      const driver = await this.prisma.driver.findUnique({
        where: { id: driverId },
        select: { id: true, name: true, licenseExpiry: true },
      });
      if (driver?.licenseExpiry && expiryStatus(driver.licenseExpiry, now) === 'EXPIRED') {
        violations.push({
          vehicleId: vehicle.id,
          vehicleNo: vehicle.vehicleNo,
          kind: 'DRIVER_LICENSE',
          docType: driver.name,
          reason: 'EXPIRED',
          detail: `Driver ${driver.name}: licence expired ${ymdShort(driver.licenseExpiry)}`,
          daysLeft: daysUntilExpiry(driver.licenseExpiry, now),
        });
      }
    }
    return violations;
  }

  /** Violations for a vehicle id (404s through prisma when it does not exist). */
  async violationsForVehicle(vehicleId: string, opts: { driverId?: string | null; now?: Date } = {}) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, vehicleNo: true, vehicleType: true, driverId: true },
    });
    if (!vehicle) return null;
    return this.violationsFor(vehicle, opts);
  }

  /** Bulk compliance map for the fleet table chip — one query per relation. */
  async blockedMap(vehicles: VehicleRow[], now: Date = new Date()): Promise<Map<string, ComplianceViolation[]>> {
    const map = new Map<string, ComplianceViolation[]>();
    if (vehicles.length === 0) return map;

    const types = await this.prisma.vehicleDocumentType.findMany({
      where: { active: true, mandatoryForDispatch: true },
      orderBy: { sortOrder: 'asc' },
    });
    const applicable = types.filter(
      (t) => t.vehicleType === null || vehicles.some((v) => v.vehicleType === (t.vehicleType as string)),
    );
    const docs = applicable.length
      ? await this.prisma.vehicleDocument.findMany({
          where: { vehicleId: { in: vehicles.map((v) => v.id) }, supersededById: null, documentTypeId: { in: applicable.map((t) => t.id) } },
          include: { documentType: true },
        })
      : [];
    const docsByVehicle = new Map<string, typeof docs>();
    for (const d of docs) docsByVehicle.set(d.vehicleId, [...(docsByVehicle.get(d.vehicleId) ?? []), d]);

    for (const v of vehicles) {
      const forVehicle = applicable.filter((t) => t.vehicleType === null || t.vehicleType === (v.vehicleType as VehicleType));
      const violations = docViolations(v, forVehicle, docsByVehicle.get(v.id) ?? [], now);
      if (violations.length) map.set(v.id, violations);
    }

    // §7.3 driver eligibility — one query for every expired licence in the list
    const driverIds = [...new Set(vehicles.map((v) => v.driverId).filter((d): d is string => !!d))];
    if (driverIds.length) {
      const expired = await this.prisma.driver.findMany({
        where: { id: { in: driverIds }, licenseExpiry: { not: null } },
        select: { id: true, name: true, licenseExpiry: true },
      });
      const expiredByName = new Map(
        expired.filter((d) => expiryStatus(d.licenseExpiry, now) === 'EXPIRED').map((d) => [d.id, d]),
      );
      for (const v of vehicles) {
        const d = v.driverId ? expiredByName.get(v.driverId) : undefined;
        if (d) {
          const list = map.get(v.id) ?? [];
          list.push({
            vehicleId: v.id,
            vehicleNo: v.vehicleNo,
            kind: 'DRIVER_LICENSE',
            docType: d.name,
            reason: 'EXPIRED',
            detail: `Driver ${d.name}: licence expired ${ymdShort(d.licenseExpiry as Date)}`,
            daysLeft: daysUntilExpiry(d.licenseExpiry as Date, now),
          });
          map.set(v.id, list);
        }
      }
    }
    return map;
  }
}

/** Document rules shared by the single-vehicle and bulk paths. */
function docViolations(
  vehicle: VehicleRow,
  types: { id: string; name: string; allowNoExpiry: boolean }[],
  docs: { documentTypeId: string; expiryDate: Date | null; documentType: { name: string } }[],
  now: Date,
): ComplianceViolation[] {
  const out: ComplianceViolation[] = [];
  const current = new Map(docs.map((d) => [d.documentTypeId, d]));
  for (const t of types) {
    const doc = current.get(t.id);
    if (!doc) {
      out.push({
        vehicleId: vehicle.id,
        vehicleNo: vehicle.vehicleNo,
        kind: 'DOCUMENT',
        docTypeId: t.id,
        docType: t.name,
        reason: 'MISSING',
        detail: `${t.name}: mandatory document missing`,
      });
      continue;
    }
    if (!doc.expiryDate) {
      if (t.allowNoExpiry) continue; // the type explicitly allows a dateless record
      out.push({
        vehicleId: vehicle.id,
        vehicleNo: vehicle.vehicleNo,
        kind: 'DOCUMENT',
        docTypeId: t.id,
        docType: t.name,
        reason: 'NO_EXPIRY_DATE',
        detail: `${t.name}: no expiry date on a type that requires one`,
      });
      continue;
    }
    if (expiryStatus(doc.expiryDate, now) === 'EXPIRED') {
      out.push({
        vehicleId: vehicle.id,
        vehicleNo: vehicle.vehicleNo,
        kind: 'DOCUMENT',
        docTypeId: t.id,
        docType: t.name,
        reason: 'EXPIRED',
        detail: `${t.name}: expired ${ymdShort(doc.expiryDate)} (${Math.abs(daysUntilExpiry(doc.expiryDate, now))} day(s) ago)`,
        daysLeft: daysUntilExpiry(doc.expiryDate, now),
      });
    }
  }
  return out;
}
