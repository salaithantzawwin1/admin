import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { AssetsService } from './assets.service';
import { Actor } from '../org/org.service';

// ---------- VMS/AMS asset register DTOs (§15–16, §39–40) ----------

export class AssetDto {
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  /** Auto-generated AST-… when omitted. */
  @IsOptional() @IsString() @MaxLength(32) assetCode?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() @MaxLength(120) brand?: string;
  @IsOptional() @IsString() @MaxLength(120) model?: string;
  @IsOptional() @IsString() @MaxLength(120) serialNumber?: string;
  @IsOptional() @IsString() @MaxLength(160) custodian?: string;
  @IsOptional() @IsString() locationId?: string;
  @IsOptional() @IsDateString() purchaseDate?: string;
  @IsOptional() @IsNumber() @Min(0) purchaseCost?: number;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

export class AssetUpdateDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  /**
   * The Edit dialog always posts the row's existing code (every asset has one),
   * so this must be ACCEPTED — under `forbidNonWhitelisted` the missing property
   * made every single save fail with 400 "property assetCode should not exist".
   * The service re-checks uniqueness when the code actually changes.
   */
  @IsOptional() @IsString() @MaxLength(32) assetCode?: string;
  /** null clears the link; undefined leaves it unchanged (frontend sends null
   *  for the "— none —" option). */
  @IsOptional() @IsString() categoryId?: string | null;
  @IsOptional() @IsString() @MaxLength(120) brand?: string | null;
  @IsOptional() @IsString() @MaxLength(120) model?: string | null;
  @IsOptional() @IsString() @MaxLength(120) serialNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(160) custodian?: string | null;
  @IsOptional() @IsString() locationId?: string | null;
  @IsOptional() @IsDateString() purchaseDate?: string | null;
  /** null clears the cost; undefined leaves it unchanged. */
  @IsOptional() @IsNumber() @Min(0) purchaseCost?: number | null;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsIn(['ACTIVE', 'IN_STORAGE', 'MAINTENANCE', 'DISPOSED']) status?: string;
}

export class AssetTransferDto {
  @IsOptional() @IsString() toLocationId?: string;
  @IsOptional() @IsString() @MaxLength(160) custodian?: string | null;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

@ApiTags('assets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('assets')
export class AssetsController {
  constructor(private assets: AssetsService) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.ASSETS_READ)
  list(
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
  ) {
    return this.assets.list({ q, categoryId, locationId, status });
  }

  /** §41 asset register export. */
  @Get('csv')
  @RequirePermissions(PERMISSIONS.ASSETS_READ)
  async csv(@Res() res: Response) {
    const body = await this.assets.csv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="asset-register-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(body);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ASSETS_READ)
  detail(@Param('id') id: string) {
    return this.assets.detail(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  create(@Req() req, @Body() dto: AssetDto) {
    return this.assets.create(dto, this.actor(req));
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  update(@Req() req, @Param('id') id: string, @Body() dto: AssetUpdateDto) {
    return this.assets.update(id, dto, this.actor(req));
  }

  /** §40 transfer — location + custody in one auditable movement. */
  @Post(':id/transfer')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  transfer(@Req() req, @Param('id') id: string, @Body() dto: AssetTransferDto) {
    return this.assets.transfer(id, dto, this.actor(req));
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  remove(@Req() req, @Param('id') id: string) {
    return this.assets.remove(id, this.actor(req));
  }

  /** §39 register a fixed asset from a PO line (cost/date/serial provenance). */
  @Post('register-from-po/:poItemId')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  registerFromPo(@Req() req, @Param('poItemId') poItemId: string, @Body() dto: AssetDto) {
    return this.assets.registerFromPoLine(poItemId, dto, this.actor(req));
  }
}
