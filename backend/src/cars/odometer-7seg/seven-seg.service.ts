import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../../audit/audit.service';
import { CarsService } from '../cars.service';
import { Box, Gray, crop, decodeImage, encodeGrayPng, expandBox } from './image';
import { findDigitRow, medianPrior, priorBox } from './lcd';
import { PATCH_H, PATCH_W, Segmented, digitBoxes, patchOf, segmentDigits } from './segment';
import { Match, classifyPatch, decodeTemplates, Template } from './classify';

/**
 * Offline seven-segment odometer reader (docs/ODOMETER_OCR_PLAN.md).
 *
 * Installable with no key and no internet, and — unlike a general OCR engine
 * (benchmarked and rejected: PP-OCR read confident nonsense on these dashboards)
 * — it is built for exactly one thing: six or seven bars-of-light digits on a
 * car LCD.
 *
 * It is still only evidence. `read()` answers null unless every digit is both
 * above the similarity floor and clearly ahead of the runner-up, so a doubtful
 * photo is a miss, not a wrong cross-check. The classifier is templates cut from
 * photos an administrator labelled, which is what the training endpoints add.
 */

const MAX_TEMPLATES = 3000;
const MAX_CALIBRATIONS = 60;
const MIN_DIGITS = 5;
const MAX_DIGITS = 7;

export interface SevenSegRead {
  km: number;
  confidence: 'high' | 'low';
  digits: string;
  minScore: number;
  /** the ODO row in photo coordinates */
  row: Box;
  /** the region the glyphs were cut from */
  roi: Box;
}

export interface AnalyzedDigit {
  index: number;
  box: Box;
  guess: string | null;
  score: number;
  patch: string;
}

export interface SevenSegAnalysis {
  assignmentId: string;
  stage: string;
  photoUrl: string;
  row: Box;
  label: Box | null;
  roi: Box;
  polarity: string;
  roiPreview: string;
  digits: AnalyzedDigit[];
  guessKm: number | null;
  templates: number;
}

export interface TrainingStats {
  perDigit: Record<string, number>;
  total: number;
  calibrations: number;
  /** enough labelled glyphs (every digit seen a few times) to trust a read */
  ready: boolean;
}

export interface TrainingPhoto {
  assignmentId: string;
  stage: string;
  vehicleNo: string | null;
  typedKm: number | null;
  at: string | null;
  photoUrl: string;
  labelled: boolean;
}

@Injectable()
export class OdometerSevenSegService {
  private readonly logger = new Logger(OdometerSevenSegService.name);

  constructor(private prisma: PrismaService, private audit: AuditService, private cars: CarsService) {}

  // ------------------------------------------------------------------
  // reading (the OCR provider = 'local' path)

  /**
   * Read the ODO digits. null = could not decode, no row found, the wrong number
   * of glyphs, no templates learned yet, or any digit short of confident.
   */
  async read(buffer: Buffer): Promise<SevenSegRead | null> {
    try {
      const image = decodeImage(buffer);
      if (!image) return null;
      const templates = await this.templates();
      // nothing labelled yet: there is no classifier, so there is nothing to say
      if (!templates.length) return null;

      const found = await this.inspect(image, 6);
      if (!found) return null;
      const count = found.segmented.digits.length;
      if (count < MIN_DIGITS || count > MAX_DIGITS) return null;

      const matches: Match[] = found.segmented.digits.map((d) => classifyPatch(d.patch, templates));
      if (matches.some((m) => !m.digit || !m.confident)) return null;

      const digits = matches.map((m) => m.digit).join('');
      const km = Number(digits);
      if (!Number.isFinite(km) || km <= 0) return null;

      const minScore = Math.min(...matches.map((m) => m.score));
      return {
        km,
        // below ~0.9 the right digits by a thinner margin — still worth keeping,
        // but the mismatch card should say "not sure" rather than "wrong"
        confidence: minScore >= 0.9 ? 'high' : 'low',
        digits,
        minScore: Math.round(minScore * 1000) / 1000,
        row: found.row,
        roi: found.roiBox,
      };
    } catch (e) {
      this.logger.warn(`seven-segment read failed: ${(e as Error).message}`);
      return null;
    }
  }

