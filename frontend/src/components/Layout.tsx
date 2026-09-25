import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, getUser, hasPermission, clearSession, AuthUser } from '../api';
import { NotificationBell } from './NotificationBell';
import { ChangePasswordModal } from './ChangePasswordModal';
import { ToastHost } from './Toast';

const nav = [
  { to: '/', label: 'Dashboard', icon: '🏠', show: () => true },
  { to: '/requests', label: 'My Requests', icon: '📄', show: () => hasPermission('requests.read.own') },
  { to: '/car-requests', label: 'Car Requests', icon: '🚗', show: () => hasPermission('requests.create') },
  { to: '/meeting-rooms', label: 'Meeting Rooms', icon: '🏢', show: () => hasPermission('requests.create') },
  { to: '/inventory', label: 'Inventory', icon: '📦', show: () => hasPermission('inventory.read') },
  { to: '/announcements', label: 'Announcements', icon: '📢', show: () => hasPermission('announcements.read') },
  { to: '/suppliers', label: 'Suppliers', icon: '🚛', show: () => hasPermission('suppliers.read') },
  { to: '/approvals', label: 'Pending Approvals', icon: '✅', show: () => hasPermission('approvals.act') },
  { to: '/delegations', label: 'Delegations', icon: '🤝', show: () => hasPermission('approvals.act') },
  { to: '/fleet', label: 'Fleet', icon: '🚐', show: () => hasPermission('fleet.read') },
  { to: '/users', label: 'Users', icon: '👥', show: () => hasPermission('users.read') },
  { to: '/departments', label: 'Departments', icon: '🏢', show: () => hasPermission('departments.read') },
  { to: '/employees', label: 'Employees', icon: '🧑‍💼', show: () => hasPermission('employees.read') },
  { to: '/rbac', label: 'Permissions', icon: '🔐', show: () => hasPermission('users.manage') },
  { to: '/settings', label: 'Settings', icon: '⚙️', show: () => hasPermission('users.manage') },
  { to: '/audit-logs', label: 'Audit Logs', icon: '📋', show: () => hasPermission('audit.read') },
];

const SIDEBAR_KEY = 'ams_sidebar';

// Environment badge in the header — injected at build time by the Dockerfiles
// (VITE_ENV_LABEL=Production on the :80 stack, Testing on the :8030 stack).
const ENV_LABEL: string =
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_ENV_LABEL) ?? 'AMS';

export function Layout() {
  const navigate = useNavigate();
  const [user, setUser] = useState<AuthUser | null>(getUser());
  const [permissions, setPermissions] = useState<string[]>(getUser()?.permissions ?? []);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    if (saved !== null) return saved === 'collapsed';
    // default: collapse on narrow screens so tables keep their room
    return window.innerWidth < 768;
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // pending Telegram join requests → badge on the Settings nav item
  const [pendingJoins, setPendingJoins] = useState(0);
  const canSeeSettings = hasPermission('users.manage');

  useEffect(() => {
    if (!canSeeSettings) return;
    let alive = true;
    const poll = () => {
      api<{ length: number }>('/settings/telegram/joins')
        .then((r) => alive && setPendingJoins(Array.isArray(r) ? r.length : 0))
        .catch(() => {});
    };
    poll();
    const t = setInterval(poll, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [canSeeSettings]);

  // close the user menu when clicking outside
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // re-read the session whenever it changes (login/logout/refresh in any tab)
  useEffect(() => {
    const sync = () => {
      const u = getUser();
      setUser(u);
      setPermissions(u?.permissions ?? []);
    };
    window.addEventListener('ams_session', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('ams_session', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'open');
  }, [collapsed]);

  const logout = () => {
    clearSession();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-30">
        <div className="flex items-center justify-between px-3 sm:px-6 py-3">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            {/* logo on a white rounded tile so its dark lines stay visible against the header */}
            <div className="w-11 h-11 shrink-0 rounded-lg bg-white border border-gray-200 shadow-sm flex items-center justify-center p-1">
              <img src="/GLG.png" alt="GLG logo" className="max-w-full max-h-full object-contain" />
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-gray-900 text-sm sm:text-base truncate">AMS — Administration Management System</div>
              <div className="text-xs text-gray-400">{ENV_LABEL} · v0.1.0</div>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-4 shrink-0">
            <NotificationBell />
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                className="text-right hidden md:block rounded-lg px-2 py-1 hover:bg-gray-50 transition-colors"
                title="Account menu"
              >
                <div className="text-sm font-medium text-gray-800">{user?.fullName}</div>
                <div className="text-xs text-gray-400">{user?.roles.join(', ')}</div>
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 w-44 bg-white rounded-xl border border-gray-200 shadow-lg py-1 z-40">
                  <div className="px-3 py-2 border-b border-gray-100">
                    <div className="text-xs text-gray-400">Signed in as</div>
                    <div className="text-sm text-gray-700 truncate">{user?.username}</div>
                  </div>
                  <button
                    onClick={() => { setMenuOpen(false); setPwOpen(true); }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    🔑 Change password
                  </button>
                  <button
                    onClick={logout}
                    className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                  >
                    ⏻ Logout
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={logout}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors md:hidden"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        <aside
          className={`${collapsed ? 'w-16' : 'w-60'} transition-all duration-200 sticky top-[57px] self-start max-h-[calc(100vh-57px)] overflow-y-auto bg-white border-r border-gray-200 py-3 flex flex-col shrink-0`}
        >
          <button
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Expand menu' : 'Collapse menu'}
            aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
            className="self-end mr-2 mb-2 w-7 h-7 flex items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 text-sm transition-colors"
          >
            {collapsed ? '»' : '«'}
          </button>

          <nav className={`space-y-1 ${collapsed ? 'px-2' : 'px-3'}`}>
            {nav
              .filter((item) => item.show())
              .map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    `${collapsed ? 'flex justify-center px-2 py-2.5' : 'flex items-center gap-2.5 px-3 py-2'} rounded-lg text-sm transition-colors ${
                      isActive
                        ? 'bg-gold/10 text-gold-dark font-medium ring-1 ring-inset ring-gold/30'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`
                  }
                >
                  {/* collapsed rail: the icon is the only identifier — make it larger */}
                  <span className={`leading-none text-center ${collapsed ? 'text-xl w-6' : 'text-base w-5'}`}>{item.icon}</span>
                  {!collapsed && <span>{item.label}</span>}
                  {item.to === '/settings' && pendingJoins > 0 && (
                    <span
                      className={`ml-auto inline-flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold ${collapsed ? 'absolute translate-x-3 -translate-y-3' : 'min-w-[18px] h-[18px] px-1'}`}
                      title={`${pendingJoins} pending Telegram join request(s)`}
                    >
                      {pendingJoins}
                    </span>
                  )}
                </NavLink>
              ))}
          </nav>

          <div className={`mt-auto pt-3 border-t border-gray-100 ${collapsed ? 'px-2 text-center' : 'px-4'}`}>
            <div className={`text-[10px] uppercase tracking-wide text-gray-400 mb-1 ${collapsed ? 'hidden' : ''}`}>
              My permissions
            </div>
            <div
              className={`text-xs text-gray-500 ${collapsed ? 'text-[10px]' : ''}`}
              title={collapsed ? `${permissions.length} permissions granted` : undefined}
            >
              {collapsed ? permissions.length : `${permissions.length} granted`}
            </div>
          </div>
        </aside>

        <main className="flex-1 p-3 sm:p-6 min-w-0">
          <Outlet />
        </main>
      </div>
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
      <ToastHost />
    </div>
  );
}
