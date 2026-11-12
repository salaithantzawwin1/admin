import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../auth/permissions.guard';
import { PERMISSIONS } from '../../auth/permissions';
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
}

class LabelDto extends PhotoDto {
  /** the reading the photo really shows — the glyphs become classifier templates */
  @IsInt() @Min(1) @Max(9999999) km!: number;
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

  /** What the reader sees in one stored photo: the LCD row and the cut glyphs. */
  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Post('analyze')
  analyze(@Body() dto: PhotoDto) {
    return this.sevenSeg.analyze({ assignmentId: dto.assignmentId, stage: dto.stage });
  }

  /** Label that photo: its glyphs and row position become training data. */
  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Post('label')
  label(@Req() req: any, @Body() dto: LabelDto) {
    const actor = { username: String(req?.user?.username ?? req?.user?.sub ?? 'unknown') };
    return this.sevenSeg.label({ assignmentId: dto.assignmentId, stage: dto.stage, km: dto.km, actor });
  }
}
