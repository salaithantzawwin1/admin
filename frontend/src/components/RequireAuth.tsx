import { ReactNode, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, getToken, setSession } from '../api';

/**
 * Auth gate: requires a token and (re)loads /auth/me on every mount so the
 * stored session always carries fresh roles + permissions — permission/role
 * changes made by an admin (or a redeploy that grants new permissions) apply
 * on the next page load without requiring logout/login.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [checked, setChecked] = useState(false);
  const token = getToken();

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setChecked(true);
      return;
    }
    api<{ id: string; username: string; fullName: string; roles: string[]; permissions?: string[] }>('/auth/me')
      .then((me) => {
        if (!cancelled && token) setSession(token, me);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-gray-400">
        Loading…
      </div>
    );
  }
  return <>{children}</>;
}
