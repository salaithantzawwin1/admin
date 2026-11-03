/**
 * The JWT signing key.
 *
 * A missing JWT_SECRET used to fall back to a hard-coded string, which means a
 * deploy that forgot the variable still "worked" — and anyone who read this
 * repository could mint a token for any user, including the system
 * administrator. Outside development the app now refuses to start instead.
 */

const DEV_FALLBACK = 'dev_only_secret_change_me';

export function jwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const isDev = (process.env.APP_ENV ?? 'development') === 'development' && process.env.NODE_ENV !== 'production';
  if (isDev) return DEV_FALLBACK;
  throw new Error(
    fromEnv
      ? 'JWT_SECRET is too short (needs at least 16 characters) — refusing to start'
      : 'JWT_SECRET is not set — refusing to start outside development',
  );
}

/** Boot-time check so the container fails loudly instead of signing with a known key. */
export function assertJwtSecret(): void {
  jwtSecret();
}
