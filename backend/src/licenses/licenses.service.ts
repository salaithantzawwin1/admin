import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from '../auth/permissions.service';
import { Actor } from '../org/org.service';
import { sniffImageType } from '../util/image-sniff';
import { stripPhotoMetadata } from '../assets/photo-metadata';

/** Company Import/Export licenses: one row per company licence plus the
 *  scanned certificate itself — at most five pictures per licence. */
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

/** A row as the browser sees it: secrets replaced by a "does it exist" flag. */
type PublicRow = Record<string, unknown> & {
  emailPassword?: string | null;
  tradenetPassword?: string | null;
};

@Injectable()
export class LicensesService {
  private uploadRoot = process.env.UPLOAD_PATH || '/app/uploads';

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private permissions: PermissionsService,
  ) {}

  // ---------------- helpers ----------------

  /** Date-only input (YYYY-MM-DD) or an ISO timestamp; null clears the field. */
  private parseDate(value: string | null | undefined, label: string): Date | null {
    if (value === null || value === undefined || value === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label} must be a date`);
    return date;
  }

  private text(value: string | null | undefined, max: number, label: string): string | null {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > max) throw new BadRequestException(`${label} is too long (max ${max} characters)`);
    return trimmed;
  }

  /** Never let a password leave the API for someone who cannot edit it. */
  private publicRow<T extends PublicRow>(row: T, includeSecrets: boolean): T | PublicRow {
    if (includeSecrets) return row;
    const rest: Record<string, unknown> = { ...row };
    const emailPassword = rest.emailPassword;
    const tradenetPassword = rest.tradenetPassword;
    delete rest.emailPassword;
    delete rest.tradenetPassword;
    return { ...rest, hasEmailPassword: !!emailPassword, hasTradenetPassword: !!tradenetPassword };
  }

  /** Managers get the stored logins; everyone else sees whether one exists. */
  private async includeSecrets(userId: string) {
    return this.permissions.userHas(userId, 'licenses.manage');
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

  /** Register list — newest expiry first, so the next renewal is at the top.
   *  The stored portal logins stay out of this payload entirely: a manager who
   *  opens one license gets them from the detail route, never 37 at a time. */
  async list(q: string | undefined) {
    const term = q?.trim();
    const where = term
      ? {
          OR: [
            { name: { contains: term, mode: 'insensitive' as const } },
            { companyLimited: { contains: term, mode: 'insensitive' as const } },
            { myanmarName: { contains: term, mode: 'insensitive' as const } },
            { registrationNo: { contains: term, mode: 'insensitive' as const } },
            { email: { contains: term, mode: 'insensitive' as const } },
          ],
        }
      : {};
    const rows = await this.prisma.importExportLicense.findMany({
      where,
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      include: { _count: { select: { images: true } } },
    });
    return rows.map((row) => this.publicRow(row, false));
  }

  async detail(id: string, userId: string) {
    const license = await this.row(id);
    return this.publicRow(license, await this.includeSecrets(userId));
  }

  async create(data: LicenseInput, actor: Actor) {
    const name = this.text(data.name, 160, 'Company name');
    if (!name) throw new BadRequestException('Company name is required');
    const license = await this.prisma.importExportLicense.create({
      data: {
        name,
        registrationNo: this.text(data.registrationNo, 60, 'Registration no.'),
        companyLimited: this.text(data.companyLimited, 200, 'Company Limited'),
        myanmarName: this.text(data.myanmarName, 200, 'Myanmar name'),
        startDate: this.parseDate(data.startDate, 'Start date'),
        dueDate: this.parseDate(data.dueDate, 'Due date'),
        email: this.text(data.email, 160, 'Email'),
        emailPassword: this.text(data.emailPassword, 160, 'E-mail password'),
        tradenetPassword: this.text(data.tradenetPassword, 160, 'TradeNet password'),
        status: this.text(data.status, 40, 'Status') ?? 'Updated',
        note: this.text(data.note, 500, 'Note'),
        createdById: actor.userId,
      },
    });
    await this.audit.log({
      userId: actor.userId,
      username: actor.username,
      action: 'LICENSE_CREATED',
      module: 'LICENSES',
      recordId: license.id,
      newValue: { name: license.name, registrationNo: license.registrationNo, dueDate: license.dueDate },
    });
    return this.publicRow(license, true);
  }

  async update(id: string, data: LicenseInput, actor: Actor) {
    const before = await this.row(id);
    if (data.name !== undefined && !this.text(data.name, 160, 'Company name')) {
      throw new BadRequestException('Company name is required');
    }
    const updated = await this.prisma.importExportLicense.update({
      where: { id },
      data: {
        name: data.name === undefined ? undefined : this.text(data.name, 160, 'Company name')!,
        registrationNo: data.registrationNo === undefined ? undefined : this.text(data.registrationNo, 60, 'Registration no.'),
        companyLimited: data.companyLimited === undefined ? undefined : this.text(data.companyLimited, 200, 'Company Limited'),
        myanmarName: data.myanmarName === undefined ? undefined : this.text(data.myanmarName, 200, 'Myanmar name'),
        startDate: data.startDate === undefined ? undefined : this.parseDate(data.startDate, 'Start date'),
        dueDate: data.dueDate === undefined ? undefined : this.parseDate(data.dueDate, 'Due date'),
        email: data.email === undefined ? undefined : this.text(data.email, 160, 'Email'),
        emailPassword: data.emailPassword === undefined ? undefined : this.text(data.emailPassword, 160, 'E-mail password'),
        tradenetPassword:
          data.tradenetPassword === undefined ? undefined : this.text(data.tradenetPassword, 160, 'TradeNet password'),
        status: data.status === undefined ? undefined : this.text(data.status, 40, 'Status') ?? 'Updated',
        note: data.note === undefined ? undefined : this.text(data.note, 500, 'Note'),
      },
    });
    // Which columns changed — never the password values themselves.
    const changed = (Object.keys(data) as (keyof LicenseInput)[]).filter(
      (key) => data[key] !== undefined && String(before[key] ?? '') !== String(data[key] ?? ''),
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
    return this.publicRow(updated, true);
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
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
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
        data: {
          licenseId,
          storedName,
          mimeType: type.mime,
          size: stored.length,
          sortOrder: existing,
          createdById: actor.userId,
        },
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
