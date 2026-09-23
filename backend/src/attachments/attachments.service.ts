import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';

const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
  'application/zip',
];

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB per file (plan §31: file type/size validation)

@Injectable()
export class AttachmentsService {
  private uploadRoot = process.env.UPLOAD_PATH || '/app/uploads';

  constructor(private prisma: PrismaService, private audit: AuditService) {}

  private ensureDir() {
    if (!fs.existsSync(this.uploadRoot)) fs.mkdirSync(this.uploadRoot, { recursive: true });
  }

  async upload(file: Express.Multer.File, requestId: string | undefined, userId: string, username: string) {
    if (!file) throw new BadRequestException('No file provided');
    if (!ALLOWED_MIME.includes(file.mimetype)) throw new BadRequestException(`File type not allowed: ${file.mimetype}`);
    if (file.size > MAX_SIZE) throw new BadRequestException('File too large (max 10 MB)');

    if (requestId) {
      const request = await this.prisma.requestDocument.findUnique({ where: { id: requestId } });
      if (!request) throw new NotFoundException('Request not found');
      if (request.requesterId !== userId) {
        // only the owner (or a system admin) can attach files to a request
        const admin = await this.prisma.userRole.findFirst({
          where: { userId, role: { name: 'SYSTEM_ADMIN' } },
        });
        if (!admin) throw new ForbiddenException('Not your request');
      }
    }

    this.ensureDir();
    const ext = path.extname(file.originalname || '').slice(0, 10);
    const storedName = `${crypto.randomUUID()}${ext}`;
    fs.writeFileSync(path.join(this.uploadRoot, storedName), file.buffer);

    const attachment = await this.prisma.attachment.create({
      data: {
        requestId,
        filename: file.originalname || storedName,
        storedName,
        mimeType: file.mimetype,
        size: file.size,
        uploadedById: userId,
      },
    });

    await this.audit.log({
      userId, username,
      action: 'ATTACHMENT_UPLOADED',
      module: 'ATTACHMENTS',
      recordId: attachment.id,
      newValue: { filename: attachment.filename, requestId },
    });

    return attachment;
  }

  async download(id: string, userId: string) {
    const attachment = await this.prisma.attachment.findUnique({ where: { id } });
    if (!attachment) throw new NotFoundException('Attachment not found');

    if (attachment.requestId) {
      const request = await this.prisma.requestDocument.findUnique({ where: { id: attachment.requestId } });
      if (!request) throw new NotFoundException('Request not found');
      if (request.requesterId !== userId) {
        // approvers / admins may access; simple check: any role or same-department head
        const privileged = await this.prisma.userRole.findFirst({
          where: {
            userId,
            role: { name: { in: ['SYSTEM_ADMIN', 'ADMINISTRATION', 'DEPARTMENT_HEAD', 'MANAGEMENT'] } },
          },
        });
        if (!privileged) throw new ForbiddenException('No access to this attachment');
      }
    }

    const filePath = path.join(this.uploadRoot, attachment.storedName);
    if (!fs.existsSync(filePath)) throw new NotFoundException('File missing on disk');
    return { attachment, filePath };
  }

  /** Metadata list for a request — access is checked like download (owner or privileged role). */
  async listByRequest(requestId: string, userId: string) {
    const request = await this.prisma.requestDocument.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.requesterId !== userId) {
      const privileged = await this.prisma.userRole.findFirst({
        where: {
          userId,
          role: { name: { in: ['SYSTEM_ADMIN', 'ADMINISTRATION', 'DEPARTMENT_HEAD', 'MANAGEMENT'] } },
        },
      });
      if (!privileged) throw new ForbiddenException('No access to this request');
    }
    return this.prisma.attachment.findMany({ where: { requestId }, orderBy: { createdAt: 'desc' } });
  }

  async remove(id: string, userId: string, username: string) {
    const attachment = await this.prisma.attachment.findUnique({ where: { id } });
    if (!attachment) throw new NotFoundException('Attachment not found');

    const admin = await this.prisma.userRole.findFirst({ where: { userId, role: { name: 'SYSTEM_ADMIN' } } });
    if (attachment.uploadedById !== userId && !admin) throw new ForbiddenException('Not your attachment');

    const filePath = path.join(this.uploadRoot, attachment.storedName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await this.prisma.attachment.delete({ where: { id } });

    await this.audit.log({
      userId, username,
      action: 'ATTACHMENT_DELETED',
      module: 'ATTACHMENTS',
      recordId: id,
      oldValue: { filename: attachment.filename },
      severity: 'WARNING',
    });
    return { success: true };
  }
}
