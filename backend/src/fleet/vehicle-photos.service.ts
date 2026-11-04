import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../org/org.service';
import { sniffImageType } from '../util/image-sniff';
import { stripPhotoMetadata } from '../assets/photo-metadata';

/** The three picture sections a vehicle carries. */
export const VEHICLE_PHOTO_KINDS = ['PHOTO', 'REGISTRATION', 'DOCUMENT'] as const;
export type VehiclePhotoKind = (typeof VEHICLE_PHOTO_KINDS)[number];

export const VEHICLE_PHOTO_LABELS: Record<VehiclePhotoKind, string> = {
  PHOTO: 'Vehicle photo',
  REGISTRATION: 'Registration photo',
  DOCUMENT: 'Document photo',
};

/** Pictures kept per section — the gallery holds up to this many of each. */
export const VEHICLE_PHOTO_MAX_PER_KIND = 10;

/**
 * Vehicle pictures: 5 MB, JPEG/PNG/WebP only. SVG is deliberately excluded —
 * it can carry script and this file is rendered inline in the app.
 */
const MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_DIR = 'vehicle-photos';
/** Only the uuid + extension this service itself writes may ever be opened, so
 *  a tampered row can never point outside the photo directory. */
const STORED_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Vehicle photo gallery (VMS §6) — the car itself, its registration
 * certificate and other documents, up to ten pictures in each section. Files
 * are written to UPLOAD_PATH/vehicle-photos with mode 0600 and are only ever
 * served through the permission-guarded
 * GET /fleet/vehicles/:id/photos/:photoId route. The stored file name never
 * leaves the server; clients only see the photo id, mime type, size and the
 * update timestamp.
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

  /** Every picture of the vehicle, oldest first inside each section. */
  async list(vehicleId: string) {
    await this.assertVehicle(vehicleId);
    return this.prisma.vehiclePhoto.findMany({
      where: { vehicleId },
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, kind: true, mimeType: true, size: true, updatedAt: true },
    });
  }

  /**
   * Add one picture to a section. Everything is checked BEFORE a byte is
   * written: the section cap, size, then the real file signature (never the
   * client's Content-Type). The file is renamed to a random uuid with an
   * extension derived from those bytes.
   */
  async upload(vehicleId: string, kindParam: string, file: Express.Multer.File | undefined, actor: Actor) {
    const kind = this.parseKind(kindParam);
    const vehicle = await this.assertVehicle(vehicleId);
    const existing = await this.prisma.vehiclePhoto.count({ where: { vehicleId, kind } });
    if (existing >= VEHICLE_PHOTO_MAX_PER_KIND) {
      throw new BadRequestException(
        `${VEHICLE_PHOTO_LABELS[kind]}: up to ${VEHICLE_PHOTO_MAX_PER_KIND} pictures — remove one before adding another`,
      );
    }
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

    let saved: { id: string; kind: string; mimeType: string; size: number; updatedAt: Date };
    try {
      saved = await this.prisma.vehiclePhoto.create({
        data: {
          vehicleId,
          kind,
          storedName,
          mimeType: type.mime,
          size: stored.length,
          sortOrder: existing,
          updatedById: actor.userId,
        },
        select: { id: true, kind: true, mimeType: true, size: true, updatedAt: true },
      });
    } catch (e) {
      this.unlink(storedName); // never leave an orphan when the row failed
      throw e;
    }

    await this.audit.log({
      userId: actor.userId,
      username: actor.username,
      action: 'VEHICLE_PHOTO_ADDED',
      module: 'FLEET',
      recordId: saved.id,
      newValue: { vehicleNo: vehicle.vehicleNo, kind, mimeType: type.mime, size: stored.length },
    });
    return saved;
  }

  /** Everything the guarded route needs; 404 whenever there is nothing to show. */
  async file(vehicleId: string, photoId: string) {
    if (!UUID.test(photoId)) throw new NotFoundException('Photo not found');
    const row = await this.prisma.vehiclePhoto.findFirst({
      where: { id: photoId, vehicleId },
      include: { vehicle: { select: { vehicleNo: true } } },
    });
    if (!row) throw new NotFoundException('Photo not found');
    const filePath = this.pathFor(row.storedName);
    if (!fs.existsSync(filePath)) throw new NotFoundException('Photo not found');
    return { row, filePath };
  }

  async remove(vehicleId: string, photoId: string, actor: Actor) {
    if (!UUID.test(photoId)) throw new NotFoundException('Photo not found');
    const vehicle = await this.assertVehicle(vehicleId);
    const row = await this.prisma.vehiclePhoto.findFirst({
      where: { id: photoId, vehicleId },
      select: { id: true, kind: true, storedName: true },
    });
    if (!row) throw new NotFoundException('Photo not found');
    await this.prisma.vehiclePhoto.delete({ where: { id: row.id } });
    this.unlink(row.storedName);
    await this.audit.log({
      userId: actor.userId,
      username: actor.username,
      action: 'VEHICLE_PHOTO_REMOVED',
      module: 'FLEET',
      recordId: row.id,
      oldValue: { vehicleNo: vehicle.vehicleNo, kind: row.kind },
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
