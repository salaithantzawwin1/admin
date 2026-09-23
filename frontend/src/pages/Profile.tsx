import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, getUser } from '../api';
import { Badge, Button, Card, Input, PageHeader } from '../components/ui';

interface TgBinding {
  telegramChatId: string | null;
  telegramBindCode: string | null;
  telegramUsername: string | null;
  botUsername: string | null;
  configured: boolean;
}

export default function Profile() {
  const stored = getUser();
  const [me, setMe] = useState<{ username: string; fullName: string; email?: string; roles: string[]; lastLoginAt?: string } | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  // ---------- Telegram binding ----------
  const [tg, setTg] = useState<TgBinding | null>(null);
  const [tgMsg, setTgMsg] = useState('');
  const [tgError, setTgError] = useState('');

  const loadTg = useCallback(() => {
    api<TgBinding>('/telegram/me').then(setTg).catch(() => setTg(null));
  }, []);

  useEffect(() => {
    api<typeof me>('/auth/me').then(setMe).catch(() => {});
    loadTg();
  }, [loadTg]);

  const generateTgCode = async () => {
    setTgMsg(''); setTgError('');
    try {
      await api<{ code: string }>('/telegram/bind-code', { method: 'POST' });
      setTgMsg('Code generated — send it to the bot within 7 days.');
      loadTg();
    } catch (err) {
      setTgError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const unbindTg = async () => {
    setTgMsg(''); setTgError('');
    try {
      await api('/telegram/bind', { method: 'DELETE' });
      setTgMsg('Telegram unlinked.');
      loadTg();
    } catch (err) {
      setTgError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setMsg('');
    setError('');
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setMsg('Password changed successfully.');
      setCurrent('');
      setNext('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  return (
    <div className="max-w-2xl">
      <PageHeader title="My Profile" />

      <Card className="p-5 mb-5">
        <div className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-gray-500">Username</span><span className="font-medium">{me?.username ?? stored?.username}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Full name</span><span className="font-medium">{me?.fullName ?? stored?.fullName}</span></div>
          <div className="flex justify-between">
            <span className="text-gray-500">Roles</span>
            <span className="flex gap-1">
              {(me?.roles ?? stored?.roles ?? []).map((r) => (
                <Badge key={r} color="blue">{r}</Badge>
              ))}
            </span>
          </div>
          {me?.lastLoginAt && (
            <div className="flex justify-between"><span className="text-gray-500">Last login</span><span>{new Date(me.lastLoginAt).toLocaleString()}</span></div>
          )}
        </div>
      </Card>

      <Card className="p-5 mb-5">
        <h2 className="font-semibold text-gray-800 mb-2">Telegram</h2>
        <p className="text-sm text-gray-500 mb-3">
          Link your Telegram account to receive AMS notifications — approvals, car assignments,
          meeting alerts and more — directly in Telegram.
        </p>
        {tg?.telegramChatId ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-green-700 font-medium">✓ Linked</span>
              {tg.telegramUsername && <span className="text-gray-500">as @{tg.telegramUsername}</span>}
            </div>
            <Button variant="ghost" onClick={unbindTg}>Unlink Telegram</Button>
          </div>
        ) : (
          <div className="space-y-3">
            {tg?.telegramBindCode ? (
              <>
                <div className="text-sm text-gray-600">
                  Open <a className="text-blue-600 underline" href={tg.botUsername ? `https://t.me/${tg.botUsername}` : '#'} target="_blank" rel="noreferrer">{tg.botUsername ? `@${tg.botUsername}` : 'the AMS bot'}</a> in Telegram and send:
                </div>
                <div className="text-center font-mono font-bold tracking-widest text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-lg py-2.5">
                  /start {tg.telegramBindCode}
                </div>
                <div className="text-xs text-gray-400">The code expires in 7 days. This page updates after the bot confirms.</div>
              </>
            ) : (
              <Button onClick={generateTgCode} disabled={tg != null && !tg.configured}>
                Link Telegram
              </Button>
            )}
            {tg != null && !tg.configured && (
              <div className="text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                Telegram is not configured yet — ask the System Admin to set the bot token in Settings → Telegram.
              </div>
            )}
          </div>
        )}
        {tgMsg && <div className="mt-3 text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">{tgMsg}</div>}
        {tgError && <div className="mt-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{tgError}</div>}
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold text-gray-800 mb-4">Change Password</h2>
        {msg && <div className="mb-3 text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">{msg}</div>}
        {error && <div className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
        <form onSubmit={changePassword} className="space-y-3">
          <Input type="password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <Input type="password" placeholder="New password (min 8)" value={next} onChange={(e) => setNext(e.target.value)} />
          <Button type="submit" disabled={!current || next.length < 8}>Update Password</Button>
        </form>
      </Card>
    </div>
  );
}
