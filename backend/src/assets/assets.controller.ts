import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsArray, IsDateString, IsIn, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Response } from 'express';
import * as fs from 'fs';
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
  /** Category-specific answers: { [fieldKey]: string }. Keys the chosen
   *  category does not define are dropped by the service. */
  @IsOptional() @IsObject() specs?: Record<string, string>;
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
  /** null clears every specification answer; undefined leaves them alone. */
  @IsOptional() @IsObject() specs?: Record<string, string> | null;
}

/** Asset Setup → Category: the specification fields that category asks for. */
export class CategorySpecFieldsDto {
  /** [{ key?, label, type: 'text'|'number'|'select', options? }] — validated
   *  and normalised in the service (keys, limits, options). */
  @IsArray() fields!: unknown[];
}

export class AssetTransferDto {
  @IsOptional() @IsString() toLocationId?: string;
  @IsOptional() @IsString() @MaxLength(160) custodian?: string | null;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

/** One cost event on an asset — a service visit, a spare part, consumables.
 *  §14.5: the purchase price is not entered here; it is part of the asset. */
export class AssetCostDto {
  @IsIn(['PURCHASE', 'SERVICE', 'REPAIR', 'PART', 'CONSUMABLE', 'OTHER']) kind!: string;
  @IsNumber() @Min(0.01) amount!: number;
  /** When the money was spent (service/bill date). Defaults to today. */
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsNumber() @Min(1) quantity?: number;
  @IsOptional() @IsString() accountId?: string;
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
}

/** Asset Setup (New) master-list body: {name} for category/location/custodian. */
export class SetupNameDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
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
    @Query() query: Record<string, string> = {},
  ) {
    // sf_<fieldKey>=<answer> — one filter per specification field the category
    // defines, so "Connection = USB" works from the register filter bar.
    const specs = Object.fromEntries(
      Object.entries(query)
        .filter(([key, value]) => /^sf_[a-z0-9_]{1,40}$/.test(key) && typeof value === 'string' && value.trim() !== '')
        .map(([key, value]) => [key.slice(3), value]),
    );
    return this.assets.list({ q, categoryId, locationId, status, specs });
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

  // ---------- Asset Setup (New) master CRUD — categories / locations / custodians ----------
  // Declared before @Get(':id') so the static segments are not swallowed by it.

  @Get('categories')
  @RequirePermissions(PERMISSIONS.ASSETS_READ)
  listCategories() {
    return this.assets.listSetup('categories');
  }

  @Post('categories')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  createCategory(@Req() req, @Body() dto: SetupNameDto) {
    return this.assets.createSetup('categories', dto, this.actor(req));
  }

  /** Which specification fields do assets of this category carry? (a printer:
   *  USB vs Network, colour vs mono…). Replaces the whole list. */
  @Patch('categories/:id/specs')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  setCategorySpecFields(@Req() req, @Param('id') id: string, @Body() dto: CategorySpecFieldsDto) {
    return this.assets.setCategorySpecFields(id, dto.fields, this.actor(req));
  }

  @Get('locations')
  @RequirePermissions(PERMISSIONS.ASSETS_READ)
  listLocations() {
    return this.assets.listSetup('locations');
  }

  @Post('locations')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  createLocation(@Req() req, @Body() dto: SetupNameDto) {
    return this.assets.createSetup('locations', dto, this.actor(req));
  }

  @Get('custodians')
  @RequirePermissions(PERMISSIONS.ASSETS_READ)
  listCustodians() {
    return this.assets.listSetup('custodians');
  }

  @Post('custodians')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  createCustodian(@Req() req, @Body() dto: SetupNameDto) {
    return this.assets.createSetup('custodians', dto, this.actor(req));
  }

  @Patch('categories/:id')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  updateCategory(@Req() req, @Param('id') id: string, @Body() dto: SetupNameDto) {
    return this.assets.updateSetup('categories', id, dto, this.actor(req));
  }

  @Delete('categories/:id')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  removeCategory(@Req() req, @Param('id') id: string) {
    return this.assets.removeSetup('categories', id, this.actor(req));
  }

  @Patch('locations/:id')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  updateLocation(@Req() req, @Param('id') id: string, @Body() dto: SetupNameDto) {
    return this.assets.updateSetup('locations', id, dto, this.actor(req));
  }

  @Delete('locations/:id')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  removeLocation(@Req() req, @Param('id') id: string) {
    return this.assets.removeSetup('locations', id, this.actor(req));
  }

  @Patch('custodians/:id')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  updateCustodian(@Req() req, @Param('id') id: string, @Body() dto: SetupNameDto) {
    return this.assets.updateSetup('custodians', id, dto, this.actor(req));
  }

  @Delete('custodians/:id')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  removeCustodian(@Req() req, @Param('id') id: string) {
    return this.assets.removeSetup('custodians', id, this.actor(req));
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

  /** §14.5 — record money spent on this asset after acquisition. */
  @Post(':id/costs')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  addCost(@Req() req, @Param('id') id: string, @Body() dto: AssetCostDto) {
    return this.assets.addCost(id, dto, this.actor(req));
  }

  /** Removes a hand-typed cost row; invoice-posted rows are refused (409). */
  @Delete(':id/costs/:costId')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  removeCost(@Req() req, @Param('id') id: string, @Param('costId') costId: string) {
    return this.assets.removeCost(id, costId, this.actor(req));
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  remove(@Req() req, @Param('id') id: string) {
    return this.assets.remove(id, this.actor(req));
  }

  /** §39 register a fixed asset from a PO line (cost/date/serial provenance). */
  /** Fit a component asset (a cartridge) into this asset (a printer). */
  @Post(':id/components')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  installComponent(@Req() req, @Param('id') id: string, @Body() body: { componentAssetId?: string; note?: string }) {
    return this.assets.installComponent(id, { componentAssetId: body?.componentAssetId, note: body?.note }, this.actor(req));
  }

  /** Remove a fitted part — `?retire=true` when it is used up. */
  @Delete(':id/components/:linkId')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  removeComponent(@Req() req, @Param('id') id: string, @Param('linkId') linkId: string, @Query('retire') retire?: string) {
    return this.assets.removeComponent(id, linkId, { retire: retire === 'true' }, this.actor(req));
  }

  /** QR label (SVG) for the printed asset sticker. */
  @Get(':id/qr.svg')
  @RequirePermissions(PERMISSIONS.ASSETS_READ)
  async qrLabel(@Req() req, @Param('id') id: string, @Res() res: Response) {
    const { svg } = await this.assets.qrLabel(id, req);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(svg);
  }

  /** Asset photo (JPEG/PNG/WebP) — replaceable, one per asset. */
  @Post(':id/photo')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  uploadPhoto(@Req() req, @Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    return this.assets.setPhoto(id, file, this.actor(req));
  }

  /** Streams the photo to anyone who may read assets. Served inline, but with
   *  nosniff + a sandboxed CSP so a crafted file can never act as a page. */
  @Get(':id/photo')
  @RequirePermissions(PERMISSIONS.ASSETS_READ)
  async photo(@Param('id') id: string, @Res() res: Response) {
    const { asset, filePath, mimeType } = await this.assets.photoFile(id);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${asset.assetCode.replace(/[^A-Za-z0-9._-]/g, '_')}-photo"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=60');
    fs.createReadStream(filePath).pipe(res);
  }

  @Delete(':id/photo')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  removePhoto(@Req() req, @Param('id') id: string) {
    return this.assets.removePhoto(id, this.actor(req));
  }

  @Post('register-from-po/:poItemId')
  @RequirePermissions(PERMISSIONS.ASSETS_MANAGE)
  registerFromPo(@Req() req, @Param('poItemId') poItemId: string, @Body() dto: AssetDto) {
    return this.assets.registerFromPoLine(poItemId, dto, this.actor(req));
  }
}
