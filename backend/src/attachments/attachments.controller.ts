import { BadRequestException, Controller, Delete, Get, Inject, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import * as fs from 'fs';
import { AttachmentsService } from './attachments.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';

@ApiTags('attachments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('attachments')
export class AttachmentsController {
  constructor(private attachments: AttachmentsService) {}

  @Post('upload')
  @RequirePermissions(PERMISSIONS.ATTACHMENTS_USE)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req,
    @Query('requestId') requestId?: string,
    @Query('announcementId') announcementId?: string,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.attachments.upload(file, requestId || undefined, req.user.id, req.user.username, announcementId || undefined);
  }

  /** Metadata list for an announcement (caller is announcements-manage guarded or a reader). */
  @Get('announcement/:announcementId')
  async listByAnnouncement(@Param('announcementId') announcementId: string) {
    return this.attachments.listByAnnouncement(announcementId);
  }

  @Get('request/:requestId')
  async listByRequest(@Param('requestId') requestId: string, @Req() req) {
    return this.attachments.listByRequest(requestId, req.user.id);
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Req() req, @Res() res: Response) {
    const { attachment, filePath } = await this.attachments.download(id, req.user.id);
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(attachment.filename)}"`);
    fs.createReadStream(filePath).pipe(res);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req) {
    return this.attachments.remove(id, req.user.id, req.user.username);
  }
}
