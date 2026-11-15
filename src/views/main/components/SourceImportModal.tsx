import { useEffect, useMemo, useState } from "react";
import { Check, FileText, Loader2, X } from "lucide-react";
import type { IngestionProgress, PreparedSourceImport, PreparedSourceImportItem, SourceSummary } from "../../../shared/rpc-types";
import { MarkdownContent } from "./MarkdownContent";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

export function SourceImportModal({
  request,
  prepared,
  onCancel,
  onImported,
}: {
  request: RpcRequest;
  prepared: PreparedSourceImport;
  onCancel: () => Promise<void>;
  onImported: (sources: SourceSummary[]) => Promise<void>;
}) {
  const [selectedIds, setSelectedIds] = useState(() => new Set(prepared.items.filter((item) => item.selected).map((item) => item.id)));
  const [activeId, setActiveId] = useState(prepared.items.find((item) => item.selected)?.id || prepared.items[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const activeItem = useMemo(() => prepared.items.find((item) => item.id === activeId) || prepared.items[0] || null, [prepared.items, activeId]);
  const selectedCount = selectedIds.size;
  const isArticle = prepared.documentType === "article";

  const pdfFolderOnly = prepared.pdfFolderFileCount > 0 && prepared.pdfFolderFileCount === prepared.itemCount;
  const [progress, setProgress] = useState("");
  useEffect(() => {
    if (!busy || !prepared.pdfFolderFileCount) return;
    const update = (event: Event) => {
      const { projectId, stage, message } = (event as CustomEvent<IngestionProgress>).detail;
      if (projectId === prepared.projectId && stage === "extracting") setProgress(message);
    };
    window.addEventListener("ingestion-progress", update);
    return () => window.removeEventListener("ingestion-progress", update);
  }, [busy, prepared.pdfFolderFileCount, prepared.projectId]);

  function toggleItem(item: PreparedSourceImportItem) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  async function commit() {
    if (!selectedIds.size) {
      setNotice("가져올 source를 하나 이상 선택하세요.");
      return;
    }
    setProgress("");
    setBusy(true);
    setNotice("");
    try {
      const sources = (await request("sources.commitPreparedImport", {
        projectId: prepared.projectId,
        importId: prepared.id,
        selectedItemIds: [...selectedIds],
      })) as SourceSummary[];
      await onImported(sources);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal source-import-modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">{prepared.targetDocumentId ? `"${prepared.targetDocumentTitle || "현재 책"}"에 소스 추가` : "책·논문 가져오기"}</p>
            <h2>{prepared.sourceName}</h2>
            <p>{prepared.targetDocumentId
              ? `선택한 항목을 새 책으로 만들지 않고 "${prepared.targetDocumentTitle || "현재 책"}"의 Sources 끝에 추가합니다.`
              : pdfFolderOnly
              ? `PDF ${prepared.itemCount}개 중 ${isArticle ? "논문으로" : "책의 챕터로"} 가져올 파일을 선택하세요.`
              : `가져올 항목 ${prepared.itemCount}개를 준비했습니다.`}</p>
          </div>
          <button className="icon-button" onClick={() => void onCancel()} disabled={busy} title="닫기">
            <X size={18} />
          </button>
        </header>

        <section className="source-import-body">
          <aside className="source-import-list" aria-label={"가져올 항목"}>
            <div className="source-import-tools">
              <button type="button" onClick={() => setSelectedIds(new Set(prepared.items.map((item) => item.id)))} disabled={busy}>
                모두 선택
              </button>
              <button type="button" onClick={() => setSelectedIds(new Set())} disabled={busy}>
                선택 해제
              </button>
            </div>
            <div className="source-import-items">
              {prepared.items.map((item) => {
                const active = item.id === activeItem?.id;
                const selected = selectedIds.has(item.id);
                return (
                  <div
                    key={item.id}
                    className={`source-import-item ${active ? "active" : ""}`}
                    onClick={() => setActiveId(item.id)}
                    title={item.title}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setActiveId(item.id);
                      }
                    }}
                  >
                    <input
                      className="source-import-check"
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleItem(item)}
                      onClick={(event) => event.stopPropagation()}
                      disabled={busy}
                    />
                    <FileText size={16} />
                    <span>{item.title}</span>
                    <small>{item.charCount === null ? "PDF" : `${item.charCount.toLocaleString()} chars`}</small>
                  </div>
                );
              })}
            </div>
          </aside>

          <article className="source-import-preview">
            {activeItem ? (
              <>
                <header>
                  <div>
                    <h3>{activeItem.title}</h3>
                    <p>
                      {activeItem.kind === "pdf" ? activeItem.relativePath : activeItem.fileName}
                      {activeItem.charCount !== null ? ` · ${activeItem.charCount.toLocaleString()} chars` : ""}
                    </p>
                  </div>
                </header>
                <div className="source-import-preview-scroll">
                  {activeItem.kind === "pdf"
                    ? <p>{isArticle ? "이 PDF 한 편을 독립된 논문으로 가져옵니다." : "이 PDF 전체를 책의 챕터 소스 하나로 가져옵니다."}</p>
                    : <MarkdownContent content={activeItem.preview || "_No preview available._"} />}
                </div>
              </>
            ) : (
              <p className="muted-copy">Preview할 source가 없습니다.</p>
            )}
          </article>
        </section>

        {notice ? <p className="source-notice">{notice}</p> : null}

        <footer className="modal-actions">
          <span>
            {busy && progress ? progress : `${prepared.itemCount}개 중 ${selectedCount}개 선택`}
          </span>
          <button className="wide-button" onClick={() => void onCancel()} disabled={busy}>
            취소
          </button>
          <button className="wide-button primary" onClick={() => void commit()} disabled={busy || selectedCount === 0}>
            {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />} {isArticle ? "논문 가져오기" : "선택한 Source로 책 가져오기"}
          </button>
        </footer>
      </div>
    </div>
  );
}
