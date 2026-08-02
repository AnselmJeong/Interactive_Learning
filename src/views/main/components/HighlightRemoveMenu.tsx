import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Loader2, Trash2 } from "lucide-react";
import type { MaterialAnnotation } from "../../../shared/artifact-types";

export type HighlightMenuTarget = {
  annotation: MaterialAnnotation;
  rect: DOMRect;
};

export function highlightRemoveMenuPosition(
  rect: Pick<DOMRect, "top" | "bottom" | "left" | "width">,
  viewportWidth: number,
  viewportHeight: number,
) {
  const menuWidth = 126;
  const menuHeight = 42;
  const margin = 12;
  const gap = 10;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2, margin + menuWidth / 2),
    viewportWidth - margin - menuWidth / 2,
  );
  const placeAbove = rect.bottom + gap + menuHeight > viewportHeight - margin;
  const top = placeAbove
    ? Math.max(margin, rect.top - gap - menuHeight)
    : Math.min(viewportHeight - margin - menuHeight, rect.bottom + gap);
  return { left, top, placement: placeAbove ? "above" as const : "below" as const };
}

export function HighlightRemoveMenu({
  target,
  onDelete,
  onClose,
}: {
  target: HighlightMenuTarget;
  onDelete: (annotationId: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const position = highlightRemoveMenuPosition(target.rect, window.innerWidth, window.innerHeight);

  useEffect(() => {
    buttonRef.current?.focus({ preventScroll: true });

    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function handleViewportChange() {
      onClose();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  async function removeHighlight() {
    if (busy) return;
    setBusy(true);
    try {
      await onDelete(target.annotation.id);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={menuRef}
      className="highlight-remove-menu"
      data-placement={position.placement}
      role="menu"
      aria-label="표시 메뉴"
      onMouseDown={(event) => event.preventDefault()}
      style={{ left: position.left, top: position.top } as CSSProperties}
    >
      <button
        ref={buttonRef}
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => void removeHighlight()}
      >
        {busy ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
        표시 삭제
      </button>
    </div>
  );
}
