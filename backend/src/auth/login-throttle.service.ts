import { Injectable, HttpException } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * In-memory rate limiter for the login endpoint (Plan §31: rate limiting for
 * authentication endpoints). Per IP + username sliding window:
 * max 10 attempts / 5 minutes, then 15 minutes lockout. Attempts count only
 * failed logins; successful logins reset the counter.
 *
 * Administration can lift a lockout early via unlockByUsername() (Users page
 * → Unlock) — needed when the real user is locked out behind a shared office
 * NAT and cannot wait out the timer.
 */
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 5 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

interface Entry {
  attempts: number[];
  blockedUntil?: number;
  /** plaintext username kept ONLY so admin unlock can find entries (not a secret — it was typed into the login form) */
  username: string;
}

@Injectable()
export class LoginThrottleService {
  private entries = new Map<string, Entry>();
  private lastSweep = Date.now();

  private key(ip: string, username: string): string {
    // hash so raw usernames/IPs are not kept in memory unnecessarily
    return crypto.createHash('sha256').update(`${ip}|${username.toLowerCase()}`).digest('hex').slice(0, 32);
  }

  private sweep() {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return; // at most once a minute
    this.lastSweep = now;
    for (const [k, e] of this.entries) {
      const fresh = e.attempts.some((t) => now - t < WINDOW_MS);
      const blocked = e.blockedUntil && e.blockedUntil > now;
      if (!fresh && !blocked) this.entries.delete(k);
    }
  }

  /** True when the request is allowed. False → respond 429 with retry seconds. */
  check(ip: string, username: string): { allowed: boolean; retryAfterSec?: number } {
    this.sweep();
    const e = this.entries.get(this.key(ip, username));
    const now = Date.now();
    if (e?.blockedUntil && e.blockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((e.blockedUntil - now) / 1000) };
    }
    return { allowed: true };
  }

  /** Record a failed attempt; locks out when the window is exceeded. */
  fail(ip: string, username: string) {
    const k = this.key(ip, username);
    const now = Date.now();
    const e = this.entries.get(k) ?? { attempts: [], username: username.toLowerCase() };
    e.username = username.toLowerCase();
    e.attempts = [...e.attempts.filter((t) => now - t < WINDOW_MS), now];
    if (e.attempts.length >= MAX_ATTEMPTS) {
      e.blockedUntil = now + LOCKOUT_MS;
      e.attempts = []; // window restarts after the lockout
    }
    this.entries.set(k, e);
  }

  /** Successful login — clear the counter for this identity. */
  success(ip: string, username: string) {
    this.entries.delete(this.key(ip, username));
  }

  /**
   * Administration unlock — clears every lockout entry for a username across
   * all source IPs (the admin cannot know which NAT IP the user comes from).
   * Also clears failure counters so the next attempt starts clean.
   * Returns how many entries were removed.
   */
  unlockByUsername(username: string): number {
    const target = username.toLowerCase();
    let cleared = 0;
    for (const [k, e] of this.entries) {
      if (e.username === target) {
        this.entries.delete(k);
        cleared++;
      }
    }
    return cleared;
  }

  /** Lockout state for the Users list — null = not locked; otherwise seconds remaining. */
  lockedSeconds(username: string): number | null {
    const target = username.toLowerCase();
    const now = Date.now();
    let worst: number | null = null;
    for (const e of this.entries.values()) {
      if (e.username !== target || !e.blockedUntil) continue;
      if (e.blockedUntil > now) worst = Math.max(worst ?? 0, Math.ceil((e.blockedUntil - now) / 1000));
    }
    return worst;
  }

  /** Express middleware scoped to POST …/auth/login (prefix-agnostic). */
  middleware(req: { path?: string; method?: string; ip?: string; headers: Record<string, string | string[] | undefined>; body?: { username?: string } }, res: { status: (c: number) => { json: (b: unknown) => void } }, next: () => void) {
    const isLogin = !!req.path?.endsWith('/auth/login') && req.method === 'POST';
    if (!isLogin) return next();
    const ip = req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown';
    const username = String(req.body?.username ?? '');
    const { allowed, retryAfterSec } = this.check(ip, username);
    if (!allowed) {
      res.status(429).json({ message: `Too many login attempts — try again in ${retryAfterSec ?? 60}s`, statusCode: 429 });
      return;
    }
    // record failures after the response: 401 = bad credentials
    const origStatus = res.status.bind(res);
    res.status = (code: number) => {
      const wrapped = origStatus(code);
      if (code === 401) this.fail(ip, username);
      return wrapped;
    };
    next();
  }
}
