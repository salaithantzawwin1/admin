import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.module';
import { Public } from '../auth/public.decorator';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    let db = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }
    return {
      status: 'ok',
      app: 'ams-backend',
      version: process.env.APP_VERSION || '0.0.0',
      env: process.env.APP_ENV || 'development',
      db,
      time: new Date().toISOString(),
    };
  }
}
