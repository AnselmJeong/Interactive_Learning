import { useMemo, useState } from "react";
import { Check, FileText, Loader2, X } from "lucide-react";
import type { PreparedSourceImport, PreparedSourceImportItem, SourceSummary } from "../../../shared/rpc-types";
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
            <p className="eyebrow">Import Sources</p>
            <h2>{prepared.sourceName}</h2>
            <p>{isArticle ? `${prepared.itemCount} article${prepared.itemCount === 1 ? "" : "s"} prepared` : `${prepared.itemCount} markdown files prepared`}</p>
          </div>
          <button className="icon-button" onClick={() => void onCancel()} disabled={busy} title="닫기">
            <X size={18} />
          </button>
        </header>

        <section className="source-import-body">
          <aside className="source-import-list" aria-label={isArticle ? "Prepared articles" : "Prepared markdown files"}>
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
                    <small>{item.charCount.toLocaleString()} chars</small>
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
                      {activeItem.fileName}
                      {activeItem.kind ? ` · ${activeItem.kind}` : ""} · {activeItem.charCount.toLocaleString()} chars
                    </p>
                  </div>
                </header>
                <div className="source-import-preview-scroll">
                  <MarkdownContent content={activeItem.preview || "_No preview available._"} />
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
            {selectedCount} of {prepared.itemCount} selected
          </span>
          <button className="wide-button" onClick={() => void onCancel()} disabled={busy}>
            취소
          </button>
          <button className="wide-button primary" onClick={() => void commit()} disabled={busy || selectedCount === 0}>
            {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />} {isArticle ? "선택 논문 가져오기" : "선택 소스 가져오기"}
          </button>
        </footer>
      </div>
    </div>
  );
}
