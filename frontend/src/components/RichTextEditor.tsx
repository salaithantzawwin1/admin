import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Minimal rich-text composer for announcements (Plan §18).
 *
 * Uses document.execCommand on a contentEditable div — no external editor
 * dependency — producing the small sanitized HTML subset the backend accepts:
 * bold, italic, underline, strike, H2/H3, lists, alignment, undo/redo.
 * Everything is sanitized again server-side before storage.
 */

const BTN = 'px-2 py-1 rounded text-sm text-gray-700 hover:bg-gray-100 active:bg-gray-200 min-w-[28px]';

function ToolBtn({ label, title, onClick }: { label: ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      className={BTN}
      onMouseDown={(e) => e.preventDefault()} // keep the editor selection
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function RichTextEditor({ value, onChange, minHeight = 140 }: { value: string; onChange: (html: string) => void; minHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const synced = useRef(false);

  // Push DOM → state without re-rendering the content under the caret
  const emit = () => {
    if (!ref.current) return;
    onChange(ref.current.innerHTML);
  };

  // External value → DOM once on mount (create = empty, edit = prefill).
  // The modal remounts this component each time it opens, so one fill is enough.
  useEffect(() => {
    if (ref.current && !synced.current) {
      ref.current.innerHTML = value || '';
      synced.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cmd = (command: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    emit();
  };

  return (
    <div className="border border-gray-300 rounded-lg overflow-hidden focus-within:border-blue-400 bg-white">
      <div className="flex items-center gap-0.5 flex-wrap px-1.5 py-1 border-b border-gray-200 bg-gray-50">
        <ToolBtn label={<b>B</b>} title="Bold" onClick={() => cmd('bold')} />
        <ToolBtn label={<i>I</i>} title="Italic" onClick={() => cmd('italic')} />
        <ToolBtn label={<u>U</u>} title="Underline" onClick={() => cmd('underline')} />
        <ToolBtn label={<s>S</s>} title="Strikethrough" onClick={() => cmd('strikeThrough')} />
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <ToolBtn label="H2" title="Heading 2" onClick={() => cmd('formatBlock', '<h2>')} />
        <ToolBtn label="H3" title="Heading 3" onClick={() => cmd('formatBlock', '<h3>')} />
        <ToolBtn label="¶" title="Normal text" onClick={() => cmd('formatBlock', '<p>')} />
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <ToolBtn label="•—" title="Bullet list" onClick={() => cmd('insertUnorderedList')} />
        <ToolBtn label="1—" title="Numbered list" onClick={() => cmd('insertOrderedList')} />
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <ToolBtn label="⇤" title="Align left" onClick={() => cmd('justifyLeft')} />
        <ToolBtn label="⇆" title="Align center" onClick={() => cmd('justifyCenter')} />
        <ToolBtn label="⇥" title="Align right" onClick={() => cmd('justifyRight')} />
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <ToolBtn label="↺" title="Undo" onClick={() => cmd('undo')} />
        <ToolBtn label="↻" title="Redo" onClick={() => cmd('redo')} />
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        className="px-3 py-2 text-sm text-gray-800 outline-none rich-content"
        style={{ minHeight }}
        onInput={emit}
        onBlur={emit}
      />
    </div>
  );
}