  // ------------------------------------------------------------------
  // labelling (what makes the classifier above possible)

  /**
   * Show a stored photo the way the reader sees it: ODO row + cut digits.
   * `box` (frame fractions) is the row a human marked — the cold-start path,
   * used when the detector has no prior yet for this dashboard.
   */
  async analyze(input: { assignmentId: string; stage: string; box?: Box | null }): Promise<SevenSegAnalysis> {
    const stage = this.stage(input.stage);
    const image = await this.loadImage(input.assignmentId, stage);
    const found = await this.inspect(image, 6, input.box ?? null);
    if (!found) throw new BadRequestException('No ODO digit row found in that photo');
    if (!found.segmented.digits.length) {
      throw new BadRequestException('The ODO row was found but no seven-segment digits could be cut from it');
    }

    const templates = await this.templates();
    const boxes = digitBoxes(found.segmented, found.roiBox.x, found.roiBox.y);
    const digits: AnalyzedDigit[] = found.segmented.digits.map((d, i) => {
      const match = classifyPatch(d.patch, templates);
      return {
        index: i,
        box: boxes[i],
        guess: templates.length ? match.digit : null,
        score: Math.round(match.score * 1000) / 1000,
        patch: this.patchPng(d.patch),
      };
    });
    const guessKm =
      digits.length >= MIN_DIGITS && digits.every((d) => d.guess) ? Number(digits.map((d) => d.guess).join('')) : null;

    const roiView = crop(image, found.roiBox);
    return {
      assignmentId: input.assignmentId,
      stage,
      photoUrl: `/api/cars/assignments/${input.assignmentId}/odometer/${stage}/photo`,
      row: found.row,
      label: found.label,
      roi: found.roiBox,
      polarity: found.segmented.polarity,
      roiPreview: `data:image/png;base64,${encodeGrayPng(roiView, this.viewScale(roiView, 520))}`,
      digits,
      guessKm,
      templates: templates.length,
    };
  }

  /**
   * Label one stored photo with the reading it really shows. The glyphs become
   * classifier templates and the row position becomes a prior for the detector:
   * this single call is both halves of "training".
   */
  async label(input: {
    assignmentId: string;
    stage: string;
    km: number;
    box?: Box | null;
    actor?: { username?: string };
  }): Promise<{ stored: number; km: number; stats: TrainingStats }> {
    const stage = this.stage(input.stage);
    const km = Math.trunc(Number(input.km));
    if (!Number.isFinite(km) || km <= 0) throw new BadRequestException('km must be a positive number');
    const expected = String(km).length;
    if (expected < MIN_DIGITS || expected > MAX_DIGITS) {
      throw new BadRequestException(`An odometer reading has ${MIN_DIGITS} to ${MAX_DIGITS} digits`);
    }

    const file = await this.photoFile(input.assignmentId, stage);
    const image = decodeImage(fs.readFileSync(file.filePath));
    if (!image) throw new BadRequestException('That photo could not be decoded — the reader handles JPEG and PNG only');

    // expect 0: cut what the photo really has — never force the typed digit count
    const found = await this.inspect(image, 0, input.box ?? null);
    if (!found) throw new BadRequestException('No ODO digit row found in that photo');
    const shown = found.segmented.digits.length;
    if (shown !== expected) {
      throw new BadRequestException(
        `The reader found ${shown} digit glyph${shown === 1 ? '' : 's'} in this photo but ${km} has ${expected} — ` +
          'label a steadier photo (straight on, LCD filling the frame), not this one',
      );
    }

    const createdBy = input.actor?.username ?? 'unknown';
    const digits = String(km).split('');
    const samples = found.segmented.digits.map((d, i) => ({
      digit: digits[i],
      patch: Buffer.from(d.patch).toString('base64'),
      vehicleNo: file.vehicleNo,
      createdBy,
    }));
    const calibration = {
      assignmentId: input.assignmentId,
      stage,
      vehicleNo: file.vehicleNo,
      createdBy,
      // where the ODO row sat in the frame — the detector's tie-breaker next time
      rx: found.row.x / Math.max(1, image.w),
      ry: found.row.y / Math.max(1, image.h),
      rw: found.row.w / Math.max(1, image.w),
      rh: found.row.h / Math.max(1, image.h),
    };

    await this.prisma.$transaction([
      this.prisma.odometerDigitSample.createMany({ data: samples }),
      this.prisma.odometerLcdCalibration.create({ data: calibration }),
    ]);

    await this.audit
      .log({
        username: createdBy,
        action: 'CAR_ODOMETER_DIGIT_LABELLED',
        module: 'CARS',
        recordId: input.assignmentId,
        newValue: { stage, km, glyphs: samples.length, vehicleNo: file.vehicleNo } as never,
      })
      .catch(() => undefined);

    return { stored: samples.length, km, stats: await this.stats() };
  }

