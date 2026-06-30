import { useState } from "react";
import { Check, FileText, Loader2, Plus, Upload, X } from "lucide-react";
import type { ProjectSummary, SourceSummary } from "../../../shared/rpc-types";

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
    setBusy(true);
    setNotice("");
    try {
      const imported = (await request("sources.chooseAndImport", { projectId: project.id })) as SourceSummary[];
      setSources(imported);
      setNotice(imported.length ? `${imported.length}개 소스를 가져왔습니다` : "선택된 파일이 없습니다");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
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
                <div className="np-dropzone">
                  <Upload size={26} />
                  <p>소스를 추가해 학습을 시작하세요</p>
                  <small>Markdown · TXT · PDF</small>
                </div>
              ) : null}
              {!created ? (
                <div className="np-locked-hint">
                  <p>프로젝트를 먼저 만들어주세요</p>
                </div>
              ) : null}
            </div>
            {created ? (
              <button className="np-add-link" onClick={addSources} disabled={busy}>
                {busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} 소스 파일 추가
              </button>
            ) : null}
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
    </div>
  );
}
