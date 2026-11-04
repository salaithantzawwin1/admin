import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * Audit entries written from deep inside services (vehicle updates, photo
 * uploads, approvals…) have no access to the HTTP request, so their ipAddress
 * and userAgent were always NULL — only login filled them. This context carries
 * the caller's address through the whole request so every entry can record it.
 */
export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export const auditContext = new AsyncLocalStorage<RequestMeta>();

/** Express middleware — registered app-wide in main.ts, after `trust proxy`. */
export function auditContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  const raw = (req.ip || '').trim();
  // a dual-stack listener reports IPv4 peers as ::ffff:10.0.0.5
  const ip = raw.replace(/^::ffff:/, '') || undefined;
  const userAgent = (req.headers?.['user-agent'] as string | undefined)?.slice(0, 500);
  auditContext.run({ ip, userAgent }, next);
}
