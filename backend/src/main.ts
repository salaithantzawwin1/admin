import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { LoginThrottleService } from './auth/login-throttle.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.enableCors({ origin: true, credentials: true });
  // cap request bodies (Plan §31: input validation) — uploads are multipart and bypass this
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  // login rate limiting (Plan §31: rate limiting for auth endpoints)
  const loginThrottle = app.get(LoginThrottleService);
  app.use(loginThrottle.middleware.bind(loginThrottle));

  // RBAC bootstrap: sync the Permission catalog rows with backend/src/auth/permissions.ts
  const { seedPermissions } = await import('./auth/permissions-seed');
  await seedPermissions();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('AMS API')
    .setDescription('Administration Management System API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`AMS backend listening on :${port} (env=${process.env.APP_ENV || 'dev'})`);
}

bootstrap();
