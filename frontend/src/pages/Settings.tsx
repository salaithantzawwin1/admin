import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Modal } from '../components/Modal';
import { toast } from '../components/Toast';
import { Badge, Button, Empty, Input, PageHeader } from '../components/ui';

interface AdConfig {
  url: string;
  baseDn: string;
  bindDn: string;
  bindPassword: string; // masked from server? we keep it simple: returned as stored
  defaultRole: string;
  enabled: boolean;
}

interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
}

interface TelegramConfig {
  botToken: string;
  enabled: boolean;
  webUrl: string;
}

interface TgJoin {
  id: string;
  chatId: string;
  tgUsername: string | null;
  displayName: string | null;
  status: string;
  createdAt: string;
  bound?: { kind: 'user' | 'driver'; id: string; name: string; telegramUsername: string | null } | null;
}

interface PickUser { id: string; fullName: string; username: string; telegramChatId?: string | null; status?: string; userRoles?: { role: { name: string } }[] }
interface PickDriver { id: string; name: string; telegramChatId?: string | null; telegramUsername?: string | null; status?: string; vehicles?: { vehicleNo: string }[] }

/** One timeline entry of a Telegram chat's bind history. */
interface ChatHistoryRow {
  at: string;
  action: string;
  label: string;
  account: string | null;
  by: string;
}

/** Visual treatment per bind-history event type. */
const EVENT_STYLE: Record<string, { icon: string; tone: 'green' | 'red' | 'blue' | 'amber' | 'gray' }> = {
  TELEGRAM_JOIN_REQUESTED: { icon: '📨', tone: 'blue' },
  TELEGRAM_JOIN_APPROVED: { icon: '✅', tone: 'green' },
  TELEGRAM_JOIN_REASSIGNED: { icon: '🔄', tone: 'amber' },
  TELEGRAM_JOIN_REJECTED: { icon: '❌', tone: 'red' },
  TELEGRAM_USER_BOUND: { icon: '🔗', tone: 'green' },
  TELEGRAM_DRIVER_BOUND: { icon: '🚗', tone: 'green' },
  TELEGRAM_ADMIN_UNBIND: { icon: '🔓', tone: 'red' },
};

const TONE_RING: Record<string, string> = {
  green: 'bg-green-100 border-green-400',
  red: 'bg-red-100 border-red-400',
  blue: 'bg-blue-100 border-blue-400',
  amber: 'bg-amber-100 border-amber-400',
  gray: 'bg-gray-100 border-gray-400',
};

const TONE_CARD: Record<string, string> = {
  green: 'border-l-green-400',
  red: 'border-l-red-400',
  blue: 'border-l-blue-400',
  amber: 'border-l-amber-400',
  gray: 'border-l-gray-300',
};

/** "just now / 12 min ago / 3 h ago / 2 d ago" for timeline rows. */
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

const ROLES = ['EMPLOYEE', 'ADMINISTRATION', 'DEPARTMENT_HEAD', 'MANAGEMENT', 'PURCHASING', 'FINANCE', 'MAINTENANCE_COORDINATOR', 'SYSTEM_ADMIN'];

type SettingsTab = 'ad' | 'holidays' | 'telegram' | 'joins';

