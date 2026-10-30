import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, hasPermission } from '../api';
import { Button, Card, Empty, Input, Table } from './ui';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { toast } from './Toast';

/**
 * "Asset Setup (New)" tab of /asset-register — full CRUD over the three master
 * lists the register reads: CATEGORY (also seeds the auto asset code),
 * LOCATION and CUSTODIAN, each behind its own sub-tab (?tab=setup&sub=location,
 * same URL-driven convention as Inventory's management sub-tabs).
 *
 * Every list is a flat {id,name} table served by /assets/<kind>; the parent's
 * filter/form dropdowns are refreshed through `onChanged` so a rename shows up
 * without a reload. All three lists load together so the sub-tab counts stay
 * true while you work in one of them.
 *
 * UI/UX decisions (kept deliberately small):
 *  - active sub-tab lives in the URL → refresh / back / shared links keep it
 *  - rows sorted A→Z and searchable, because these lists only ever grow
 *  - a duplicate name is caught locally before the round-trip (409 still wins
 *    as the source of truth when two admins race)
 *  - Delete stays clickable but explains why when the entry is in use — a
 *    silently disabled button just reads as a broken UI
 */

export type SetupKind = 'categories' | 'locations' | 'custodians';

interface SetupRow {
  id: string;
  name: string;
  /** rows referencing this entry (assets / movements / receipts) — blocks delete */
  usage: number;
}

interface Section {
  kind: SetupKind;
  /** ?sub= value — singular, so URLs read ?tab=setup&sub=location */
  param: string;
  label: string;
  /** heading plural — "Category" + "s" would read CATEGORYS */
  plural: string;
  hint: string;
  placeholder: string;
  empty: string;
  /** shown in the rename dialog — what a rename does and does not touch */
  renameNote: string;
}

const SECTIONS: Section[] = [
  {
    kind: 'categories',
    param: 'category',
    label: 'Category',
    plural: 'Categories',
    hint: 'Drives the register filter and the auto asset code — "IT Equipment" becomes AST-ITE-202610-0001.',
    placeholder: 'e.g. Office Equipment',
    empty: 'No categories yet — add the first one above.',
    renameNote: 'Assets already registered keep their current code; the new name seeds codes from now on.',
  },
  {
    kind: 'locations',
    param: 'location',
    label: 'Location',
    plural: 'Locations',
    hint: 'Where assets are kept. Used by the register filter, the asset form and every transfer.',
    placeholder: 'e.g. Head Office — Yangon',
    empty: 'No locations yet — add the first one above.',
    renameNote: 'Assets, transfers and receipts keep pointing at it — only the label changes.',
  },
  {
    kind: 'custodians',
    param: 'custodian',
    label: 'Custodian',
    plural: 'Custodians',
    hint: 'People / departments taking custody — offered by the asset form and the transfer dialog.',
    placeholder: 'e.g. U Aung — Finance',
    empty: 'No custodians yet — add the first one above.',
    renameNote: 'Assets already showing this custodian keep it; new picks use the new name.',
  },
];

const sectionOf = (kind: SetupKind) => SECTIONS.find((s) => s.kind === kind) ?? SECTIONS[0];
const errText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** Mirrors assets.service.ts autoPrefix: first three A-Z/0-9 chars of the name.
 *  Kept in lockstep so the row can show the code segment a category will mint. */
const codeSeg = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);

