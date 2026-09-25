import { ReactNode, useEffect, useRef } from 'react';

/** Lock body scroll while `active`. */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    document.body.classList.add('modal-open');
    return () => document.body.classList.remove('modal-open');
  }, [active]);
}

/**
 * Trap Tab focus inside `ref` while `active` (a11y): Tab/Shift+Tab cycle
 * through focusable children; on open, focus moves to the first one.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!active || !ref.current) return;
    const root = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const selector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => el.offsetParent !== null);

    // move focus into the dialog on open
    const first = focusables()[0];
    (first ?? root).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && activeEl === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && activeEl === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('keydown', onKey);
      // restore focus to what the user was doing (a11y)
      previouslyFocused?.focus?.();
    };
  }, [active]);

  return ref;
}

/**
 * Shared modal shell (ESC / backdrop / × all close).
 * - body scroll is locked while open
 * - Tab focus is trapped inside; focus returns to the trigger on close
 * - pass `error` to surface submit/validation failures *inside* the dialog —
 *   page-level banners stay free for list-loading errors
 */
export function Modal({
  title,
  onClose,
  children,
  error,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** validation / API error shown as a red banner inside the modal body */
  error?: string | null;
  /** wider dialog (max-w-2xl) for multi-column forms */
  wide?: boolean;
}) {
  useScrollLock(true);
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div
        ref={trapRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`bg-white rounded-xl shadow-xl w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} max-h-[85vh] overflow-y-auto outline-none animate-[modalIn_.15s_ease-out]`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">{title}</h2>
          <button className="text-gray-400 hover:text-gray-600 text-xl leading-none" onClick={onClose}>×</button>
        </div>
        <div className="p-5">
          {error ? (
            <div className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}
