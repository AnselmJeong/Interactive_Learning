import { useState } from "react";
import { Check, FileText, Loader2, Plus, X } from "lucide-react";
import type { PreparedSourceImport, ProjectSummary, SourceSummary } from "../../../shared/rpc-types";
import { SourceImportModal } from "./SourceImportModal";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

// Single-view project creation: the name field and source list are always visible together.
// The project is created on the backend as soon as the name is confirmed (source import needs
// a projectId), which unlocks the source area in place — no separate phase switch. Closing
// the modal after the project exists opens it.
export function NewProjectModal({
  request,
  onClose,
  onCreated,
}: {
  request: RpcRequest;
  onClose: () => void;
  onCreated: (project: ProjectSummary) => Promise<void>;
}) {
  const [projectName, setProjectName] = useState("");
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [preparedImport, setPreparedImport] = useState<PreparedSourceImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const created = Boolean(project);

  async function createProject() {
    const title = projectName.trim();
    if (!title) return;
    setBusy(true);
    setNotice("");
    try {
      const result = (await request("projects.create", { title })) as ProjectSummary;
      setProject(result);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addSources() {
    if (!project) return;
    setNotice("");
    try {
      const paths = (await request("sources.openDialog", { projectId: project.id })) as string[];
      if (!paths.length) {
        setNotice("선택된 파일이 없습니다");
        return;
      }
      setBusy(true);
      const prepared = (await request("sources.prepareImport", { projectId: project.id, paths })) as PreparedSourceImport;
      setPreparedImport(prepared);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function finishPreparedImport(imported: SourceSummary[]) {
    if (!project) return;
    const nextSources = (await request("sources.list", { projectId: project.id })) as SourceSummary[];
    setSources(nextSources);
    setPreparedImport(null);
    setNotice(imported.length ? `${imported.length}개 소스를 가져왔습니다` : "가져온 소스가 없습니다");
    if (imported.length) {
      await onCreated(project);
      onClose();
    }
  }

  async function cancelPreparedImport() {
    if (project && preparedImport) {
      await request("sources.cancelPreparedImport", { projectId: project.id, importId: preparedImport.id });
    }
    setPreparedImport(null);
  }

  async function finish() {
    if (project) await onCreated(project);
    onClose();
  }

  return (
    <div className="modal-backdrop">
      <div className="modal new-project-modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">New Project</p>
            <h2>프로젝트 만들기</h2>
          </div>
          <button className="icon-button" onClick={finish} title="닫기">
            <X size={18} />
          </button>
        </header>

        <section className="new-project-body">
          <label className="np-input-field">
            <span>프로젝트 이름</span>
            <div className="np-name-row">
              <input
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !busy && projectName.trim() && !created) void createProject();
                }}
                placeholder="예: 형이상학 스터디"
                autoFocus
                disabled={created || busy}
              />
              {!created ? (
                <button
                  className="icon-button primary"
                  onClick={createProject}
                  disabled={busy || !projectName.trim()}
                  title="프로젝트 만들기"
                >
                  {busy ? <Loader2 size={18} className="spin" /> : <Check size={18} />}
                </button>
              ) : null}
            </div>
          </label>

          <div className={`np-sources-section ${created ? "" : "locked"}`}>
            <div className="np-sources-heading">
              <span>소스</span>
              <small>{sources.length}개</small>
            </div>
            <div className="np-source-list">
              {sources.map((source) => (
                <div key={source.id} className="np-source-card">
                  <FileText size={18} />
                  <span>{source.title}</span>
                  <small>{source.qualityStatus}</small>
                </div>
              ))}
              {!sources.length && created ? (
                <button className={`np-source-picker ${busy ? "busy" : ""}`} onClick={addSources} disabled={busy} type="button">
                  {busy ? <Loader2 size={30} className="spin" /> : <Plus size={24} />}
                  <p>{busy ? "소스 처리 중" : "소스 선택"}</p>
                  <small>PDF · EPUB · Folder · MD · TXT</small>
                </button>
              ) : null}
              {!created ? (
                <div className="np-locked-hint">
                  <p>프로젝트를 먼저 만들어주세요</p>
                </div>
              ) : null}
            </div>
          </div>

          {notice ? <p className="source-notice">{notice}</p> : null}
        </section>

        <footer className="modal-actions">
          {created ? (
            <>
              <span>{sources.length}개 소스</span>
              <button className="wide-button primary" onClick={finish} disabled={busy}>
                <Check size={16} /> 완료
              </button>
            </>
          ) : (
            <span className="np-footer-hint">이름을 입력하고 만들기를 누르세요</span>
          )}
        </footer>
      </div>
      {preparedImport ? (
        <SourceImportModal request={request} prepared={preparedImport} onCancel={cancelPreparedImport} onImported={finishPreparedImport} />
      ) : null}
    </div>
  );
}