export function AssetSetupTab({ onChanged }: { onChanged?: () => void }) {
  const canManage = hasPermission('assets.manage');
  // active sub-tab lives in the URL — refresh / back / shared links keep it
  const [searchParams, setSearchParams] = useSearchParams();
  const active: SetupKind =
    searchParams.get('sub') === 'location' ? 'locations'
      : searchParams.get('sub') === 'custodian' ? 'custodians'
      : 'categories';
  const setActive = (kind: SetupKind) =>
    setSearchParams(
      { tab: 'setup', ...(kind === 'categories' ? {} : { sub: sectionOf(kind).param }) },
      { replace: false },
    );
  const section = sectionOf(active);

  const [rows, setRows] = useState<Record<SetupKind, SetupRow[]>>({
    categories: [], locations: [], custodians: [],
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<SetupKind | null>(null);
  const [drafts, setDrafts] = useState<Record<SetupKind, string>>({
    categories: '', locations: '', custodians: '',
  });
  // search box — scoped to the active sub-tab, cleared when switching so a
  // forgotten filter never looks like missing data on the next list
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ kind: SetupKind; row: SetupRow } | null>(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ kind: SetupKind; row: SetupRow } | null>(null);

  useEffect(() => { setQ(''); }, [active]);

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

  // sorted A→Z + filtered by the search box; counts on the pills stay unfiltered
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? rows[active].filter((r) => r.name.toLowerCase().includes(needle))
      : rows[active];
    return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [rows, active, q]);

  const add = async () => {
    const name = drafts[active].trim();
    if (!name || busy) return;
    setError(null);
    // instant feedback for the common typo-duplicate; the API 409 still wins
    if (rows[active].some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      setError(`${section.label} "${name}" already exists in this list.`);
      return;
    }
    setBusy(active);
    try {
      await api(`/assets/${active}`, { method: 'POST', body: { name } });
      setDrafts((d) => ({ ...d, [active]: '' }));
      await load();
      onChanged?.();
      toast(`${section.label} "${name}" added`);
      // focus stays in the field — adding a batch is one Enter per row
    } catch (e) {
      // duplicate name → 409; the typed value survives so it can be edited
      setError(errText(e, 'Failed to add entry'));
    } finally {
      setBusy(null);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const name = editName.trim();
    if (!name) return;
    setEditError(null);
    setBusy(editing.kind);
    try {
      await api(`/assets/${editing.kind}/${editing.row.id}`, { method: 'PATCH', body: { name } });
      setEditing(null);
      await load();
      onChanged?.();
      toast(`${sectionOf(editing.kind).label} renamed to "${name}"`);
    } catch (e) {
      // keep the dialog open — a 409 must never look like a silent no-op save
      setEditError(errText(e, 'Failed to save'));
    } finally {
      setBusy(null);
    }
  };

  // ← / → move between sub-tabs (standard tablist keyboard behaviour), so the
  // pills are usable without a pointer
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = SECTIONS.findIndex((s) => s.kind === active);
    const next = SECTIONS[(i + (e.key === 'ArrowRight' ? 1 : SECTIONS.length - 1)) % SECTIONS.length];
    setActive(next.kind);
    requestAnimationFrame(() => document.getElementById(`asset-setup-tab-${next.param}`)?.focus());
  };

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        Dropdown data behind the register’s filters and forms — add a name once here and it is offered
        everywhere. Entries still in use cannot be deleted; reassign them first.
      </p>

      {/* sub-tabs — pill style matches Inventory's management sub-tabs */}
      <div className="flex flex-wrap gap-2 mb-4" role="tablist" aria-label="Asset setup lists" onKeyDown={onTabKey}>
        {SECTIONS.map((s) => {
          const on = s.kind === active;
          return (
            <button
              key={s.kind}
              id={`asset-setup-tab-${s.param}`}
              role="tab"
              aria-selected={on}
              aria-controls="asset-setup-panel"
              className={`inline-flex items-center gap-2 px-3.5 py-1.5 text-sm rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 focus-visible:ring-offset-1 ${
                on
                  ? 'bg-yellow-600 border-yellow-600 text-white shadow-sm'
                  : 'bg-white border-gray-200 text-gray-600 hover:border-yellow-400 hover:text-yellow-800'
              }`}
              onClick={() => setActive(s.kind)}
            >
              {s.label}
              <span
                className={`min-w-[1.5rem] text-center text-xs font-semibold px-1.5 py-px rounded-full ${
                  on ? 'bg-white/25 text-white' : 'bg-gray-100 text-gray-500'
                }`}
              >
                {loading ? '…' : rows[s.kind].length}
              </span>
            </button>
          );
        })}
      </div>

      <div id="asset-setup-panel" role="tabpanel" aria-labelledby={`asset-setup-tab-${section.param}`}>
        {error && (
          <div role="alert" className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <Card className="p-5 mb-3">
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
            <div className="min-w-0">
              <h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">{section.plural}</h2>
              <p className="text-xs text-gray-400 mt-1 max-w-2xl">{section.hint}</p>
            </div>
            {canManage && (
              <form
                className="flex flex-wrap items-end gap-2 w-full lg:w-auto"
                onSubmit={(e) => { e.preventDefault(); void add(); }}
              >
                {/* flex-1 + w-full: on a phone the field takes the row and the
                    Add button sits beside it instead of pushing off-screen */}
                <div className="flex-1 min-w-0 lg:flex-none">
                  <label htmlFor="asset-setup-new" className="block text-xs font-medium text-gray-500 mb-1">
                    New {section.label.toLowerCase()}
                  </label>
                  <Input
                    id="asset-setup-new"
                    className="!w-full sm:!w-64"
                    placeholder={section.placeholder}
                    value={drafts[active]}
                    onChange={(e) => setDrafts((d) => ({ ...d, [active]: e.target.value }))}
                    disabled={busy !== null}
                    autoComplete="off"
                  />
                  {/* live preview of the code segment this name will mint */}
                  {active === 'categories' && drafts.categories.trim() !== '' && (
                    <p className="text-xs text-gray-400 mt-1">
                      new assets get codes like{' '}
                      <span className="font-mono text-gray-500">
                        AST-{codeSeg(drafts.categories) || ''}{codeSeg(drafts.categories) ? '-' : ''}202610-0001
                      </span>
                    </p>
                  )}
                </div>
                <Button type="submit" disabled={!drafts[active].trim() || busy !== null}>
                  {busy === active ? 'Saving…' : '+ Add'}
                </Button>
              </form>
            )}
          </div>
        </Card>

        {/* toolbar: filter on the left, honest "showing x of y" on the right */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="relative">
            <Input
              id="asset-setup-search"
              aria-label={`Search ${section.plural.toLowerCase()}`}
              placeholder={`Search ${section.plural.toLowerCase()}…`}
              className="!w-full sm:!w-64"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              disabled={loading}
            />
            {q && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQ('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm leading-none px-1"
              >
                ✕
              </button>
            )}
          </div>
          <p className="text-xs text-gray-400 tabular-nums sm:ml-auto">
            {loading ? 'Loading…' : `${visible.length} of ${rows[active].length} ${section.plural.toLowerCase()}`}
          </p>
        </div>

        {/* !min-w-0 opts this short 3-column table out of the global mobile
            min-width:640px rule, so Rename/Delete stay on screen instead of
            hiding behind a sideways scroll */}
        <Table head={['NAME', 'USED BY', 'ACTIONS']} className="!min-w-0">
          {loading ? (
            <tr><td colSpan={3}><Empty label="Loading…" /></td></tr>
          ) : rows[active].length === 0 ? (
            <tr><td colSpan={3}><Empty label={canManage ? section.empty : `No ${section.label.toLowerCase()} entries yet`} /></td></tr>
          ) : visible.length === 0 ? (
            <tr><td colSpan={3}><Empty label={`No ${section.label.toLowerCase()} matches “${q.trim()}”`} /></td></tr>
          ) : visible.map((row) => (
            <tr key={row.id} className="hover:bg-gray-50/60">
              <td className="px-3 sm:px-4 py-2.5 font-medium text-gray-900 break-words">
                {row.name}
                {active === 'categories' && (
                  <span className="block text-[11px] font-mono text-gray-400 mt-0.5">
                    AST-{codeSeg(row.name)}{codeSeg(row.name) ? '-' : ''}…
                  </span>
                )}
              </td>
              <td className="px-3 sm:px-4 py-2.5 text-right tabular-nums text-gray-500 whitespace-nowrap" title={row.usage ? `Used by ${row.usage} record(s)` : 'Not used by anything yet'}>
                {row.usage ? row.usage : <span className="text-gray-300">—</span>}
              </td>
              {/* ACTIONS stacks vertically below sm so the buttons stay reachable
                  without scrolling the table sideways on a phone */}
              <td className="px-3 sm:px-4 py-2.5 text-center">
                <div className="flex flex-col sm:flex-row flex-wrap justify-center gap-1.5">
                  {canManage ? (
                    <>
                      <Button
                        variant="ghost"
                        onClick={() => { setEditing({ kind: active, row }); setEditName(row.name); setEditError(null); }}
                      >
                        Rename
                      </Button>
                      <Button
                        variant="danger"
                        title={row.usage ? `Used by ${row.usage} record(s) — reassign them first` : undefined}
                        onClick={() => setDeleting({ kind: active, row })}
                      >
                        Delete
                      </Button>
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

      {editing && (
        <Modal
          title={`Rename ${sectionOf(editing.kind).label.toLowerCase()} — ${editing.row.name}`}
          onClose={() => setEditing(null)}
          error={editError ?? undefined}
        >
          <label htmlFor="asset-setup-rename" className="block text-xs font-medium text-gray-500 mb-1">Name *</label>
          <Input
            id="asset-setup-rename"
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit(); }}
          />
          <p className="text-xs text-gray-400 mt-2">{sectionOf(editing.kind).renameNote}</p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={!editName.trim() || busy !== null} onClick={() => void saveEdit()}>
              {busy === editing.kind ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.row.name.toLowerCase()}?`}
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
            toast(`${sectionOf(deleting.kind).label} deleted`);
          }}
        />
      )}
    </div>
  );
}
