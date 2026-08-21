import { Download, ExternalLink, FileCode2, Loader2, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ExternalHtmlImportPreview, MaterialAnnotation } from "../../../shared/artifact-types";

export const EXTERNAL_HTML_ACTION_EVENT = "learnie:external-html-action";
export const EXTERNAL_HTML_CAPABILITY_EVENT = "learnie:external-html-capability";
let externalHtmlCapabilityEnabled = false;

export function publishExternalHtmlCapability(enabled: boolean) {
  externalHtmlCapabilityEnabled = enabled;
  window.dispatchEvent(new CustomEvent(EXTERNAL_HTML_CAPABILITY_EVENT, { detail: { enabled } }));
}

export function useExternalHtmlCapability() {
  const [enabled, setEnabled] = useState(() => externalHtmlCapabilityEnabled);
  useEffect(() => {
    const handleCapability = (event: Event) => setEnabled(Boolean((event as CustomEvent<{ enabled: boolean }>).detail?.enabled));
    window.addEventListener(EXTERNAL_HTML_CAPABILITY_EVENT, handleCapability);
    return () => window.removeEventListener(EXTERNAL_HTML_CAPABILITY_EVENT, handleCapability);
  }, []);
  return enabled;
}

export type ExternalHtmlActionPayload =
  | { action: "prepare"; annotationId: string }
  | { action: "commit"; annotationId: string; previewId: string; expectedAnnotationUpdatedAt: number }
  | { action: "cancel"; previewId: string }
  | { action: "open"; annotationId: string; attachmentId: string }
  | { action: "remove"; annotationId: string; attachmentId: string; expectedAnnotationUpdatedAt: number }
  | { action: "export"; annotationId: string; attachmentId: string };

export type ExternalHtmlActionEventDetail = {
  payload: ExternalHtmlActionPayload;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

function requestAction<T>(payload: ExternalHtmlActionPayload): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    window.dispatchEvent(new CustomEvent<ExternalHtmlActionEventDetail>(EXTERNAL_HTML_ACTION_EVENT, {
      detail: { payload, resolve: (value) => resolve(value as T), reject },
    }));
  });
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 100 * 1024 ? 1 : 0)} KB`;
}

export function AnnotationExternalHtmlAttachment({ annotation, compact = false }: { annotation: MaterialAnnotation; compact?: boolean }) {
  const enabled = useExternalHtmlCapability();
  const attachment = (annotation.attachments || []).find((item) => item.kind === "external_html");
  const [preview, setPreview] = useState<ExternalHtmlImportPreview | null>(null);
  const [busy, setBusy] = useState<ExternalHtmlActionPayload["action"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function prepare() {
    setBusy("prepare");
    setError(null);
    try {
      setPreview(await requestAction<ExternalHtmlImportPreview | null>({ action: "prepare", annotationId: annotation.id }));
    } catch (cause) {
      setError((cause as Error).message || String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function cancelPreview() {
    const current = preview;
    setPreview(null);
    if (current && current.status !== "rejected") {
      await requestAction({ action: "cancel", previewId: current.previewId }).catch(() => undefined);
    }
  }

  async function commit() {
    if (!preview || preview.status === "rejected") return;
    setBusy("commit");
    setError(null);
    try {
      await requestAction<MaterialAnnotation>({
        action: "commit",
        annotationId: annotation.id,
        previewId: preview.previewId,
        expectedAnnotationUpdatedAt: annotation.updatedAt,
      });
      setPreview(null);
    } catch (cause) {
      setError((cause as Error).message || String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function run(payload: ExternalHtmlActionPayload) {
    setBusy(payload.action);
    setError(null);
    try {
      await requestAction(payload);
    } catch (cause) {
      setError((cause as Error).message || String(cause));
    } finally {
      setBusy(null);
    }
  }

  if (!enabled) return null;

  return (
    <section className={`external-html-attachment ${compact ? "compact" : ""}`} aria-label="대화형 설명 첨부">
      {attachment ? (
        <div className="external-html-attachment-card">
          <FileCode2 size={compact ? 16 : 20} aria-hidden="true" />
          <div>
            <strong>{attachment.title}</strong>
            <span>{attachment.originalFileName} · {formatBytes(attachment.originalByteSize)} · {attachment.compatibility === "localized" ? "offline 변환됨" : "offline"}</span>
          </div>
          <div className="external-html-attachment-actions">
            <button type="button" onClick={() => run({ action: "open", annotationId: annotation.id, attachmentId: attachment.id })} disabled={Boolean(busy)} title="대화형 설명 열기">
              {busy === "open" ? <Loader2 className="spin" size={15} /> : <ExternalLink size={15} />}<span>열기</span>
            </button>
            {!compact ? (
              <>
                <button type="button" onClick={() => run({ action: "export", annotationId: annotation.id, attachmentId: attachment.id })} disabled={Boolean(busy)}><Download size={15} /> 원본 내보내기</button>
                <button type="button" onClick={() => void prepare()} disabled={Boolean(busy)}><RefreshCw size={15} /> 교체</button>
                <button type="button" className="danger" onClick={() => {
                  if (window.confirm("이 annotation에서 대화형 설명을 삭제할까요? 원본과 실행본도 함께 삭제됩니다.")) {
                    void run({ action: "remove", annotationId: annotation.id, attachmentId: attachment.id, expectedAnnotationUpdatedAt: annotation.updatedAt });
                  }
                }} disabled={Boolean(busy)}><Trash2 size={15} /> 삭제</button>
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <button type="button" className="external-html-import-button" onClick={() => void prepare()} disabled={Boolean(busy)}>
          {busy === "prepare" ? <Loader2 className="spin" size={15} /> : <Upload size={15} />} 대화형 설명 가져오기
        </button>
      )}

      {preview ? (
        <div className="external-html-preview" role="dialog" aria-modal="false" aria-label="대화형 설명 호환성 확인">
          <header><strong>{preview.title}</strong><button type="button" onClick={() => void cancelPreview()} aria-label="가져오기 닫기"><X size={16} /></button></header>
          <dl>
            <div><dt>원본</dt><dd>{preview.originalFileName} · {formatBytes(preview.originalByteSize)}</dd></div>
            <div><dt>판정</dt><dd>{preview.status === "ready" ? "실행 가능" : preview.status === "ready_after_localization" ? "변환 후 실행 가능" : "가져올 수 없음"}</dd></div>
            {preview.dependencies.length ? <div><dt>변환</dt><dd>{preview.dependencies.map((item) => `${item.name} ${item.version} 로컬 포함`).join(", ")}</dd></div> : null}
            <div><dt>차단</dt><dd>{preview.blockedCapabilities.join(", ")}</dd></div>
          </dl>
          {preview.rejectionReasons.length ? <ul>{preview.rejectionReasons.map((reason) => <li key={`${reason.code}-${reason.message}`}>{reason.message}</li>)}</ul> : <p>외부 HTML은 신뢰할 수 없는 코드로 취급되며, 별도 sandbox window에서 사용자가 열 때만 실행됩니다.</p>}
          <footer>
            <button type="button" onClick={() => void cancelPreview()} disabled={busy === "commit"}>취소</button>
            {preview.status !== "rejected" ? <button type="button" className="primary" onClick={() => void commit()} disabled={busy === "commit"}>{busy === "commit" ? <Loader2 className="spin" size={15} /> : null} 가져오기</button> : null}
          </footer>
        </div>
      ) : null}
      {error ? <p className="external-html-error" role="alert">{error}</p> : null}
    </section>
  );
}
