import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, hasPermission } from '../api';
import { Empty, Input, Select, Table } from './ui';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { toast } from './Toast';
import { categorySegment } from '../util/assetCode';

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
 * UI/UX decisions:
 *  - active sub-tab lives in the URL → refresh / back / shared links keep it
 *  - creating an entry happens in a modal: the list stays the page's subject
 *    and the form gets room for the hint + the live asset-code preview
 *  - "Add & new" keeps the batch workflow the old inline field had (one Enter
 *    per row) without leaving a form permanently parked on the page
 *  - phones get a stacked card list instead of a 4-column table — the action
 *    buttons were the first thing to fall off screen
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
  /** categories only: the specification fields their assets carry */
  specFields?: SpecField[] | null;
}

interface SpecField {
  key?: string;
  label: string;
  type: 'text' | 'number' | 'select';
  options?: string[];
}

interface Section {
  kind: SetupKind;
  /** ?sub= value — singular, so URLs read ?tab=setup&sub=location */
  param: string;
  label: string;
  /** heading plural — "Category" + "s" would read CATEGORYS */
  plural: string;
  /** short glyph for the sub-tab — no icon font in this app */
  icon: string;
  hint: string;
  placeholder: string;
  /** one line under the create form explaining what the name unlocks */
  createNote: string;
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
    icon: '🏷',
    hint: 'Drives the register filter and the auto asset code — "IT Equipment" becomes AST-ITE-2610-0001.',
    placeholder: 'e.g. Office Equipment',
    createNote: 'Assets pick this category in their form; its name also seeds the auto asset code.',
    empty: 'No categories yet',
    renameNote: 'Assets already registered keep their current code; the new name seeds codes from now on.',
  },
  {
    kind: 'locations',
    param: 'location',
    label: 'Location',
    plural: 'Locations',
    icon: '⌖',
    hint: 'Where assets are kept. Used by the register filter, the asset form and every transfer.',
    placeholder: 'e.g. Head Office — Yangon',
    createNote: 'Offered by the asset form, every transfer and the register’s location filter.',
    empty: 'No locations yet',
    renameNote: 'Assets, transfers and receipts keep pointing at it — only the label changes.',
  },
  {
    kind: 'custodians',
    param: 'custodian',
    label: 'Custodian',
    plural: 'Custodians',
    icon: '☺',
    hint: 'People / departments taking custody — offered by the asset form and the transfer dialog.',
    placeholder: 'e.g. U Aung — Finance',
    createNote: 'Offered when assigning custody in the asset form and the transfer dialog.',
    empty: 'No custodians yet',
    renameNote: 'Assets already showing this custodian keep it; new picks use the new name.',
  },
];

const sectionOf = (kind: SetupKind) => SECTIONS.find((s) => s.kind === kind) ?? SECTIONS[0];
const errText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** The code segment a category mints (Printer / Copier -> PRI) — shared with
 *  the register page and mirroring assets.service.ts. */
const codeSeg = categorySegment;

/** Deterministic tint per name, so a row is recognisable at a glance without
 *  inventing an arbitrary colour mapping to maintain. */
const TONES = [
  'bg-amber-100 text-amber-700',
  'bg-sky-100 text-sky-700',
  'bg-emerald-100 text-emerald-700',
  'bg-violet-100 text-violet-700',
  'bg-rose-100 text-rose-700',
];
const toneOf = (name: string) => TONES[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TONES.length];

/**
 * What is wrong with one specification-field row (null = fine). Mirrors the API
 * rules so a save never bounces off the server with a page-level error that
 * does not say which row to fix.
 */
function specFieldIssue(f: SpecField, fields: SpecField[]): string | null {
  const label = f.label.trim();
  if (!label) return 'A label is required';
  if (label.length > 60) return 'Label is too long (max 60 characters)';
  if (fields.filter((o) => o.label.trim().toLowerCase() === label.toLowerCase()).length > 1) {
    return 'Another field already uses this label';
  }
  if (f.type === 'select') {
    const options = (f.options ?? []).map((o) => o.trim()).filter(Boolean);
    if (!options.length) return 'A select field needs at least one option';
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return 'Remove the duplicate options';
  }
  return null;
}

const ACTION_BTN =
  'inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 disabled:opacity-50';
