import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import type { MaterialAnnotation } from "../../../shared/artifact-types";
import { applyAnnotationInlineLinks, unwrapAnnotationInlineLinks } from "../annotation-inline-links";

type AnnotationScopeProps = HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;

export function AnnotationInlineScope({
  annotations,
  activeAnnotationId,
  onActivateAnnotation,
  scopeProps,
  children,
}: {
  annotations: MaterialAnnotation[];
  activeAnnotationId?: string | null;
  onActivateAnnotation?: (annotation: MaterialAnnotation) => void;
  scopeProps?: AnnotationScopeProps;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    applyAnnotationInlineLinks({
      root,
      annotations,
      activeAnnotationId,
      onActivateAnnotation,
    });
    return () => {
      unwrapAnnotationInlineLinks(root);
    };
  }, [annotations, activeAnnotationId, onActivateAnnotation]);

  const className = ["annotation-inline-scope", scopeProps?.className].filter(Boolean).join(" ");

  return (
    <div {...scopeProps} ref={rootRef} className={className} data-annotation-scope>
      {children}
    </div>
  );
}
