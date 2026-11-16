import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from '../auth/permissions.service';
import { PERMISSIONS } from '../auth/permissions';
import { Actor } from '../org/org.service';
import { sniffImageType } from '../util/image-sniff';
import { stripPhotoMetadata } from '../assets/photo-metadata';

/** Scans kept per license — mirrors the "up to 5" promise in the UI. */
export const LICENSE_IMAGE_MAX = 5;

const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_DIR = 'license-images';
/** Only the uuid + extension this service writes may ever be opened. */
const STORED_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LicenseInput {
  name?: string;
  registrationNo?: string | null;
  companyLimited?: string | null;
  myanmarName?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  email?: string | null;
  emailPassword?: string | null;
  tradenetPassword?: string | null;
  status?: string;
  note?: string | null;
}

@Injectable()
export class LicensesService {
  private uploadRoot = process.env.UPLOAD_PATH || '/app/uploads';

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private permissions: PermissionsService,
  ) {}

  // ---------------- helpers ----------------

  /** Trimmed text, or null for a blank value (which clears the column). */
  private clean(value?: string | null): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  /** Date-only input (YYYY-MM-DD) or an ISO timestamp; blank clears the date. */
  private parseDate(value: string | null | undefined, label: string): Date | null {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label} must be a date`);
    return date;
  }

  /** Shared column mapping: an omitted key stays untouched on update and falls
   *  back to the column default on create. */
  private fields(input: LicenseInput) {
    const text = (value?: string | null) => (value === undefined ? undefined : this.clean(value));
    const date = (value: string | null | undefined, label: string) =>
      value === undefined ? undefined : this.parseDate(value, label);
    return {
      name: text(input.name),
      registrationNo: text(input.registrationNo),
      companyLimited: text(input.companyLimited),
      myanmarName: text(input.myanmarName),
      startDate: date(input.startDate, 'Start date'),
      dueDate: date(input.dueDate, 'Due date'),
      email: text(input.email),
      emailPassword: text(input.emailPassword),
      tradenetPassword: text(input.tradenetPassword),
      status: text(input.status) ?? undefined,
      note: text(input.note),
    };
  }

  /** The portal logins never leave the API for someone who cannot edit them. */
  private stripSecrets<T extends { emailPassword: string | null; tradenetPassword: string | null }>(row: T) {
    const rest: Record<string, unknown> = { ...row };
    delete rest.emailPassword;
    delete rest.tradenetPassword;
    return rest;
  }

  private dir(): string {
    const dir = path.join(this.uploadRoot, IMAGE_DIR);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    return dir;
  }

  private pathFor(storedName: string): string {
    if (!STORED_NAME.test(storedName)) throw new NotFoundException('No picture');
    return path.join(this.uploadRoot, IMAGE_DIR, storedName);
  }

  /** Best effort: an orphaned file must never block a DB change. */
  private unlink(storedName?: string | null) {
    if (!storedName) return;
    try {
      const file = this.pathFor(storedName);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore — the row is the source of truth */
    }
  }

  private async row(id: string) {
    if (!UUID.test(id)) throw new NotFoundException('License not found');
    const license = await this.prisma.importExportLicense.findUnique({ where: { id } });
    if (!license) throw new NotFoundException('License not found');
    return license;
  }

  // ---------------- register ----------------

  /** Register list — next renewal first; the stored logins stay out of it. */
  async list(q: string | undefined) {
    const term = q?.trim();
    const rows = await this.prisma.importExportLicense.findMany({
      where: term
        ? {
            OR: [
              { name: { contains: term, mode: 'insensitive' } },
              { companyLimited: { contains: term, mode: 'insensitive' } },
              { myanmarName: { contains: term, mode: 'insensitive' } },
              { registrationNo: { contains: term, mode: 'insensitive' } },
              { email: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {},
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      include: { _count: { select: { images: true } } },
    });
    return rows.map((row) => this.stripSecrets(row));
  }

  /** One licence — with its portal logins when the caller may edit the register. */
  async detail(id: string, userId: string) {
    const license = await this.row(id);
    const manager = await this.permissions.userHas(userId, PERMISSIONS.LICENSES_MANAGE);
    return manager ? license : this.stripSecrets(license);
  }

  async create(input: LicenseInput, actor: Actor) {
    const name = this.clean(input.name);
    if (!name) throw new BadRequestException('Company name is required');
    const license = await this.prisma.importExportLicense.create({
      data: { ...this.fields(input), name, createdById: actor.userId },
    });
    await this.audit.log({
      userId: actor.userId,
      username: actor.username,
      action: 'LICENSE_CREATED',
      module: 'LICENSES',
      recordId: license.id,
      newValue: { name: license.name, registrationNo: license.registrationNo, dueDate: license.dueDate },
    });
    return license;
  }

  async update(id: string, input: LicenseInput, actor: Actor) {
    const before = await this.row(id);
    if (input.name !== undefined && !this.clean(input.name)) {
      throw new BadRequestException('Company name is required');
    }
    const updated = await this.prisma.importExportLicense.update({
      where: { id },
      // the name is validated above, so an update never blanks it
      data: { ...this.fields(input), name: input.name === undefined ? undefined : this.clean(input.name)! },
    });
    // Which columns changed — never the password values themselves.
    const changed = (Object.keys(input) as (keyof LicenseInput)[]).filter(
      (key) => input[key] !== undefined && String(before[key] ?? '') !== String(input[key] ?? ''),
    );
    await this.audit.log({
      userId: actor.userId,
      username: actor.username,
      action: 'LICENSE_UPDATED',
      module: 'LICENSES',
      recordId: id,
      oldValue: { name: before.name, registrationNo: before.registrationNo, dueDate: before.dueDate },
      newValue: { name: updated.name, registrationNo: updated.registrationNo, dueDate: updated.dueDate, changed },
    });
    return updated;
  }

  /** Removing a licence also takes its scans off the volume. */
  async remove(id: string, actor: Actor) {
    const license = await this.row(id);
    const images = await this.prisma.licenseImage.findMany({ where: { licenseId: id }, select: { storedName: true } });
    await this.prisma.importExportLicense.delete({ where: { id } });
    for (const image of images) this.unlink(image.storedName);
    await this.audit.log({
      userId: actor.userId,
      username: actor.username,
      action: 'LICENSE_DELETED',
      module: 'LICENSES',
      recordId: id,
      oldValue: { name: license.name, registrationNo: license.registrationNo, images: images.length },
      severity: 'WARNING',
    });
    return { ok: true };
  }

  // ---------------- pictures (max 5) ----------------

  async listImages(licenseId: string) {
    await this.row(licenseId);
    return this.prisma.licenseImage.findMany({
      where: { licenseId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, mimeType: true, size: true, createdAt: true },
    });
  }

  async uploadImage(licenseId: string, file: Express.Multer.File | undefined, actor: Actor) {
    const license = await this.row(licenseId);
    const existing = await this.prisma.licenseImage.count({ where: { licenseId } });
    if (existing >= LICENSE_IMAGE_MAX) {
      throw new BadRequestException(`Up to ${LICENSE_IMAGE_MAX} pictures per license — remove one before adding another`);
    }
    if (!file?.buffer?.length) throw new BadRequestException('No file provided');
    if (file.size > MAX_BYTES) throw new BadRequestException('Picture too large (max 5 MB)');
    if (file.size !== file.buffer.length) throw new BadRequestException('Upload was truncated — please try again');
    const type = sniffImageType(file.buffer);
    if (!type) throw new BadRequestException('Only JPEG, PNG or WebP images are allowed');

    const storedName = `${crypto.randomUUID()}.${type.ext}`;
    const stored = stripPhotoMetadata(file.buffer, type.mime);
    fs.writeFileSync(path.join(this.dir(), storedName), stored, { mode: 0o600 });

    let saved: { id: string; mimeType: string; size: number; createdAt: Date };
    try {
      saved = await this.prisma.licenseImage.create({
        data: { licenseId, storedName, mimeType: type.mime, size: stored.length, createdById: actor.userId },
        select: { id: true, mimeType: true, size: true, createdAt: true },
      });
    } catch (e) {
      this.unlink(storedName); // never leave an orphan when the row failed
      throw e;
    }

    await this.audit.log({
      userId: actor.userId,
      username: actor.username,
      action: 'LICENSE_IMAGE_ADDED',
      module: 'LICENSES',
      recordId: license.id,
      newValue: { license: license.name, mimeType: type.mime, size: stored.length },
    });
    return saved;
  }

  async imageFile(licenseId: string, imageId: string) {
    if (!UUID.test(imageId)) throw new NotFoundException('Picture not found');
    const row = await this.prisma.licenseImage.findFirst({
      where: { id: imageId, licenseId },
      include: { license: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('Picture not found');
    const filePath = this.pathFor(row.storedName);
    if (!fs.existsSync(filePath)) throw new NotFoundException('Picture not found');
    return { row, filePath };
  }

  async removeImage(licenseId: string, imageId: string, actor: Actor) {
    if (!UUID.test(imageId)) throw new NotFoundException('Picture not found');
    const license = await this.row(licenseId);
    const image = await this.prisma.licenseImage.findFirst({
      where: { id: imageId, licenseId },
      select: { id: true, storedName: true },
    });
    if (!image) throw new NotFoundException('Picture not found');
    await this.prisma.licenseImage.delete({ where: { id: image.id } });
    this.unlink(image.storedName);
    await this.audit.log({
      userId: actor.userId,
      username: actor.username,
      action: 'LICENSE_IMAGE_REMOVED',
      module: 'LICENSES',
      recordId: image.id,
      oldValue: { license: license.name },
      severity: 'WARNING',
    });
    return { ok: true };
  }
}
