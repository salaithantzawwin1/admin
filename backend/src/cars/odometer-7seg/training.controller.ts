import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../auth/permissions.guard';
import { PERMISSIONS } from '../../auth/permissions';
import { Box } from './image';
import { OdometerSevenSegService } from './seven-seg.service';

/**
 * Labelling the offline seven-segment reader.
 *
 * Same people who dispatch cars (cars.assign) and already see the dashboard
 * photos there — labelling is that same evidence, recorded once, and it is what
 * the classifier is made of.
 */

class PhotoDto {
  @IsString() assignmentId!: string;
  @IsIn(['READY', 'BACK']) stage!: 'READY' | 'BACK';

  /**
   * The ODO row the administrator marked on the photo, as fractions of the
   * frame. Optional: without it the reader searches around what it has already
   * learned. On a dashboard it has never seen, this is how the first row is
   * found — and every mark makes the next search easier.
   */
  @IsOptional() @IsNumber() @Min(0) @Max(1) boxX?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) boxY?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) boxW?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) boxH?: number;
}

class LabelDto extends PhotoDto {
  /** the reading the photo really shows — the glyphs become classifier templates */
  @IsInt() @Min(1) @Max(9999999) km!: number;
}

function markedBox(dto: PhotoDto): Box | null {
  const { boxX: x, boxY: y, boxW: w, boxH: h } = dto;
  if (x == null || y == null || w == null || h == null) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

@ApiTags('cars')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('cars/odometer/training')
export class OdometerTrainingController {
  constructor(private sevenSeg: OdometerSevenSegService) {}

  /** How much the reader has learned, per digit. */
  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Get('stats')
  stats() {
    return this.sevenSeg.stats();
  }

  /** Recent stored dashboard photos — the labelling queue. */
  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Get('photos')
  photos(@Query('limit') limit?: string) {
    return this.sevenSeg.photos(Number(limit) || 40);
  }

  /** What the reader sees in one stored photo: the ODO row and the cut glyphs. */
  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Post('analyze')
  analyze(@Body() dto: PhotoDto) {
    return this.sevenSeg.analyze({ assignmentId: dto.assignmentId, stage: dto.stage, box: markedBox(dto) });
  }

  /** Label that photo: its glyphs and row position become training data. */
  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Post('label')
  label(@Req() req: any, @Body() dto: LabelDto) {
    const actor = { username: String(req?.user?.username ?? req?.user?.sub ?? 'unknown') };
    return this.sevenSeg.label({
      assignmentId: dto.assignmentId,
      stage: dto.stage,
      km: dto.km,
      box: markedBox(dto),
      actor,
    });
  }
}
