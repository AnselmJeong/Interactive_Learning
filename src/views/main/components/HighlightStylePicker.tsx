import { useEffect, useId, useRef, useState } from "react";
import { Highlighter } from "lucide-react";
import { HIGHLIGHT_STYLE_OPTIONS, type HighlightStyle } from "../highlight-styles";

export function HighlightStylePicker({ onSelect }: { onSelect: (style: HighlightStyle) => void }) {
  const [open, setOpen] = useState(false);
  const pickerId = useId();
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={pickerRef} className="selection-highlight-picker">
      <button
        type="button"
        className="mark-action"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
        aria-label="표시 스타일 선택"
        aria-expanded={open}
        aria-controls={pickerId}
        title="표시 스타일 선택"
      >
        <Highlighter size={20} />
      </button>
      {open ? (
        <div
          id={pickerId}
          className="highlight-style-menu"
          role="group"
          aria-label="표시 스타일"
          onMouseDown={(event) => event.preventDefault()}
        >
          {HIGHLIGHT_STYLE_OPTIONS.map((option) => (
            <button
              key={option.style}
              type="button"
              className={`highlight-style-option ${option.style}`}
              onClick={() => {
                setOpen(false);
                onSelect(option.style);
              }}
              aria-label={option.label}
              title={option.label}
            >
              <span className={`highlight-style-swatch ${option.style}`} aria-hidden="true">가</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
