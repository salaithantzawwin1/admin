const BASE = '/api';
const TOKEN_KEY = 'ams_token';
const USER_KEY = 'ams_user';

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  roles: string[];
  permissions?: string[];
}

export function getPermissions(): string[] {
  return getUser()?.permissions ?? [];
}

export function hasPermission(perm: string): boolean {
  return getPermissions().includes(perm);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as AuthUser) : null;
}

export function setSession(token: string, user: AuthUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  // let the Layout (and other tabs) re-read permissions immediately
  window.dispatchEvent(new Event('ams_session'));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  window.dispatchEvent(new Event('ams_session'));
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (res.status === 401 && !path.startsWith('/auth/')) {
    // expired/invalid session on a protected call → clear and bounce to login.
    // (auth endpoints like /auth/login pass through so 'Invalid credentials' shows)
    clearSession();
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new ApiError(401, 'Session expired');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (data as { message?: string | string[] })?.message != null
        ? Array.isArray((data as { message: string | string[] }).message)
          ? (data as { message: string[] }).message.join(', ')
          : (data as { message: string }).message
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export function hasRole(user: AuthUser | null, role: string): boolean {
  return !!user?.roles?.includes(role);
}

/** Refresh permissions/roles after role edits so the UI stays in sync. */
export async function refreshSession(): Promise<void> {
  try {
    const me = await api<AuthUser & { permissions: string[] }>('/auth/me');
    const token = getToken();
    if (token) setSession(token, me);
  } catch {
    // ignore — session will refresh on next login
  }
}
