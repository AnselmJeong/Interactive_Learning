import { AlertTriangle, Check, FolderInput, Loader2, X } from "lucide-react";
import type { ProjectTransferPreview } from "../../../shared/project-transfer-types";

function classificationCopy(classification: ProjectTransferPreview["classification"]) {
  if (classification === "create_new") return { title: "새 프로젝트를 추가합니다", body: "현재 프로젝트에는 영향을 주지 않고 transfer의 프로젝트를 새로 만듭니다." };
  if (classification === "fast_forward") return { title: "기존 프로젝트를 업데이트합니다", body: "이 컴퓨터가 이전에 가져온 버전에서 이어지는 transfer입니다." };
  if (classification === "no_changes") return { title: "이미 같은 상태입니다", body: "중복 데이터 없이 transfer 기록만 확인합니다." };
  if (classification === "diverged") return { title: "두 컴퓨터에서 모두 변경되었습니다", body: "로컬 프로젝트를 보호하기 위해 자동으로 덮어쓰지 않습니다." };
  if (classification === "unrelated_or_legacy") return { title: "공통 transfer 기록을 확인할 수 없습니다", body: "같은 프로젝트 ID가 있지만 안전한 업데이트 관계를 증명할 수 없습니다." };
  return { title: "가져올 수 없는 transfer입니다", body: "파일을 다시 내보낸 뒤 시도해 주세요." };
}

export function ProjectTransferImportModal({
  preview,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: ProjectTransferPreview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = classificationCopy(preview.classification);
  const canCommit = preview.classification === "create_new" || preview.classification === "fast_forward" || preview.classification === "no_changes";
  const confirmLabel = preview.classification === "create_new" ? "프로젝트 가져오기" : preview.classification === "fast_forward" ? "프로젝트 업데이트" : "확인";
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onCancel(); }}>
      <div className="modal transfer-import-modal" role="dialog" aria-modal="true" aria-labelledby="transfer-import-title">
        <header className="modal-header transfer-import-header">
          <div>
            <p className="eyebrow">Project transfer</p>
            <h2 id="transfer-import-title">{preview.projectTitle}</h2>
            <p>{new Date(preview.exportedAt).toLocaleString("ko-KR")} · {preview.sourceDeviceLabel}</p>
          </div>
          <button type="button" className="icon-button ghost" onClick={onCancel} disabled={busy} aria-label="닫기"><X size={17} /></button>
        </header>
        <section className="transfer-import-body">
          <div className={`transfer-import-verdict ${canCommit ? "safe" : "warning"}`}>
            {canCommit ? <Check size={18} /> : <AlertTriangle size={18} />}
            <div><strong>{copy.title}</strong><p>{copy.body}</p></div>
          </div>
          <dl className="transfer-counts">
            <div><dt>Sources</dt><dd>{preview.counts.sources}</dd></div>
            <div><dt>Materials</dt><dd>{preview.counts.materials}</dd></div>
            <div><dt>Sessions</dt><dd>{preview.counts.sessions}</dd></div>
            <div><dt>Messages</dt><dd>{preview.counts.messages}</dd></div>
            <div><dt>Annotations</dt><dd>{preview.counts.annotations}</dd></div>
            <div><dt>Prepared</dt><dd>{preview.counts.preparedMessages}</dd></div>
          </dl>
          {preview.warnings.map((warning) => <p className="transfer-warning" key={warning}>{warning}</p>)}
        </section>
        <footer className="modal-actions">
          <button type="button" className="wide-button" onClick={onCancel} disabled={busy}>취소</button>
          {canCommit ? (
            <button type="button" className="wide-button primary-action" onClick={onConfirm} disabled={busy} autoFocus>
              {busy ? <Loader2 size={15} className="spin" /> : <FolderInput size={15} />} {confirmLabel}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
