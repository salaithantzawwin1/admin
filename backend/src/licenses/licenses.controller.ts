import {
  Controller,
  Body,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import * as fs from 'fs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { Actor } from '../org/org.service';
import { LicensesService } from './licenses.service';

export class LicenseDto {
  @IsString() @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(60) registrationNo?: string;
  @IsOptional() @IsString() @MaxLength(200) companyLimited?: string;
  @IsOptional() @IsString() @MaxLength(200) myanmarName?: string;
  /** date-only (YYYY-MM-DD) or ISO timestamp */
  @IsOptional() @IsString() startDate?: string;
  @IsOptional() @IsString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(160) email?: string;
  @IsOptional() @IsString() @MaxLength(160) emailPassword?: string;
  @IsOptional() @IsString() @MaxLength(160) tradenetPassword?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class UpdateLicenseDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(60) registrationNo?: string;
  @IsOptional() @IsString() @MaxLength(200) companyLimited?: string;
  @IsOptional() @IsString() @MaxLength(200) myanmarName?: string;
  @IsOptional() @IsString() startDate?: string;
  @IsOptional() @IsString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(160) email?: string;
  @IsOptional() @IsString() @MaxLength(160) emailPassword?: string;
  @IsOptional() @IsString() @MaxLength(160) tradenetPassword?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

@ApiTags('licenses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('licenses')
export class LicensesController {
  constructor(private licenses: LicensesService) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  /** One page of the register (20 per page by default). */
  @RequirePermissions(PERMISSIONS.LICENSES_READ)
  @Get()
  list(
    @Query('q') q?: string,
    @Query('filter') filter?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
    const current = Math.max(Number(page) || 1, 1);
    return this.licenses.list(q || undefined, filter || undefined, current, size);
  }

  /** Renewal planning download — due-date order, before the :id routes. */
  @RequirePermissions(PERMISSIONS.LICENSES_READ)
  @Get('export.csv')
  async csv(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="import-export-licenses-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(await this.licenses.csv());
  }

  /** Dashboard feed: licences due within (and including) `days`. */
  @RequirePermissions(PERMISSIONS.LICENSES_READ)
  @Get('upcoming')
  upcoming(@Query('days') days?: string) {
    const window = Number(days);
    return this.licenses.upcoming(Number.isFinite(window) && window > 0 ? window : 60);
  }

  @RequirePermissions(PERMISSIONS.LICENSES_READ)
  @Get(':id')
  detail(@Req() req, @Param('id') id: string) {
    return this.licenses.detail(id, req.user.id);
  }

  @RequirePermissions(PERMISSIONS.LICENSES_MANAGE)
  @Post()
  create(@Req() req, @Body() dto: LicenseDto) {
    return this.licenses.create(dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.LICENSES_MANAGE)
  @Patch(':id')
  update(@Req() req, @Param('id') id: string, @Body() dto: UpdateLicenseDto) {
    return this.licenses.update(id, dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.LICENSES_MANAGE)
  @Delete(':id')
  remove(@Req() req, @Param('id') id: string) {
    return this.licenses.remove(id, this.actor(req));
  }

  // ---------- scans (up to five per license) ----------

  @RequirePermissions(PERMISSIONS.LICENSES_READ)
  @Get(':id/images')
  images(@Param('id') id: string) {
    return this.licenses.listImages(id);
  }

  @RequirePermissions(PERMISSIONS.LICENSES_MANAGE)
  @Post(':id/images')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  uploadImage(@Req() req, @Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    return this.licenses.uploadImage(id, file, this.actor(req));
  }

  /** Streams one scan inline — nosniff + a sandboxed CSP so a crafted file can
   *  never act as a page. */
  @RequirePermissions(PERMISSIONS.LICENSES_READ)
  @Get(':id/images/:imageId')
  async image(@Param('id') id: string, @Param('imageId') imageId: string, @Res() res: Response) {
    const { row, filePath } = await this.licenses.imageFile(id, imageId);
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Content-Disposition', 'inline; filename="license-' + row.license.name.replace(/[^A-Za-z0-9._-]/g, '_') + '"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=60');
    fs.createReadStream(filePath).pipe(res);
  }

  @RequirePermissions(PERMISSIONS.LICENSES_MANAGE)
  @Delete(':id/images/:imageId')
  removeImage(@Req() req, @Param('id') id: string, @Param('imageId') imageId: string) {
    return this.licenses.removeImage(id, imageId, this.actor(req));
  }
}