const DANGER_BTN =
  'inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:opacity-50';

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
  const [error, setError] = useState<string | null>(null);
  // search box — scoped to the active sub-tab, cleared when switching so a
  // forgotten filter never looks like missing data on the next list
  const [q, setQ] = useState('');
  // create dialog
  const [creating, setCreating] = useState<SetupKind | null>(null);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const [editing, setEditing] = useState<{ kind: SetupKind; row: SetupRow } | null>(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ kind: SetupKind; row: SetupRow } | null>(null);
  // category → specification fields editor (what its assets must answer)
  const [specEdit, setSpecEdit] = useState<{ row: SetupRow; fields: SpecField[] } | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);
  const [specBusy, setSpecBusy] = useState(false);

  useEffect(() => { setQ(''); }, [active]);

  // The modal's focus trap focuses its first focusable child (the close button),
  // so nudge focus into the name field once the dialog is on screen. A timeout
  // keeps this after the trap's own effect.
  useEffect(() => {
    if (!creating && !editing) return;
    const id = creating ? 'asset-setup-new' : 'asset-setup-rename';
    const t = window.setTimeout(() => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      el?.focus();
      el?.select();
    }, 40);
    return () => window.clearTimeout(t);
  }, [creating, editing]);

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

  const openCreate = (kind: SetupKind) => {
    setCreating(kind);
    setNewName('');
    setCreateError(null);
  };

  /** `again` = keep the dialog open for the next entry (batch entry). */
  const create = async (again: boolean) => {
    const kind = creating;
    if (!kind) return;
    const name = newName.trim();
    if (!name) return;
    const sec = sectionOf(kind);
    setCreateError(null);
    // instant feedback for the common typo-duplicate; the API 409 still wins
    if (rows[kind].some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      setCreateError(`${sec.label} “${name}” already exists in this list.`);
      return;
    }
    setBusy(kind);
    try {
      await api(`/assets/${kind}`, { method: 'POST', body: { name } });
      await load();
      onChanged?.();
      toast(`${sec.label} “${name}” added`);
      if (again) {
        setNewName('');
        // focus the fresh empty field so the next name can be typed straight away
        requestAnimationFrame(() => document.getElementById('asset-setup-new')?.focus());
      } else {
        setCreating(null);
      }
    } catch (e) {
      // duplicate name → 409; the typed value survives so it can be edited
      setCreateError(errText(e, 'Failed to add entry'));
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
      toast(`${sectionOf(editing.kind).label} renamed to “${name}”`);
    } catch (e) {
      // keep the dialog open — a 409 must never look like a silent no-op save
      setEditError(errText(e, 'Failed to save'));
    } finally {
      setBusy(null);
    }
  };

  const saveSpecs = async () => {
    if (!specEdit) return;
    setSpecError(null);
    setSpecBusy(true);
    try {
      await api(`/assets/categories/${specEdit.row.id}/specs`, {
        method: 'PATCH',
        body: {
          fields: specEdit.fields.map((f) => ({
            // keep the saved key so existing asset values survive a label edit;
            // a new row has none and the server derives one from the label
            ...(f.key ? { key: f.key } : {}),
            label: f.label,
            type: f.type,
            ...(f.type === 'select' ? { options: f.options ?? [] } : {}),
          })),
        },
      });
      setSpecEdit(null);
      await load();
      onChanged?.();
      toast(`Specification fields saved for “${specEdit.row.name}”`);
    } catch (e) {
      setSpecError(errText(e, 'Failed to save specification fields'));
    } finally {
      setSpecBusy(false);
    }
  };

  const setSpecField = (i: number, patch: Partial<SpecField>) =>
    setSpecEdit((s) => (s ? { ...s, fields: s.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) } : s));

  // ← / → move between sub-tabs (standard tablist keyboard behaviour), so the
  // pills are usable without a pointer
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = SECTIONS.findIndex((s) => s.kind === active);
    const next = SECTIONS[(i + (e.key === 'ArrowRight' ? 1 : SECTIONS.length - 1)) % SECTIONS.length];
    setActive(next.kind);
    requestAnimationFrame(() => document.getElementById(`asset-setup-tab-${next.param}`)?.focus());
  };

  /** Row action buttons — shared by the table (≥sm) and the phone card list. */
  const rowActions = (row: SetupRow) => (
    <div className="flex flex-wrap items-center gap-1.5">
      {canManage ? (
        <>
          {active === 'categories' && (
            <button
              type="button"
              className={ACTION_BTN}
              title="Which specification fields do assets of this category ask for?"
              onClick={() => {
                setSpecEdit({ row, fields: (row.specFields ?? []).map((f) => ({ ...f, options: [...(f.options ?? [])] })) });
                setSpecError(null);
              }}
            >
              Spec fields
            </button>
          )}
          <button
            type="button"
            className={ACTION_BTN}
            onClick={() => { setEditing({ kind: active, row }); setEditName(row.name); setEditError(null); }}
          >
            Rename
          </button>
          <button
            type="button"
            className={DANGER_BTN}
            title={row.usage ? `Used by ${row.usage} record(s) — reassign them first` : undefined}
            onClick={() => setDeleting({ kind: active, row })}
          >
            Delete
          </button>
        </>
      ) : (
        <span className="text-xs text-gray-300">—</span>
      )}
    </div>
  );

  /** Usage + spec chips, shown inline on phones and as their own columns ≥sm. */
  const usageChip = (row: SetupRow) =>
    row.usage ? (
      <span
        title={`Referenced by ${row.usage} record(s) — cannot be deleted until they are reassigned`}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium tabular-nums text-amber-700 ring-1 ring-inset ring-amber-200"
      >
        {row.usage} in use
      </span>
    ) : (
      <span className="whitespace-nowrap text-xs text-gray-400">unused</span>
    );

  const specChip = (row: SetupRow) =>
    row.specFields?.length ? (
      <span
        title={row.specFields.map((f) => f.label).join(', ')}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium tabular-nums text-sky-700 ring-1 ring-inset ring-sky-200"
      >
        {row.specFields.length} field{row.specFields.length === 1 ? '' : 's'}
      </span>
    ) : (
      <span className="text-xs text-gray-300">—</span>
    );

  const nameChip = (row: SetupRow) => (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-bold ${toneOf(row.name)}`}
      >
        {row.name.trim().charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0">
        <div className="break-words font-medium text-gray-900">{row.name}</div>
        {active === 'categories' && (
          <div className="mt-0.5 font-mono text-[11px] text-gray-400">
            AST-{codeSeg(row.name)}{codeSeg(row.name) ? '-' : ''}…
          </div>
        )}
      </div>
    </div>
  );

  const createSection = creating ? sectionOf(creating) : null;
  const createSeg = createSection && creating === 'categories' ? codeSeg(newName) : '';

  return (
    <div>
      {/* what this tab is for — one quiet strip instead of a paragraph block */}
      <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-100 bg-amber-50/60 px-4 py-3">
        <span aria-hidden className="mt-px text-amber-500">ⓘ</span>
        <p className="text-xs leading-relaxed text-gray-600">
          Master lists shared by the register, its filters and the asset form — add a name once here and it is
          offered everywhere. Entries still in use cannot be deleted; reassign them first.
        </p>
      </div>

      {/* sub-tabs — segmented control so the counts read as one set of lists;
          scrolls instead of wrapping when three pills don't fit a phone */}
      <div
        role="tablist"
        aria-label="Asset setup lists"
        onKeyDown={onTabKey}
        className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-gray-100/90 p-1"
      >
        {SECTIONS.map((s) => {
          const on = s.kind === active;
          return (
            <button
              key={s.kind}
              id={`asset-setup-tab-${s.param}`}
              role="tab"
              aria-selected={on}
              aria-controls="asset-setup-panel"
              tabIndex={on ? 0 : -1}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 sm:gap-2 sm:px-3 sm:text-sm ${
                on
                  ? 'bg-white font-semibold text-gray-900 shadow-sm'
                  : 'font-medium text-gray-500 hover:bg-white/60 hover:text-gray-800'
              }`}
              onClick={() => setActive(s.kind)}
            >
              <span aria-hidden className={on ? 'hidden text-yellow-700 sm:inline' : 'hidden text-gray-400 sm:inline'}>{s.icon}</span>
              {s.label}
              <span
                className={`min-w-[1.35rem] rounded-full px-1.5 text-center text-[11px] font-semibold tabular-nums ${
                  on ? 'bg-gold/25 text-yellow-900' : 'bg-white/80 text-gray-500'
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
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span aria-hidden>⚠</span>
            <span>{error}</span>
          </div>
        )}

        {/* toolbar: what this list is, how to search it, and one clear action */}
        <div className="mb-3 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              {section.plural}
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium tabular-nums text-gray-500">
                {loading ? '…' : rows[active].length}
              </span>
            </h2>
            <p className="mt-0.5 max-w-2xl text-xs text-gray-400">{section.hint}</p>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative w-full min-w-0 flex-1 sm:max-w-sm xl:w-auto xl:flex-none">
              <span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-gray-400">⌕</span>
              <Input
                id="asset-setup-search"
                aria-label={`Search ${section.plural.toLowerCase()}`}
                placeholder={`Search ${section.plural.toLowerCase()}…`}
                className="!h-9 !w-full !pl-8 xl:!w-56"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                disabled={loading}
              />
            </div>
            {canManage && (
              <button
                type="button"
                onClick={() => openCreate(active)}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-gold px-3.5 text-sm font-semibold text-gray-900 shadow-sm transition-colors hover:bg-gold-light focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/70"
              >
                <span aria-hidden className="text-base leading-none">+</span>
                New {section.label.toLowerCase()}
              </button>
            )}
          </div>
        </div>

        {/* phones: one stacked card per entry — a 4-column table squeezed the
            action buttons off screen */}
        <div className="sm:hidden">
          <div className="overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-card">
            {loading ? (
              <Empty label="Loading…" />
            ) : rows[active].length === 0 ? (
              <div className="px-4 py-10 text-center">
                <div aria-hidden className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-gray-50 text-lg text-gray-300">
                  {section.icon}
                </div>
                <p className="mt-2.5 text-sm font-medium text-gray-600">{section.empty}</p>
                <p className="mt-0.5 text-xs text-gray-400">
                  {canManage
                    ? `Use “New ${section.label.toLowerCase()}” to add the first entry.`
                    : 'Nothing here yet.'}
                </p>
              </div>
            ) : visible.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-gray-500">No {section.label.toLowerCase()} matches “{q.trim()}”</p>
                <button
                  type="button"
                  onClick={() => setQ('')}
                  className="mt-1.5 text-xs font-medium text-yellow-800 underline-offset-2 hover:underline"
                >
                  Clear search
                </button>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {visible.map((row) => (
                  <li key={row.id} className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">{nameChip(row)}</div>
                      {usageChip(row)}
                    </div>
                    {active === 'categories' && <div className="mt-2">{specChip(row)}</div>}
                    <div className="mt-2.5">{rowActions(row)}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* ≥sm: the same rows as a table */}
        <div className="hidden sm:block">
          <Table
            head={active === 'categories' ? ['NAME', 'SPEC FIELDS', 'USED BY', 'ACTIONS'] : ['NAME', 'USED BY', 'ACTIONS']}
            className="!min-w-0"
          >
            {loading ? (
              <tr><td colSpan={active === 'categories' ? 4 : 3}><Empty label="Loading…" /></td></tr>
            ) : rows[active].length === 0 ? (
              <tr>
                <td colSpan={active === 'categories' ? 4 : 3}>
                  <div className="py-12 text-center">
                    <div aria-hidden className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-gray-50 text-lg text-gray-300">
                      {section.icon}
                    </div>
                    <p className="mt-2.5 text-sm font-medium text-gray-600">{section.empty}</p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {canManage
                        ? `Use “New ${section.label.toLowerCase()}” to add the first entry — it appears in the register straight away.`
                        : 'Nothing here yet.'}
                    </p>
                  </div>
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={active === 'categories' ? 4 : 3}>
                  <div className="py-10 text-center">
                    <p className="text-sm text-gray-500">No {section.label.toLowerCase()} matches “{q.trim()}”</p>
                    <button
                      type="button"
                      onClick={() => setQ('')}
                      className="mt-1.5 text-xs font-medium text-yellow-800 underline-offset-2 hover:underline"
                    >
                      Clear search
                    </button>
                  </div>
                </td>
              </tr>
            ) : visible.map((row) => (
              <tr key={row.id} className="hover:bg-gray-50/70">
                <td className="px-3 py-2.5 sm:px-4">{nameChip(row)}</td>
                {active === 'categories' && (
                  <td className="px-3 py-2.5 text-center sm:px-4">{specChip(row)}</td>
                )}
                <td className="px-3 py-2.5 text-right sm:px-4">{usageChip(row)}</td>
                <td className="px-3 py-2.5 sm:px-4">
                  <div className="flex justify-center">{rowActions(row)}</div>
                </td>
              </tr>
            ))}
          </Table>
        </div>

        {!loading && rows[active].length > 0 && (
          <p className="mt-2 text-right text-[11px] tabular-nums text-gray-400">
            showing {visible.length} of {rows[active].length} {section.plural.toLowerCase()}
          </p>
        )}
      </div>

      {/* create — the one place a new entry is typed */}
      {createSection && (
        <Modal
          title={`New ${createSection.label.toLowerCase()}`}
          onClose={() => setCreating(null)}
          error={createError}
        >
          <form
            onSubmit={(e) => { e.preventDefault(); void create(false); }}
          >
            <label htmlFor="asset-setup-new" className="mb-1 block text-xs font-medium text-gray-500">
              {createSection.label} name *
            </label>
            <Input
              id="asset-setup-new"
              autoFocus
              autoComplete="off"
              className="!w-full"
              placeholder={createSection.placeholder}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={busy !== null}
            />

            {creating === 'categories' && (
              <div className="mt-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                New assets get codes like{' '}
                <span className="font-mono text-gray-700">
                  AST-{createSeg || 'XXX'}-2610-0001
                </span>
              </div>
            )}

            <p className="mt-2.5 text-xs text-gray-400">{createSection.createNote}</p>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreating(null)}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                Cancel
              </button>
              {canManage && (
                <button
                  type="button"
                  disabled={!newName.trim() || busy !== null}
                  onClick={() => void create(true)}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                  title="Add this one and keep the dialog open for the next"
                >
                  Add &amp; new
                </button>
              )}
              <button
                type="submit"
                disabled={!newName.trim() || busy !== null}
                className="rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-gray-900 shadow-sm transition-colors hover:bg-gold-light disabled:opacity-50"
              >
                {busy === creating ? 'Saving…' : `Add ${createSection.label.toLowerCase()}`}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {editing && (
        <Modal
          title={`Rename ${sectionOf(editing.kind).label.toLowerCase()} — ${editing.row.name}`}
          onClose={() => setEditing(null)}
          error={editError ?? undefined}
        >
          <label htmlFor="asset-setup-rename" className="mb-1 block text-xs font-medium text-gray-500">Name *</label>
          <Input
            id="asset-setup-rename"
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit(); }}
          />
          <p className="mt-2 text-xs text-gray-400">{sectionOf(editing.kind).renameNote}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!editName.trim() || busy !== null}
              onClick={() => void saveEdit()}
              className="rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-gray-900 shadow-sm hover:bg-gold-light disabled:opacity-50"
            >
              {busy === editing.kind ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {/* category specification fields — what the asset form asks for */}
      {specEdit && (
        <Modal
          title={`Specification fields — ${specEdit.row.name}`}
          onClose={() => setSpecEdit(null)}
          error={specError ?? undefined}
          wide
        >
          <p className="mb-3 text-xs text-gray-500">
            What the asset form asks for assets of this category — e.g. a printer’s
            “Connection” with USB / Network options. Leave it empty and only the common fields are used.
            Removing a field here stops the form asking for it; values already recorded stay on the asset
            until that asset is saved again.
          </p>
          <div className="space-y-2">
            {specEdit.fields.length === 0 && (
              <p className="rounded-lg border border-dashed border-gray-200 px-3 py-4 text-center text-sm text-gray-400">
                No specification fields yet.
              </p>
            )}
            {specEdit.fields.map((f, i) => {
              const issue = specFieldIssue(f, specEdit.fields);
              return (
              <div key={i} className={`space-y-2 rounded-lg border p-2 ${issue ? 'border-red-200 bg-red-50/40' : 'border-gray-100 bg-gray-50/60'}`}>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <label className="mb-1 block text-[11px] font-medium text-gray-500">Label</label>
                    <Input
                      className="!w-full"
                      placeholder="e.g. Connection"
                      value={f.label}
                      onChange={(e) => setSpecField(i, { label: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-gray-500">Type</label>
                    <Select
                      value={f.type}
                      onChange={(e) => setSpecField(i, { type: e.target.value as SpecField['type'] })}
                    >
                      <option value="text">Text</option>
                      <option value="number">Number</option>
                      <option value="select">Select</option>
                    </Select>
                  </div>
                  <button
                    type="button"
                    className={ACTION_BTN}
                    onClick={() => setSpecEdit((s) => (s ? { ...s, fields: s.fields.filter((_, j) => j !== i) } : s))}
                  >
                    Remove
                  </button>
                </div>
                {f.type === 'select' && (
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-gray-500">Options (comma separated)</label>
                    <Input
                      className="!w-full"
                      placeholder="USB, Network (LAN), Wi-Fi"
                      value={(f.options ?? []).join(', ')}
                      onChange={(e) => setSpecField(i, { options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) })}
                    />
                  </div>
                )}
                {issue && <p className="text-xs font-medium text-red-600">{issue}</p>}
              </div>
              );
            })}
          </div>
          <div className="mt-3">
            <button
              type="button"
              className={ACTION_BTN}
              onClick={() => setSpecEdit((s) => (s ? { ...s, fields: [...s.fields, { label: '', type: 'text' }] } : s))}
            >
              + Add field
            </button>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setSpecEdit(null)}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={specBusy || specEdit.fields.some((f) => specFieldIssue(f, specEdit.fields) !== null)}
              onClick={() => void saveSpecs()}
              className="rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-gray-900 shadow-sm hover:bg-gold-light disabled:opacity-50"
            >
              {specBusy ? 'Saving…' : 'Save fields'}
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.row.name}”?`}
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
