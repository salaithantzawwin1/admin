import { useEffect, useState } from 'react';

/**
 * Tiny global toast system — one call from anywhere:
 *   toast('Vehicle added')            → success (default)
 *   toast('Failed', 'error')          → error
 *   toast('Saved', 'info')            → neutral info
 * Rendered once by <ToastHost /> in Layout. Auto-dismisses (4s) with fade.
 */
export type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<(items: ToastItem[]) => void>();

function emit() {
  for (const l of listeners) l([...items]);
}

export function toast(message: string, kind: ToastKind = 'success') {
  const t = { id: nextId++, kind, message };
  items = [...items, t].slice(-4); // cap stacked toasts
  emit();
  setTimeout(() => {
    items = items.filter((x) => x.id !== t.id);
    emit();
  }, 4000);
}

const STYLE: Record<ToastKind, string> = {
  success: 'border-green-300 bg-green-50 text-green-800',
  error: 'border-red-300 bg-red-50 text-red-800',
  info: 'border-blue-300 bg-blue-50 text-blue-800',
};

const ICON: Record<ToastKind, string> = {
  success: '✅',
  error: '⚠️',
  info: 'ℹ️',
};

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>([]);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);

  if (list.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60] space-y-2 pointer-events-none" role="status" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-center gap-2 border rounded-lg shadow-lg px-4 py-2.5 text-sm max-w-sm animate-[toastIn_.18s_ease-out] ${STYLE[t.kind]}`}
        >
          <span>{ICON[t.kind]}</span>
          <span className="flex-1">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
