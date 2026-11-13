import type { ReactNode } from 'react';

/**
 * A low-frequency administration form, folded to one line until it is opened.
 *
 * Shifting a window, swapping a car and cancelling are rare compared with
 * watching the trip or the meeting, but each form took a third of the panel and
 * pushed the thing itself off the screen. Native <details> keeps them keyboard-
 * and screen-reader-accessible with no state of our own.
 */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="border-t border-gray-100 pt-4 mt-4 group">
      <summary className="flex items-center justify-between gap-2 cursor-pointer select-none text-xs font-semibold text-gray-500 uppercase tracking-wide hover:text-gray-700">
        {title}
        <span className="text-gray-400 transition-transform group-open:rotate-180" aria-hidden>⌄</span>
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}
