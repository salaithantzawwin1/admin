import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { LoginThrottleService } from './auth/login-throttle.service';
import { assertJwtSecret } from './util/jwt-secret';
import { auditContextMiddleware } from './audit/request-context';

async function bootstrap() {
  // Fail before the port opens rather than sign tokens with a known key.
  assertJwtSecret();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.setGlobalPrefix('api');

  // nginx is the only ingress (the backend is published on 127.0.0.1), so the
  // right-most X-Forwarded-For hop is the real client. Trusting it means
  // req.ip — and therefore the login throttle key — cannot be spoofed.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));

  // The UI is served from the same origin, so cross-origin browser access is
  // off unless explicitly allow-listed. Authentication is a bearer token (no
  // cookies), so credentials are never shared cross-origin.
  const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
    maxAge: 600,
  });

  // Audit entries carry the caller's IP and device: the context has to wrap
  // every request, and it must come after `trust proxy` is set.
  app.use(auditContextMiddleware);

  // Response headers for every API answer, including streamed files: a
  // browser must never re-interpret a stored file as HTML or script.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

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

  // The OpenAPI document maps every endpoint and permission for an attacker;
  // it is a development aid, so it stays off unless explicitly enabled.
  const docsEnabled =
    process.env.ENABLE_API_DOCS === 'true' ||
    (process.env.APP_ENV ?? 'development') === 'development';
  if (docsEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('AMS API')
      .setDescription('Administration Management System API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }

  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`AMS backend listening on :${port} (env=${process.env.APP_ENV || 'dev'})`);
}

bootstrap();
