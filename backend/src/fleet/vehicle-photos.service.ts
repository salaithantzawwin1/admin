import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../org/org.service';
import { sniffImageType } from '../util/image-sniff';
import { stripPhotoMetadata } from '../assets/photo-metadata';

/** The three pictures a vehicle carries. */
export const VEHICLE_PHOTO_KINDS = ['PHOTO', 'REGISTRATION', 'DOCUMENT'] as const;
export type VehiclePhotoKind = (typeof VEHICLE_PHOTO_KINDS)[number];

export const VEHICLE_PHOTO_LABELS: Record<VehiclePhotoKind, string> = {
  PHOTO: 'Vehicle photo',
  REGISTRATION: 'Registration photo',
  DOCUMENT: 'Document photo',
};

/**
 * Vehicle pictures: 5 MB, JPEG/PNG/WebP only. SVG is deliberately excluded —
 * it can carry script and this file is rendered inline in the app.
 */
const MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_DIR = 'vehicle-photos';
/** Only the uuid + extension this service itself writes may ever be opened, so
 *  a tampered row can never point outside the photo directory. */
const STORED_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

/**
 * Vehicle photographs (VMS §6) — the car itself, its registration certificate
 * and one other document picture. Files are written to UPLOAD_PATH/vehicle-photos
 * with mode 0600 and are only ever served through the permission-guarded
 * GET /fleet/vehicles/:id/photos/:kind route. The stored file name never leaves
 * the server; clients only see mime type, size and the update timestamp.
 */
@Injectable()
export class VehiclePhotosService {
  private uploadRoot = process.env.UPLOAD_PATH || '/app/uploads';

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /** The directory exists after the first upload; 0750 keeps it server-only. */
  private dir(): string {
    const dir = path.join(this.uploadRoot, PHOTO_DIR);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    return dir;
  }

  private pathFor(storedName: string): string {
    if (!STORED_NAME.test(storedName)) throw new NotFoundException('No photo');
    return path.join(this.uploadRoot, PHOTO_DIR, storedName);
  }

  /** Best effort: a missing/orphaned file must never block the DB update. */
  private unlink(storedName?: string | null) {
    if (!storedName) return;
    try {
      const file = this.pathFor(storedName);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore — the row is the source of truth */
    }
  }

  /** Unknown :kind is a 400 before any lookup happens. */
  private parseKind(value: string): VehiclePhotoKind {
    const kind = VEHICLE_PHOTO_KINDS.find((k) => k === value);
    if (!kind) throw new BadRequestException(`Unknown photo kind (${VEHICLE_PHOTO_KINDS.join(' | ')})`);
    return kind;
  }

  private async assertVehicle(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, vehicleNo: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle;
  }

  /** Metadata for all three slots (absent kinds are simply not in the array). */
  async list(vehicleId: string) {
    await this.assertVehicle(vehicleId);
    const rows = await this.prisma.vehiclePhoto.findMany({
      where: { vehicleId },
      orderBy: { kind: 'asc' },
      select: { kind: true, mimeType: true, size: true, updatedAt: true },
    });
    return rows;
  }

  /**
   * Upload or replace one slot. Everything is checked BEFORE a byte is written:
   * size, then the real file signature (never the client's Content-Type). The
   * file is renamed to a random uuid with an extension derived from those bytes.
   */
  async upload(vehicleId: string, kindParam: string, file: Express.Multer.File | undefined, actor: Actor) {
    const kind = this.parseKind(kindParam);
    const vehicle = await this.assertVehicle(vehicleId);
    if (!file?.buffer?.length) throw new BadRequestException('No file provided');
    if (file.size > MAX_BYTES) throw new BadRequestException('Photo too large (max 5 MB)');
    if (file.size !== file.buffer.length) throw new BadRequestException('Upload was truncated — please try again');
    const type = sniffImageType(file.buffer);
    if (!type) throw new BadRequestException('Only JPEG, PNG or WebP images are allowed');

    const dir = this.dir();
    const storedName = `${crypto.randomUUID()}.${type.ext}`;
    // EXIF/GPS never reaches the volume: a picture of a car should not say
    // where and when it was taken.
    const stored = stripPhotoMetadata(file.buffer, type.mime);
    fs.writeFileSync(path.join(dir, storedName), stored, { mode: 0o600 });

    let previous: string | null = null;
    let saved: { mimeType: string; size: number; updatedAt: Date };
    try {
      const existing = await this.prisma.vehiclePhoto.findUnique({
        where: { vehicleId_kind: { vehicleId, kind } },
        select: { storedName: true },
      });
      previous = existing?.storedName ?? null;
      saved = await this.prisma.vehiclePhoto.upsert({
        where: { vehicleId_kind: { vehicleId, kind } },
        create: { vehicleId, kind, storedName, mimeType: type.mime, size: stored.length, updatedById: actor.userId },
        update: { storedName, mimeType: type.mime, size: stored.length, updatedById: actor.userId },
        select: { mimeType: true, size: true, updatedAt: true },
      });
    } catch (e) {
      this.unlink(storedName); // never leave an orphan when the row failed
      throw e;
    }
    this.unlink(previous); // the replaced picture is gone for good

    await this.audit.log({
      userId: actor.userId,
      username: actor.username,
      action: previous ? 'VEHICLE_PHOTO_REPLACED' : 'VEHICLE_PHOTO_ADDED',
      module: 'FLEET',
      recordId: vehicleId,
      newValue: { vehicleNo: vehicle.vehicleNo, kind, mimeType: type.mime, size: stored.length },
    });
    return { kind, photo: saved };
  }

  /** Everything the guarded route needs; 404 whenever there is nothing to show. */
  async file(vehicleId: string, kindParam: string) {
    const kind = this.parseKind(kindParam);
    const row = await this.prisma.vehiclePhoto.findUnique({
      where: { vehicleId_kind: { vehicleId, kind } },
      include: { vehicle: { select: { vehicleNo: true } } },
    });
    if (!row) throw new NotFoundException(`${VEHICLE_PHOTO_LABELS[kind]} not uploaded`);
    const filePath = this.pathFor(row.storedName);
    if (!fs.existsSync(filePath)) throw new NotFoundException(`${VEHICLE_PHOTO_LABELS[kind]} not uploaded`);
    return { row, filePath };
  }

  async remove(vehicleId: string, kindParam: string, actor: Actor) {
    const kind = this.parseKind(kindParam);
    const vehicle = await this.assertVehicle(vehicleId);
    const row = await this.prisma.vehiclePhoto.findUnique({
      where: { vehicleId_kind: { vehicleId, kind } },
      select: { storedName: true },
    });
    if (!row) throw new NotFoundException(`${VEHICLE_PHOTO_LABELS[kind]} not uploaded`);
    await this.prisma.vehiclePhoto.delete({ where: { vehicleId_kind: { vehicleId, kind } } });
    this.unlink(row.storedName);
    await this.audit.log({
      userId: actor.userId,
      username: actor.username,
      action: 'VEHICLE_PHOTO_REMOVED',
      module: 'FLEET',
      recordId: vehicleId,
      oldValue: { vehicleNo: vehicle.vehicleNo, kind },
      severity: 'WARNING',
    });
    return { ok: true };
  }

  /** Vehicle deletion cascades the rows; the files are removed afterwards. */
  async purge(vehicleId: string) {
    const rows = await this.prisma.vehiclePhoto
      .findMany({ where: { vehicleId }, select: { storedName: true } })
      .catch(() => [] as { storedName: string }[]);
    for (const row of rows) this.unlink(row.storedName);
  }
}
