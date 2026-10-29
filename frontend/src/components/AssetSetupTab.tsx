import { useCallback, useEffect, useState } from 'react';
import { api, hasPermission } from '../api';
import { Button, Card, Empty, Input, Table } from './ui';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * "Asset Setup (New)" tab of /asset-register — full CRUD over the three master
 * lists the register reads: CATEGORY (also seeds the auto asset code),
 * LOCATION and CUSTODIAN. Every list is a flat {id,name} table served by
 * /assets/<kind>; the parent's filter/form dropdowns are refreshed through
 * `onChanged` so a rename is visible without a reload.
 */

export type SetupKind = 'categories' | 'locations' | 'custodians';

interface SetupRow {
  id: string;
  name: string;
  /** rows referencing this entry (assets / movements / receipts) — blocks delete */
  usage: number;
}

const SECTIONS: { kind: SetupKind; title: string; hint: string }[] = [
  {
    kind: 'categories',
    title: 'Category',
    hint: 'Feeds the register filter and the auto asset code — "IT Equipment" → AST-ITE-YYYYMM-0001.',
  },
  {
    kind: 'locations',
    title: 'Location',
    hint: 'Where assets are kept. Used by the filter, the asset form and every transfer.',
  },
  {
    kind: 'custodians',
    title: 'Custodian',
    hint: 'People / departments taking custody — offered by the asset form and transfer dialog.',
  },
];

const errText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export function AssetSetupTab({ onChanged }: { onChanged?: () => void }) {
  const canManage = hasPermission('assets.manage');
  const [rows, setRows] = useState<Record<SetupKind, SetupRow[]>>({
    categories: [], locations: [], custodians: [],
  });
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<SetupKind, string>>({
    categories: '', locations: '', custodians: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ kind: SetupKind; row: SetupRow } | null>(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ kind: SetupKind; row: SetupRow } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [categories, locations, custodians] = await Promise.all([
        api<SetupRow[]>('/assets/categories'),
        api<SetupRow[]>('/assets/locations'),
        api<SetupRow[]>('/assets/custodians'),
      ]);
      setRows({ categories, locations, custodians });
    } catch (e) {
      setError(errText(e, 'Failed to load setup lists'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = async (kind: SetupKind) => {
    const name = drafts[kind].trim();
    if (!name) return;
    setError(null);
    try {
      await api(`/assets/${kind}`, { method: 'POST', body: { name } });
      setDrafts((d) => ({ ...d, [kind]: '' }));
      await load();
      onChanged?.();
    } catch (e) {
      // duplicate name → 409; shown above the section so the typed value survives
      setError(errText(e, 'Failed to add entry'));
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const name = editName.trim();
    if (!name) return;
    setEditError(null);
    try {
      await api(`/assets/${editing.kind}/${editing.row.id}`, { method: 'PATCH', body: { name } });
      setEditing(null);
      await load();
      onChanged?.();
    } catch (e) {
      // keep the dialog open — a 409 must never look like a silent no-op save
      setEditError(errText(e, 'Failed to save'));
    }
  };

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        Master data behind the register dropdowns. Entries still in use cannot be deleted — reassign them first.
      </p>

      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>
      )}

      {SECTIONS.map(({ kind, title, hint }) => (
        <div key={kind} className="mb-6">
          <Card className="p-4 mb-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">{title}</h2>
                <p className="text-xs text-gray-400 mt-0.5">{hint}</p>
              </div>
              {canManage && (
                <div className="flex gap-2 shrink-0">
                  <Input
                    className="!w-56"
                    placeholder={`New ${title.toLowerCase()} name`}
                    value={drafts[kind]}
                    onChange={(e) => setDrafts((d) => ({ ...d, [kind]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') void add(kind); }}
                  />
                  <Button disabled={!drafts[kind].trim()} onClick={() => void add(kind)}>+ Add</Button>
                </div>
              )}
            </div>
          </Card>

          <Table head={['NAME', 'USED BY', 'ACTIONS']}>
            {loading ? (
              <tr><td colSpan={3}><Empty label="Loading…" /></td></tr>
            ) : rows[kind].length === 0 ? (
              <tr><td colSpan={3}><Empty label={`No ${title.toLowerCase()} entries yet`} /></td></tr>
            ) : rows[kind].map((row) => (
              <tr key={row.id} className="hover:bg-gray-50/60">
                <td className="px-4 py-2.5 font-medium text-gray-900">{row.name}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-gray-500">{row.usage}</td>
                <td className="px-4 py-2.5 text-center">
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {canManage ? (
                      <>
                        <Button
                          variant="ghost"
                          onClick={() => { setEditing({ kind, row }); setEditName(row.name); setEditError(null); }}
                        >
                          Rename
                        </Button>
                        <Button variant="danger" onClick={() => setDeleting({ kind, row })}>Delete</Button>
                      </>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </div>
      ))}

      {editing && (
        <Modal
          title={`Rename ${editing.kind.slice(0, -1)} — ${editing.row.name}`}
          onClose={() => setEditing(null)}
          error={editError ?? undefined}
        >
          <label className="block text-xs font-medium text-gray-500 mb-1">Name *</label>
          <Input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit(); }}
          />
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={!editName.trim()} onClick={() => void saveEdit()}>Save</Button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.row.name}?`}
          description={
            deleting.row.usage > 0
              ? `Still referenced by ${deleting.row.usage} record(s) — reassign those first; the API refuses to delete it.`
              : `Removes it from the dropdown. Nothing references it, so the delete is safe.`
          }
          variant="danger"
          confirmLabel="Delete"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/assets/${deleting.kind}/${deleting.row.id}`, { method: 'DELETE' });
            setDeleting(null);
            await load();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}
