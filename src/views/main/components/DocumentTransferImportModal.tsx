import { AlertTriangle, BookOpen, Check, FolderInput, Loader2, X } from "lucide-react";
import type { DocumentTransferImportPreview } from "../../../shared/document-transfer-types";

function classificationCopy(preview: DocumentTransferImportPreview) {
  if (preview.classification === "create_document") {
    return {
      title: "책과 학습 기록을 가져옵니다",
      body: "현재 프로젝트에 새 자료로 추가하며 기존 자료에는 영향을 주지 않습니다.",
    };
  }
  if (preview.classification === "no_changes") {
    return {
      title: "이미 같은 자료가 있습니다",
      body: "중복으로 복사하지 않고 기존 자료를 그대로 유지합니다.",
    };
  }
  if (preview.classification === "diverged") {
    return {
      title: "같은 자료가 서로 다르게 변경되었습니다",
      body: "대상 프로젝트의 학습 기록을 보호하기 위해 자동으로 덮어쓰지 않습니다.",
    };
  }
  return {
    title: "가져올 수 없는 자료입니다",
    body: "원래 프로젝트에서 자료를 다시 내보낸 뒤 시도해 주세요.",
  };
}

export function DocumentTransferImportModal({
  preview,
  error,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: DocumentTransferImportPreview | null;
  error: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = preview ? classificationCopy(preview) : null;
  const canCommit = preview?.classification === "create_document" || preview?.classification === "no_changes";
  const blocked = Boolean(preview) && !canCommit;
  const title = preview?.documentTitle || "자료를 가져오지 못했습니다";

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onCancel(); }}>
      <div className="modal transfer-import-modal" role="dialog" aria-modal="true" aria-labelledby="document-transfer-import-title">
        <header className="modal-header transfer-import-header">
          <div>
            <p className="eyebrow">Learnie document</p>
            <h2 id="document-transfer-import-title">{title}</h2>
            {preview ? <p>{preview.documentType === "book" ? "책" : "논문"} · {new Date(preview.exportedAt).toLocaleString("ko-KR")}</p> : null}
          </div>
          <button type="button" className="icon-button ghost" onClick={onCancel} disabled={busy} aria-label="닫기"><X size={17} /></button>
        </header>

        <section className="transfer-import-body">
          {copy ? (
            <div className={`transfer-import-verdict ${canCommit ? "safe" : "warning"}`}>
              {canCommit ? <Check size={18} /> : <AlertTriangle size={18} />}
              <div><strong>{copy.title}</strong><p>{copy.body}</p></div>
            </div>
          ) : (
            <div className="transfer-import-verdict warning">
              <AlertTriangle size={18} />
              <div><strong>ZIP을 확인하지 못했습니다</strong><p>선택한 파일이 Learnie에서 내보낸 책·논문 ZIP인지 확인해 주세요.</p></div>
            </div>
          )}

          {preview ? (
            <dl className="transfer-counts">
              <div><dt>Sources</dt><dd>{preview.counts.sources}</dd></div>
              <div><dt>Materials</dt><dd>{preview.counts.materials}</dd></div>
              <div><dt>Sessions</dt><dd>{preview.counts.sessions}</dd></div>
              <div><dt>Messages</dt><dd>{preview.counts.messages}</dd></div>
              <div><dt>Annotations</dt><dd>{preview.counts.annotations}</dd></div>
              <div><dt>Prepared</dt><dd>{preview.counts.preparedMessages}</dd></div>
            </dl>
          ) : null}

          {preview?.warnings.map((warning) => <p className="transfer-warning" key={warning}>{warning}</p>)}
          {error ? <p className="transfer-warning" role="alert">{error}</p> : null}
        </section>

        <footer className="modal-actions">
          <button type="button" className="wide-button" onClick={onCancel} disabled={busy}>{canCommit ? "취소" : "닫기"}</button>
          {canCommit ? (
            <button type="button" className="wide-button primary-action" onClick={onConfirm} disabled={busy} autoFocus>
              {busy ? <Loader2 size={15} className="spin" /> : preview?.classification === "no_changes" ? <BookOpen size={15} /> : <FolderInput size={15} />}
              {preview?.classification === "no_changes" ? "기존 자료 열기" : "자료 가져오기"}
            </button>
          ) : null}
          {blocked ? <span className="transfer-blocked-copy">대상 프로젝트는 변경되지 않았습니다.</span> : null}
        </footer>
      </div>
    </div>
  );
}