  /** How much the classifier has learned, and whether it is ready to be trusted. */
  async stats(): Promise<TrainingStats> {
    const [grouped, calibrations] = await Promise.all([
      this.prisma.odometerDigitSample.groupBy({ by: ['digit'], _count: { _all: true } }).catch(() => []),
      this.prisma.odometerLcdCalibration.count().catch(() => 0),
    ]);
    const perDigit: Record<string, number> = {};
    for (const d of '0123456789') perDigit[d] = 0;
    let total = 0;
    for (const row of grouped as Array<{ digit?: string; _count?: { _all?: number } }>) {
      if (!row?.digit) continue;
      const n = row._count?._all ?? 0;
      perDigit[row.digit] = n;
      total += n;
    }
    return {
      perDigit,
      total,
      calibrations,
      // a handful per digit is enough to recognise a fixed seven-segment font,
      // but not one sample: a single smudged glyph must not define a digit
      ready: total >= 60 && Object.values(perDigit).every((n) => n >= 3),
    };
  }

  /** Recent stored dashboard photos, newest first — the labelling queue. */
  async photos(limit = 40): Promise<TrainingPhoto[]> {
    const rows = await this.prisma.carAssignment.findMany({
      where: { OR: [{ startOdoPhoto: { not: null } }, { endOdoPhoto: { not: null } }] },
      orderBy: { assignedAt: 'desc' },
      take: Math.max(1, Math.min(200, Math.trunc(limit) || 40)),
      select: {
        id: true,
        startOdoPhoto: true,
        endOdoPhoto: true,
        startOdoKm: true,
        endOdoKm: true,
        assignedAt: true,
        vehicle: { select: { vehicleNo: true } },
      },
    });
    const labelled = await this.prisma.odometerLcdCalibration
      .findMany({
        where: { assignmentId: { in: rows.map((r) => r.id) } },
        select: { assignmentId: true, stage: true },
      })
      .catch(() => [] as Array<{ assignmentId: string | null; stage: string | null }>);
    const done = new Set(labelled.map((l) => `${l.assignmentId}:${l.stage}`));

    const out: TrainingPhoto[] = [];
    for (const row of rows) {
      for (const stage of ['READY', 'BACK'] as const) {
        const name = stage === 'READY' ? row.startOdoPhoto : row.endOdoPhoto;
        if (!name) continue;
        out.push({
          assignmentId: row.id,
          stage,
          vehicleNo: row.vehicle?.vehicleNo ?? null,
          typedKm: stage === 'READY' ? row.startOdoKm : row.endOdoKm,
          at: row.assignedAt ? row.assignedAt.toISOString() : null,
          photoUrl: `/api/cars/assignments/${row.id}/odometer/${stage}/photo`,
          labelled: done.has(`${row.id}:${stage}`),
        });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------

  /**
   * Find the ODO row, then cut it into glyphs. The detector's boxes are the
   * fallback when the full-resolution re-cut disagrees with it.
   */
  private async inspect(
    image: Gray,
    expected: number,
    marked?: Box | null,
  ): Promise<{ row: Box; label: Box | null; roiBox: Box; segmented: Segmented } | null> {
    let row: Box | null = null;
    let label: Box | null = null;
    let polarity: 'light' | 'dark' = 'light';
    let glyphs: Box[] = [];

    if (marked) {
      // the human marked the row on the labelling screen: that beats any search
      row = marked;
    } else {
      const prior = priorBox(medianPrior(await this.calibrations()), image);
      const found = findDigitRow(image, prior);
      if (!found) return null;
      row = found.row;
      label = found.label;
      polarity = found.polarity;
      glyphs = found.glyphs;
    }

    // a little margin so a digit whose bars touch the edge is not clipped
    const roiBox = expandBox(row, 0.15, image.w, image.h);
    let segmented = segmentDigits(crop(image, roiBox), expected);
    if (segmented.digits.length < 5 || segmented.digits.length > 8) {
      if (!glyphs.length) return null;
      const digits = glyphs.map((b) => ({
        box: { x: b.x - roiBox.x, y: b.y - roiBox.y, w: b.w, h: b.h },
        patch: patchOf(image, b),
      }));
      segmented = { polarity, digits, rowBox: { x: 0, y: 0, w: roiBox.w, h: roiBox.h } };
    }

    // the row we actually cut — a marked box can be looser than the digits
    const cut: Box = {
      x: roiBox.x + segmented.rowBox.x,
      y: roiBox.y + segmented.rowBox.y,
      w: segmented.rowBox.w,
      h: segmented.rowBox.h,
    };
    return { row: cut, label, roiBox, segmented };
  }

  private stage(raw: string): 'READY' | 'BACK' {
    const value = String(raw ?? '').toUpperCase();
    if (value !== 'READY' && value !== 'BACK') throw new BadRequestException('stage must be READY or BACK');
    return value;
  }

  private async photoFile(assignmentId: string, stage: string) {
    const file = await this.cars.odometerPhotoFile(assignmentId, stage);
    if (!file) throw new NotFoundException('No stored dashboard photo for that odometer stage');
    return file;
  }

  private async loadImage(assignmentId: string, stage: string): Promise<Gray> {
    const file = await this.photoFile(assignmentId, stage);
    const image = decodeImage(fs.readFileSync(file.filePath));
    if (!image) throw new BadRequestException('That photo could not be decoded — the reader handles JPEG and PNG only');
    return image;
  }

  private async templates(): Promise<Template[]> {
    const rows = await this.prisma.odometerDigitSample
      .findMany({ select: { digit: true, patch: true }, orderBy: { createdAt: 'desc' }, take: MAX_TEMPLATES })
      .catch(() => [] as Array<{ digit: string; patch: string }>);
    return decodeTemplates(rows);
  }

  private async calibrations() {
    return this.prisma.odometerLcdCalibration
      .findMany({ select: { rx: true, ry: true, rw: true, rh: true }, orderBy: { createdAt: 'desc' }, take: MAX_CALIBRATIONS })
      .catch(() => [] as Array<{ rx: number; ry: number; rw: number; rh: number }>);
  }

  private patchPng(patch: Uint8Array): string {
    return `data:image/png;base64,${encodeGrayPng({ w: PATCH_W, h: PATCH_H, data: patch }, 6)}`;
  }

  private viewScale(image: Gray, targetWidth: number): number {
    return Math.max(1, Math.min(6, Math.round(targetWidth / Math.max(1, image.w))));
  }
}
