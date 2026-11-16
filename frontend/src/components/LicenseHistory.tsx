import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtDateTime } from '../util/yangonTime';

interface Change {
  label: string;
  from: string | null;
  to: string | null;
}

interface Entry {
  id: string;
  action: string;
  at: string;
  username: string | null;
  changes: Change[];
}

/**
 * Renewal history of one licence, read straight from the audit trail: every
 * entry that moved the registration number or the due date, with the person
 * who moved it. Read-only — nothing is stored a second time.
 */
export function LicenseHistory({ licenseId }: { licenseId: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api<Entry[]>(`/licenses/${licenseId}/history`)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load the history');
        setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [licenseId]);

  return (
    <section aria-label="Renewal history">
      <h3 className="mb-2 text-sm font-semibold text-gray-800">🕘 Renewal history</h3>
      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
      {entries === null ? (
        <p className="text-xs text-gray-400">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-200 px-3 py-3 text-center text-xs text-gray-400">
          No renewal recorded yet — a change to the registration number or the due date is listed here.
        </p>
      ) : (
        <ol className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
                <span className="font-medium text-gray-700">
                  {entry.action === 'LICENSE_CREATED' ? 'License added' : 'Renewed'}
                </span>
                <span className="text-gray-500">
                  {entry.username ?? 'system'} · {fmtDateTime(entry.at)}
                </span>
              </div>
              <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
                {entry.changes.map((change) => (
                  <li key={change.label}>
                    <span className="text-gray-500">{change.label}:</span>{' '}
                    <span className="font-mono text-gray-500">{change.from ?? '—'}</span>{' '}
                    <span aria-hidden="true" className="text-gray-400">→</span>{' '}
                    <span className="font-mono font-medium text-gray-800">{change.to ?? '—'}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