export default function Settings() {
  // active tab lives in the URL (?tab=holidays) so refresh / back / shared links keep it
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as SettingsTab | null;
  const tab: SettingsTab = tabParam === 'holidays' || tabParam === 'telegram' || tabParam === 'joins' ? tabParam : 'ad';
  const setTab = (t: SettingsTab) => setSearchParams(t === 'ad' ? {} : { tab: t }, { replace: false });
  const [cfg, setCfg] = useState<AdConfig | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  // ---------- Public Holidays editor state ----------
  const now = new Date();
  const [holYear, setHolYear] = useState(now.getFullYear());
  const [holidays, setHolidays] = useState<Holiday[] | null>(null);
  const [holDirty, setHolDirty] = useState(false);
  const [holMsg, setHolMsg] = useState('');
  const [holError, setHolError] = useState('');
  const [holBusy, setHolBusy] = useState(false);
  const [newHol, setNewHol] = useState({ date: '', name: '' });
  const [bulkHol, setBulkHol] = useState<string>('');
  const [showBulkHol, setShowBulkHol] = useState(false);

  // ---------- Telegram (driver notifications) state ----------
  const [tgCfg, setTgCfg] = useState<TelegramConfig | null>(null);
  const [tgBot, setTgBot] = useState<{ botUsername: string | null; configured: boolean } | null>(null);
  const [tgMsg, setTgMsg] = useState('');
  const [tgError, setTgError] = useState('');
  const [tgTestChat, setTgTestChat] = useState('');
  const [tgTestResult, setTgTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [tgBusy, setTgBusy] = useState(false);

  // ---------- Telegram join requests (draft → approve / re-assign) ----------
  const [joins, setJoins] = useState<TgJoin[] | null>(null);
  const [joinStatus, setJoinStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>('PENDING');
  const [joinUsers, setJoinUsers] = useState<PickUser[]>([]);
  const [joinDrivers, setJoinDrivers] = useState<PickDriver[]>([]);
  const [joinPick, setJoinPick] = useState<Record<string, { kind: 'user' | 'driver'; id: string }>>({});
  const [joinEditing, setJoinEditing] = useState<Record<string, boolean>>({}); // APPROVED rows: pickers stay hidden until the admin clicks Re-assign
  const [joinMsg, setJoinMsg] = useState('');
  const [joinError, setJoinError] = useState('');
  // chat bind-history dialog state
  const [histChat, setHistChat] = useState<{ chatId: string; name: string } | null>(null);
  const [histRows, setHistRows] = useState<ChatHistoryRow[] | null>(null);
  const [histError, setHistError] = useState('');

  const loadJoins = useCallback(() => {
    // always pass the status explicitly — omitting it makes the backend default to PENDING,
    // which broke the "All" tab (it silently showed only pending rows)
    api<TgJoin[]>(`/settings/telegram/joins?status=${joinStatus}`).then(setJoins).catch(() => setJoins([]));
  }, [joinStatus]);

  const load = useCallback(() => {
    api<AdConfig>('/settings/ad').then(setCfg).catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    api<TelegramConfig>('/settings/telegram').then(setTgCfg).catch((e) => setTgError(e.message));
    api<{ botUsername: string | null; configured: boolean }>('/telegram/me')
      .then((b) => setTgBot({ botUsername: b.botUsername, configured: b.configured }))
      .catch(() => {});
    loadJoins();
    if (tab === 'telegram' || tab === 'joins') {
      api<PickUser[]>('/users?pageSize=100').then((r) => setJoinUsers((r as { items?: PickUser[] }).items ?? (r as unknown as PickUser[]))).catch(() => {});
      api<PickDriver[]>('/fleet/drivers').then(setJoinDrivers).catch(() => {});
    }
  }, [loadJoins, tab]);

  const saveTelegram = async () => {
    if (!tgCfg) return;
    setTgBusy(true); setTgMsg(''); setTgError('');
    try {
      const saved = await api<TelegramConfig>('/settings/telegram', {
        method: 'PATCH',
        body: { botToken: tgCfg.botToken.trim(), enabled: tgCfg.enabled },
      });
      setTgCfg(saved);
      setTgMsg('Telegram settings saved');
    } catch (e) {
      setTgError(e instanceof Error ? e.message : 'Failed to save Telegram settings');
    } finally {
      setTgBusy(false);
    }
  };

  const testTelegram = async () => {
    setTgTestResult(null);
    setTgBusy(true);
    try {
      setTgTestResult(await api<{ ok: boolean; error?: string }>('/settings/telegram/test', {
        method: 'POST',
        body: { chatId: tgTestChat.trim() },
      }));
    } catch (e) {
      setTgTestResult({ ok: false, error: e instanceof Error ? e.message : 'Test failed' });
    } finally {
      setTgBusy(false);
    }
  };

  const loadHolidays = useCallback(() => {
    setHolidays(null);
    setHolDirty(false);
    setHolMsg('');
    setHolError('');
    api<Holiday[]>(`/settings/holidays/${holYear}`)
      .then((list) => setHolidays(list))
      .catch((e) => setHolError(e instanceof Error ? e.message : 'Failed to load holidays'));
  }, [holYear]);

  useEffect(loadHolidays, [loadHolidays]);

  const updateHoliday = (idx: number, patch: Partial<Holiday>) => {
    setHolidays((list) => (list ?? []).map((h, i) => (i === idx ? { ...h, ...patch } : h)));
    setHolDirty(true);
  };

  const removeHoliday = (idx: number) => {
    setHolidays((list) => (list ?? []).filter((_, i) => i !== idx));
    setHolDirty(true);
  };

  const addHoliday = () => {
    if (!newHol.date || !newHol.name.trim()) return;
    if (holidays?.some((h) => h.date === newHol.date)) {
      setHolError(`${newHol.date} already exists`);
      return;
    }
    setHolidays([...(holidays ?? []), { date: newHol.date, name: newHol.name.trim() }].sort((a, b) => a.date.localeCompare(b.date)));
    setNewHol({ date: '', name: '' });
    setHolError('');
    setHolDirty(true);
  };

  /** Bulk-import holidays from pasted text — one per line, "YYYY-MM-DD Name" (comma/semicolon/tab also OK). */
  const importBulkHolidays = () => {
    setHolError('');
    const parsed: { date: string; name: string }[] = [];
    const skipped: string[] = [];
    for (const raw of bulkHol.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/(\d{4}-\d{2}-\d{2})[,;\t ]+(.+)/);
      if (!m) {
        skipped.push(line);
        continue;
      }
      const [, date, name] = m;
      if (Number(date.slice(0, 4)) !== holYear) {
        skipped.push(`${line} (not ${holYear})`);
        continue;
      }
      if ((holidays ?? []).some((h) => h.date === date) || parsed.some((p) => p.date === date)) {
        skipped.push(`${line} (duplicate)`);
        continue;
      }
      parsed.push({ date, name: name.trim() });
    }
    if (parsed.length) {
      setHolidays([...(holidays ?? []), ...parsed].sort((a, b) => a.date.localeCompare(b.date)));
      setHolDirty(true);
      toast(`Imported ${parsed.length} holiday${parsed.length === 1 ? '' : 's'}${skipped.length ? ` — ${skipped.length} line${skipped.length === 1 ? '' : 's'} skipped` : ''}`);
      setBulkHol('');
      setShowBulkHol(false);
    } else {
      toast('Nothing imported — check the date format', 'error');
    }
  };

  const saveHolidays = async () => {
    setHolBusy(true);
    setHolError('');
    setHolMsg('');
    try {
      const saved = await api<Holiday[]>(`/settings/holidays/${holYear}`, {
        method: 'PUT',
        body: { holidays: holidays ?? [] },
      });
      setHolidays(saved);
      setHolDirty(false);
      setHolMsg(`Holidays for ${holYear} saved ✓`);
      setTimeout(() => setHolMsg(''), 3000);
    } catch (e) {
      setHolError(e instanceof Error ? e.message : 'Failed to save holidays');
    } finally {
      setHolBusy(false);
    }
  };

  const save = async () => {
    if (!cfg) return;
    setError('');
    setMsg('');
    try {
      const saved = await api<AdConfig>('/settings/ad', { method: 'PATCH', body: cfg });
      setCfg(saved);
      setMsg('Settings saved ✓');
      setTimeout(() => setMsg(''), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    }
  };

  const test = async () => {
    if (!cfg) return;
    setError('');
    setTestResult(null);
    setTesting(true);
    try {
      const r = await api<{ ok: boolean; error?: string }>('/settings/ad/test', {
        method: 'POST',
        body: { url: cfg.url, baseDn: cfg.baseDn, bindDn: cfg.bindDn, bindPassword: cfg.bindPassword },
      });
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  if (!cfg) return <div>{error || 'Loading…'}</div>;

  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" subtitle="System modules — AD/LDAP directory login (Plan: LDAP-ready auth)" />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
      {msg && <div className="mb-4 text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">{msg}</div>}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {([
          { key: 'ad' as SettingsTab, label: 'AD / LDAP' },
          { key: 'holidays' as SettingsTab, label: 'Public Holidays' },
          { key: 'telegram' as SettingsTab, label: 'Telegram' },
          { key: 'joins' as SettingsTab, label: 'Telegram Joins' },
        ]).map((t) => (
          <button
            key={t.key}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors ${
              tab === t.key
                ? 'border-yellow-600 text-yellow-800 bg-yellow-50/60'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.key === 'joins' && joins && joins.length > 0 ? `${t.label} (${joins.length})` : t.label}
          </button>
        ))}
      </div>

      {tab === 'ad' && (
      <div className="bg-white rounded-xl border border-gray-200/80 shadow-card p-5 mb-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-800">Windows Active Directory (LDAP)</h2>
          <Badge color={cfg.enabled ? 'green' : 'gray'}>{cfg.enabled ? 'ENABLED' : 'DISABLED'}</Badge>
        </div>

        <p className="text-sm text-gray-500 mb-4">
          AD users sign in with their Windows account — AMS verifies the password against the directory and
          creates the local account automatically with the default role below. Roles (and therefore permissions)
          always come from AMS. Keep at least one LOCAL sysadmin so you can always sign in if the directory is down.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="block text-xs text-gray-500 mb-1">Server URL (ldaps://host:636 recommended)</label>
            <Input placeholder="ldaps://dc01.company.local:636" value={cfg.url} onChange={(e) => setCfg({ ...cfg, url: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Base DN</label>
            <Input placeholder="DC=company,DC=local" value={cfg.baseDn} onChange={(e) => setCfg({ ...cfg, baseDn: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Bind DN (read-only service account)</label>
            <Input placeholder="CN=ams-reader,CN=Users,DC=company,DC=local" value={cfg.bindDn} onChange={(e) => setCfg({ ...cfg, bindDn: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Bind password</label>
            <Input type="password" value={cfg.bindPassword} onChange={(e) => setCfg({ ...cfg, bindPassword: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Default role for new AD users</label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold/60 focus:border-gold"
              value={cfg.defaultRole}
              onChange={(e) => setCfg({ ...cfg, defaultRole: e.target.value })}
            >
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700 mt-4">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
            className="w-4 h-4 accent-yellow-600"
          />
          Enabled — allow AD accounts to sign in
        </label>

        {testResult && (
          <div className={`mt-3 text-sm rounded-lg px-3 py-2 ${testResult.ok ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'}`}>
            {testResult.ok ? '✓ Connection successful — service account can read the directory' : `✗ ${testResult.error}`}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={test} disabled={testing || !cfg.url || !cfg.bindDn}>
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          <Button onClick={save}>Save settings</Button>
        </div>
      </div>
      )}

      {/* ---------- Tab: Public Holidays editor ---------- */}
      {tab === 'holidays' && (
      <div className="bg-white rounded-xl border border-gray-200/80 shadow-card p-5 mb-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-semibold text-gray-800">Public Holidays</h2>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setHolYear(holYear - 1)}>←</Button>
            <select
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold/60 focus:border-gold"
              value={holYear}
              onChange={(e) => setHolYear(Number(e.target.value))}
            >
              {Array.from({ length: 6 }, (_, i) => now.getFullYear() - 1 + i).map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            <Button variant="ghost" onClick={() => setHolYear(holYear + 1)}>→</Button>
          </div>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          These dates tint weekends/holidays on the Meeting Rooms calendar and warn requesters who pick them.
          Myanmar fixed-date holidays are provided as defaults — lunar festivals (Thadingyut, Eid, Diwali…) move
          every year, so adjust the list when the gazette is announced. Saving replaces the whole list for the year.
        </p>

        {holError && <div className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{holError}</div>}
        {holMsg && <div className="mb-3 text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">{holMsg}</div>}

        {holidays === null ? (
          <div className="text-sm text-gray-400 py-4">Loading…</div>
        ) : (
          <>
            <table className="w-full text-sm mb-4">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-2 py-2 font-medium w-36">Date</th>
                  <th className="px-2 py-2 font-medium">Holiday name</th>
                  <th className="px-2 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {holidays.length === 0 && (
                  <tr><td colSpan={3} className="px-2 py-3 text-sm text-gray-400">No holidays configured for {holYear} — weekends only.</td></tr>
                )}
                {holidays.map((h, i) => {
                  const bad = !/^\d{4}-\d{2}-\d{2}$/.test(h.date) || !h.name.trim() || Number(h.date.slice(0, 4)) !== holYear;
                  return (
                    <tr key={i} className={bad ? 'bg-red-50' : ''}>
                      <td className="px-2 py-1.5">
                        <Input type="date" value={h.date} onChange={(e) => updateHoliday(i, { date: e.target.value })} />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input value={h.name} onChange={(e) => updateHoliday(i, { name: e.target.value })} />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button className="text-red-600 hover:underline" onClick={() => removeHoliday(i)}>Remove</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="flex flex-wrap items-end gap-2 mb-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Add date</label>
                <Input type="date" value={newHol.date} onChange={(e) => setNewHol({ ...newHol, date: e.target.value })} />
              </div>
              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs text-gray-500 mb-1">Holiday name</label>
                <Input placeholder="e.g. Thadingyut holiday" value={newHol.name} onChange={(e) => setNewHol({ ...newHol, name: e.target.value })} />
              </div>
              <Button variant="ghost" onClick={addHoliday} disabled={!newHol.date || !newHol.name.trim()}>+ Add</Button>
              <Button variant="ghost" onClick={() => { setShowBulkHol(true); setBulkHol(''); }}>📋 Bulk import</Button>
            </div>

            {showBulkHol && (
              <Modal title={`Bulk import holidays — ${holYear}`} onClose={() => setShowBulkHol(false)}>
                <div className="space-y-3">
                  <p className="text-sm text-gray-600">
                    Paste one holiday per line — <code className="bg-gray-100 rounded px-1">YYYY-MM-DD Name</code>
                    {' '}(comma, semicolon or tab also work). Lines that are not in {holYear} or duplicate existing dates are skipped.
                  </p>
                  <textarea
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gold/60 focus:border-gold"
                    rows={8}
                    placeholder={`2026-10-25 Thadingyut holiday\n2026-10-26 Thadingyut holiday\n2026-11-11 Full Moon Day of Tazaungmone`}
                    value={bulkHol}
                    onChange={(e) => setBulkHol(e.target.value)}
                    autoFocus
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setShowBulkHol(false)}>Cancel</Button>
                    <Button onClick={importBulkHolidays} disabled={!bulkHol.trim()}>Import into list</Button>
                  </div>
                </div>
              </Modal>
            )}

            <div className="flex justify-end items-center gap-3">
              {holDirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
              <Button variant="ghost" onClick={loadHolidays} disabled={!holDirty || holBusy}>Reset</Button>
              <Button onClick={saveHolidays} disabled={!holDirty || holBusy}>{holBusy ? 'Saving…' : `Save ${holYear} holidays`}</Button>
            </div>
          </>
        )}
      </div>
      )}

      {/* ---------- Tab: Telegram Joins (draft → approve → re-assign) ---------- */}
      {tab === 'joins' && (
      <div className="bg-white rounded-xl border border-gray-200/80 shadow-card p-5 mb-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-gray-800">Telegram — Join Requests</h2>
          <Button variant="ghost" onClick={loadJoins}>↻ Refresh</Button>
        </div>
        <p className="text-sm text-gray-500 mb-3">
          Anyone who opens <b>{tgBot?.botUsername ? `@${tgBot.botUsername}` : 'the AMS bot'}</b> in Telegram and sends /start lands here as a draft.
          Approve to link their chat to a system user (or a driver) — until then they receive nothing.
          Made a wrong link? Open <b>Approved</b> and re-assign the chat to the right account — the previous holder is freed automatically.
        </p>
        <div className="flex gap-1 mb-4">
          {(['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as const).map((s) => (
            <button
              key={s}
              className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                joinStatus === s ? 'bg-yellow-50 border-yellow-300 text-yellow-800' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}
              onClick={() => setJoinStatus(s)}
            >
              {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
        {joinError && <div className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{joinError}</div>}
        {joinMsg && <div className="mb-3 text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">{joinMsg}</div>}
        {joins && joins.length === 0 && (
          <div className="text-sm text-gray-400">
            {joinStatus === 'PENDING' ? 'No pending join requests. (Users appear here after they send /start to the bot.)' : joinStatus === 'ALL' ? 'No join requests recorded yet.' : `No ${joinStatus.toLowerCase()} join requests.`}
          </div>
        )}
        {joins && joins.length > 0 && (
          <div className="space-y-3">
            {joins.map((j) => {
              // smart default: pre-pick the account matching the Telegram @username or display name
              const pick = joinPick[j.id] ?? (() => {
                const uname = (j.tgUsername ?? '').trim().toLowerCase();
                const nm = (j.displayName ?? '').trim().toLowerCase();
                const free = (chat: string | null | undefined) => !chat || chat === j.chatId;
                const u = joinUsers.find((x) => (uname ? x.username.toLowerCase() === uname : false) && free(x.telegramChatId))
                  ?? joinUsers.find((x) => (nm ? x.fullName.toLowerCase() === nm : false) && free(x.telegramChatId));
                if (u) return { kind: 'user' as const, id: u.id };
                const d = joinDrivers.find((x) => (uname ? (x.telegramUsername ?? '').toLowerCase() === uname : false) && free(x.telegramChatId))
                  ?? joinDrivers.find((x) => (nm ? x.name.toLowerCase() === nm : false) && free(x.telegramChatId));
                if (d) return { kind: 'driver' as const, id: d.id };
                return { kind: 'user' as const, id: '' };
              })();
              const autoPicked = !joinPick[j.id] && !!pick.id; // shown unless the user overrides
              const editing = !!joinEditing[j.id]; // pickers stay hidden until the admin clicks Assign / Re-assign
              const same = !!j.bound && j.bound.kind === pick.kind && j.bound.id === pick.id;
              const isReassign = j.status === 'APPROVED';
              // an account that already owns ANOTHER chat — offering it would fail at approve-time
              const userTaken = (u: PickUser) => !!u.telegramChatId && u.telegramChatId !== j.chatId;
              const driverTaken = (d: PickDriver) => !!d.telegramChatId && d.telegramChatId !== j.chatId;
              const roleLabel = (u: PickUser) => (u.userRoles?.length ? u.userRoles.map((r) => r.role.name.replace(/_/g, ' ')).join(', ') : 'no role');
              const pickError = (() => {
                if (!pick.id) return null;
                if (pick.kind === 'user') {
                  const u = joinUsers.find((x) => x.id === pick.id);
                  if (u && userTaken(u)) return 'already linked to another chat — pick someone else or unbind them first';
                  if (u && u.status && u.status !== 'ACTIVE') return 'user is not ACTIVE';
                } else {
                  const d = joinDrivers.find((x) => x.id === pick.id);
                  if (d && driverTaken(d)) return 'already linked to another chat — pick another driver or unbind first';
                }
                return null;
              })();
              return (
                <div key={j.id} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="text-sm">
                      <span className="font-medium">{j.displayName ?? 'Unknown'}</span>
                      {j.tgUsername && <span className="text-gray-500"> · @{j.tgUsername}</span>}
                      <span className="text-gray-400 text-xs ml-2" title={j.chatId}>
                        {j.status === 'PENDING' ? '⏳ ' : ''}requested {new Date(j.createdAt).toLocaleString()}
                      </span>
                      <span className="text-gray-300 text-[10px] ml-1 font-mono select-all" title="Telegram chat id">{j.chatId}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        j.status === 'APPROVED' ? 'bg-green-100 text-green-700' : j.status === 'REJECTED' ? 'bg-gray-200 text-gray-500' : 'bg-yellow-100 text-yellow-800'
                      }`}>{j.status}</span>
                      <button
                        className="text-xs text-blue-600 hover:underline"
                        onClick={async () => {
                          setHistChat({ chatId: j.chatId, name: j.displayName ?? j.chatId });
                          setHistRows(null);
                          setHistError('');
                          try {
                            setHistRows(await api<ChatHistoryRow[]>(`/settings/telegram/chats/${j.chatId}/history`));
                          } catch (e) {
                            setHistError(e instanceof Error ? e.message : 'History failed');
                            setHistChat(null);
                          }
                        }}
                      >History</button>
                    </div>
                  </div>
                  {j.status === 'APPROVED' && j.bound && (
                    <div className="text-xs text-gray-600 mb-2">
                      Linked to: <b>{j.bound.name}</b> ({j.bound.kind === 'driver' ? 'Driver' : 'System user'})
                      {j.bound.telegramUsername ? <span className="text-gray-400"> · recorded @{j.bound.telegramUsername}</span> : null}
                    </div>
                  )}
                  {j.status === 'REJECTED' && (
                    <div className="text-xs text-gray-500 mb-2">Rejected — they can send /start again any time to re-open their request.</div>
                  )}
                  {j.status !== 'REJECTED' && (
                  <div className="space-y-2">
                  {!editing && (
                  <>
                  {j.status === 'APPROVED' && j.bound && (
                    <div className="flex flex-wrap gap-2 items-center">
                      <button
                        className="text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg px-3 py-1.5 transition-colors"
                        onClick={() => setJoinEditing({ ...joinEditing, [j.id]: true })}
                      >
                        ✏️ Re-assign this chat…
                      </button>
                      <button
                        className="text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg px-3 py-1.5 transition-colors"
                        onClick={async () => {
                          setJoinError(''); setJoinMsg('');
                          if (!window.confirm(`Unbind ${j.displayName ?? j.chatId} from ${j.bound?.name ?? 'its account'}? They will be notified in Telegram, and the join goes back to Pending.`)) return;
                          try {
                            const res = await api<{ unbound: string }>(`/settings/telegram/joins/${j.id}/unbind`, { method: 'POST' });
                            setJoinMsg(`Unbound — released from ${res.unbound}. The join is back in Pending.`);
                            loadJoins();
                          } catch (e) {
                            setJoinError(e instanceof Error ? e.message : 'Unbind failed');
                          }
                        }}
                      >
                        🔓 Unbind
                      </button>
                    </div>
                  )}
                  {j.status === 'PENDING' && (
                    <button
                      className="text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg px-3 py-1.5 transition-colors"
                      onClick={() => setJoinEditing({ ...joinEditing, [j.id]: true })}
                    >
                      {pick.id
                        ? `🔗 Assign to ${pick.kind === 'user' ? joinUsers.find((u) => u.id === pick.id)?.fullName : joinDrivers.find((d) => d.id === pick.id)?.name}…`
                        : '🔗 Assign to system…'}
                    </button>
                  )}
                  </>
                  )}
                  {editing && (
                  <>
                    <div className="flex flex-wrap gap-2 items-center">
                      <select
                        className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white"
                        value={pick.kind}
                        onChange={(e) => setJoinPick({ ...joinPick, [j.id]: { ...pick, kind: e.target.value as 'user' | 'driver', id: '' } })}
                      >
                        <option value="user">System user</option>
                        <option value="driver">Driver</option>
                      </select>
                      {pick.kind === 'user' ? (
                        <select
                          className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white min-w-[260px]"
                          value={pick.id}
                          onChange={(e) => setJoinPick({ ...joinPick, [j.id]: { ...pick, id: e.target.value } })}
                        >
                          <option value="">— Pick user —</option>
                          {joinUsers.map((u) => (
                            <option key={u.id} value={u.id} disabled={userTaken(u)}>
                              {u.fullName} ({u.username}){u.userRoles?.length ? ` · ${roleLabel(u)}` : ''}{userTaken(u) ? ' · already linked' : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <select
                          className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white min-w-[260px]"
                          value={pick.id}
                          onChange={(e) => setJoinPick({ ...joinPick, [j.id]: { ...pick, id: e.target.value } })}
                        >
                          <option value="">— Pick driver —</option>
                          {joinDrivers.map((d) => (
                            <option key={d.id} value={d.id} disabled={driverTaken(d)}>
                              {d.name}{d.vehicles?.length ? ` · ${d.vehicles.map((v) => v.vehicleNo).join(', ')}` : ''}{driverTaken(d) ? ' · already linked' : ''}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    {pickError && (
                      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">⚠️ {pickError}</div>
                    )}
                    {autoPicked && !pickError && (
                      <div className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                        💡 Pre-picked from the Telegram name — confirm it is the right person, then Approve.
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2 items-center">
                      <Button
                        disabled={!pick.id || same || !!pickError}
                        onClick={async () => {
                          setJoinError(''); setJoinMsg('');
                          const body = pick.kind === 'user' ? { userId: pick.id } : { driverId: pick.id };
                          const targetName = pick.kind === 'user' ? joinUsers.find((u) => u.id === pick.id)?.fullName : joinDrivers.find((d) => d.id === pick.id)?.name;
                          try {
                            const res = await api<{ moved?: string | null; to?: string }>(
                              isReassign ? `/settings/telegram/joins/${j.id}/reassign` : `/settings/telegram/joins/${j.id}/approve`,
                              { method: 'POST', body },
                            );
                            setJoinMsg(isReassign
                              ? `Re-assigned to ${res.to ?? targetName}${res.moved ? ` — moved from ${res.moved}` : ''}.`
                              : `Approved — linked to ${targetName}`);
                            loadJoins();
                          } catch (e) {
                            setJoinError(e instanceof Error ? e.message : (isReassign ? 'Re-assign failed' : 'Approve failed'));
                          }
                        }}
                      >
                        {isReassign ? 'Re-assign' : 'Approve & link'}
                      </Button>
                      {j.status !== 'APPROVED' && (
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          setJoinError(''); setJoinMsg('');
                          try {
                            await api(`/settings/telegram/joins/${j.id}/reject`, { method: 'POST' });
                            setJoinMsg('Request rejected.');
                            loadJoins();
                          } catch (e) {
                            setJoinError(e instanceof Error ? e.message : 'Reject failed');
                          }
                        }}
                      >
                        Reject
                      </Button>
                      )}
                    </div>
                  </>
                  )}
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {histChat && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setHistChat(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[85vh] overflow-auto p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-800">Bind history — {histChat.name} <span className="text-gray-400 font-normal text-sm">chat {histChat.chatId}</span></h3>
              <Button variant="ghost" onClick={() => setHistChat(null)}>✕</Button>
            </div>
            {histError && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{histError}</div>}
            {histRows && histRows.length === 0 && <Empty label="No binding events recorded for this chat yet" />}
            {histRows && histRows.length > 0 && (() => {
              const rows = [...histRows].reverse(); // newest first — the modal answers "what changed recently?"
              const first = histRows[0]; // oldest (backend orders ascending)
              const last = histRows[histRows.length - 1];
              return (
                <div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 mb-4">
                    <span className="font-medium text-gray-700">🗂 {histRows.length} event{histRows.length === 1 ? '' : 's'}</span>
                    <span>· first seen {new Date(first.at).toLocaleDateString()}</span>
                    <span>· last change {relTime(last.at)}</span>
                  </div>
                  <ol className="relative ml-2 border-l-2 border-gray-100">
                    {rows.map((r, i) => {
                      const st = EVENT_STYLE[r.action] ?? { icon: '•', tone: 'gray' as const };
                      return (
                        <li key={i} className="relative ml-4 pb-4 last:pb-0">
                          <span className={`absolute -left-[27px] top-1 flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs ${TONE_RING[st.tone]}`}>{st.icon}</span>
                          <div className={`bg-white border border-gray-200 border-l-4 rounded-lg px-3 py-2 shadow-sm ${TONE_CARD[st.tone]}`}>
                            <div className="flex flex-wrap items-center justify-between gap-x-2">
                              <div className="text-sm font-medium text-gray-800">
                                {r.label}
                                {i === 0 && rows.length > 1 && (
                                  <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-yellow-800 bg-yellow-100 border border-yellow-200 rounded-full px-2 py-0.5">Latest</span>
                                )}
                              </div>
                              <span className="text-xs text-gray-500 whitespace-nowrap" title={new Date(r.at).toLocaleString()}>{relTime(r.at)}</span>
                            </div>
                            <div className="text-xs text-gray-400 mt-1 flex flex-wrap items-center gap-x-2">
                              <span title={new Date(r.at).toLocaleString()}>{new Date(r.at).toLocaleString()}</span>
                              <span>·</span>
                              <span>by {r.by}</span>
                            </div>
                            {r.account && (
                              <div className="mt-1.5">
                                <span className="inline-block text-xs font-medium text-gray-700 bg-gray-100 border border-gray-200 rounded-full px-2 py-0.5">👤 {r.account}</span>
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              );
            })()}
          </div>
        </div>
        )}
      </div>
      )}

      {/* ---------- Tab: Telegram (bot config) ---------- */}
      {tab === 'telegram' && tgCfg && (
      <>
      <div className="bg-white rounded-xl border border-gray-200/80 shadow-card p-5 mb-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-800">Telegram — Driver Notifications</h2>
          <Badge color={tgCfg.enabled && tgCfg.botToken ? 'green' : 'gray'}>{tgCfg.enabled && tgCfg.botToken ? 'ENABLED' : 'DISABLED'}</Badge>
        </div>

        <p className="text-sm text-gray-500 mb-4">
          Drivers receive car assignments in Telegram and acknowledge with <b>✓ Noted</b>, <b>📍 Arrived</b> and
          <b> 🏁 Back at Office</b> buttons. Administration and requesters see the acknowledgments in AMS.
          Create the bot with @BotFather, paste the token here, then link each driver from Fleet → Drivers.
          Until a token is set, the feature stays silently off — car assignments are unaffected.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="block text-xs text-gray-500 mb-1">Bot token (from @BotFather)</label>
            <Input
              type="password"
              placeholder="123456789:AAF..."
              value={tgCfg.botToken}
              onChange={(e) => setTgCfg({ ...tgCfg, botToken: e.target.value })}
            />
            {tgBot && (
              <div className="mt-1 text-xs text-gray-500">
                {tgBot.botUsername
                  ? <>Connected bot: <a className="text-blue-600 underline" href={`https://t.me/${tgBot.botUsername}`} target="_blank" rel="noreferrer">@{tgBot.botUsername}</a> — users link their chat from My Profile → Telegram.</>
                  : tgBot.configured ? 'Token set — bot identity will appear once Telegram is reachable.' : 'No token set — the feature stays off until configured.'}
              </div>
            )}
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs text-gray-500 mb-1">AMS web URL (for "Open in AMS" buttons in notifications — optional)</label>
            <Input
              placeholder="http://192.168.100.110:8080"
              value={tgCfg.webUrl}
              onChange={(e) => setTgCfg({ ...tgCfg, webUrl: e.target.value })}
            />
            <div className="mt-1 text-xs text-gray-500">
              Set this to the address users type in their browser — Telegram notifications then get an
              <b> Open in AMS</b> button that jumps straight to the related request.
            </div>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700 mt-4">
          <input
            type="checkbox"
            checked={tgCfg.enabled}
            onChange={(e) => setTgCfg({ ...tgCfg, enabled: e.target.checked })}
            className="w-4 h-4 accent-yellow-600"
          />
          Enabled — send assignments to drivers via Telegram
        </label>

        <div className="mt-4 border-t border-gray-100 pt-4">
          <label className="block text-xs text-gray-500 mb-1">Send test message — chat ID (get yours from @userinfobot)</label>
          <div className="flex gap-2">
            <Input
              className="flex-1"
              placeholder="e.g. 123456789"
              value={tgTestChat}
              onChange={(e) => setTgTestChat(e.target.value)}
            />
            <Button variant="ghost" onClick={testTelegram} disabled={tgBusy || !tgTestChat.trim()}>Send test</Button>
          </div>
          {tgTestResult && (
            <div className={`mt-2 text-sm rounded-lg px-3 py-2 ${tgTestResult.ok ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'}`}>
              {tgTestResult.ok ? '✓ Test message sent — check Telegram' : `✗ ${tgTestResult.error}`}
            </div>
          )}
        </div>

        {tgMsg && <div className="mt-3 text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">{tgMsg}</div>}
        {tgError && <div className="mt-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{tgError}</div>}

        <div className="flex justify-end mt-4">
          <Button onClick={saveTelegram} disabled={tgBusy}>{tgBusy ? 'Saving…' : 'Save settings'}</Button>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
