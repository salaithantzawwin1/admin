import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';

class FindAuditQuery {
  @IsOptional() @IsString() module?: string;
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() pageSize?: string;
}

@ApiTags('audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@RequirePermissions(PERMISSIONS.AUDIT_READ)
@Controller('audit-logs')
export class AuditController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async findAll(@Query() q: FindAuditQuery) {
    const page = Math.max(1, Number(q.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize || 25)));
    const where = q.module ? { module: q.module } : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, username: true, action: true, module: true, recordId: true,
          ipAddress: true, severity: true, createdAt: true,
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }
}
