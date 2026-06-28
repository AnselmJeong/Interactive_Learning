import { useEffect, useMemo, useState } from "react";
import { Archive, BookOpen, Check, Database, FilePlus2, KeyRound, Loader2, MessageSquare, Play, Plus, RefreshCw, Send, Settings, Sparkles } from "lucide-react";
import type { MaterialSummary, ProjectSummary, SourceSummary } from "../../shared/rpc-types";
import type { AppSettings, AiProviderStatus, ProviderModel } from "../../shared/settings-types";
import type { MaterialArtifacts } from "../../shared/artifact-types";
import type { SessionSnapshot, TutorContext } from "../../shared/tutor-types";
import { SettingsModal } from "./components/SettingsModal";
import { SourceInspector } from "./components/SourceInspector";
import { VisualRenderer } from "./components/VisualRenderer";
import { MarkdownContent } from "./components/MarkdownContent";
import { TutorBlockRenderer } from "./components/TutorBlockRenderer";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

type LoadState = {
  projects: ProjectSummary[];
  sources: SourceSummary[];
  materials: MaterialSummary[];
  sessions: SessionSnapshot[];
};

type CoursePlanModule = MaterialArtifacts["coursePlan"]["modules"][number];

function displayableLearningGoal(module: CoursePlanModule) {
  const goal = module.learningGoal.trim();
  if (!goal) return "";
  const boilerplate = /^원문을\s*직접\s*읽지\s*않아도\s*.+의\s*핵심\s*주장과\s*긴장을\s*설명할\s*수\s*있다\.?$/;
  return boilerplate.test(goal) ? "" : goal;
}

function isTeachingGuideVisual(visual: MaterialArtifacts["visuals"][number] | null | undefined) {
  if (!visual) return false;
  return (
    visual.id === "visual-course-map" ||
    visual.id.endsWith("-reading-map") ||
    visual.title.includes("읽기 지도") ||
    visual.title.includes("읽기 방향") ||
    (visual.type === "annotated_table" && visual.columns.some((column) => ["읽기 포인트", "함께 볼 내용", "수업 재료", "메모"].includes(column)))
  );
}

export function App({ request }: { request: RpcRequest }) {
  const [state, setState] = useState<LoadState>({ projects: [], sources: [], materials: [], sessions: [] });
  const [activeProject, setActiveProject] = useState<ProjectSummary | null>(null);
  const [activeMaterial, setActiveMaterial] = useState<MaterialSummary | null>(null);
  const [artifacts, setArtifacts] = useState<MaterialArtifacts | null>(null);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [context, setContext] = useState<TutorContext | null>(null);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [sourceNotice, setSourceNotice] = useState("");
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [tutorThinking, setTutorThinking] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [providerStatus, setProviderStatus] = useState<AiProviderStatus | null>(null);
  const [models, setModels] = useState<ProviderModel[]>([]);

  async function refreshProjects() {
      const projects = (await request("projects.list", {})) as ProjectSummary[];
    setState((current) => ({ ...current, projects }));
    if (!activeProject && projects[0]) await openProject(projects[0]);
  }

  async function openProject(project: ProjectSummary) {
    const opened = (await request("projects.open", { projectId: project.id })) as ProjectSummary;
    const [sources, materials] = await Promise.all([
      request("sources.list", { projectId: project.id }) as Promise<SourceSummary[]>,
      request("materials.list", { projectId: project.id }) as Promise<MaterialSummary[]>,
    ]);
    setActiveProject(opened);
    setState((current) => ({ ...current, sources, materials, sessions: [] }));
    setSelectedSourceIds(new Set());
    setActiveMaterial(null);
    setArtifacts(null);
    setSession(null);
    setContext(null);
  }

  async function refreshSettings() {
    const [nextSettings, nextStatus] = await Promise.all([request("settings.getPublic", {}), request("aiProvider.status", {})]);
    setSettings(nextSettings as AppSettings);
    setProviderStatus(nextStatus as AiProviderStatus);
  }

  useEffect(() => {
    void refreshProjects();
    void refreshSettings();
  }, []);

  useEffect(() => {
    const onGeneration = (event: Event) => setStatus((event as CustomEvent<{ message: string }>).detail.message);
    const onIngestion = (event: Event) => setStatus((event as CustomEvent<{ message: string }>).detail.message);
    const onTutor = () => setStatus("Tutor is thinking");
    const onTutorDone = () => setStatus("Ready");
    const onTutorError = (event: Event) => setStatus((event as CustomEvent<{ error: string }>).detail.error);
    window.addEventListener("generation-progress", onGeneration);
    window.addEventListener("ingestion-progress", onIngestion);
    window.addEventListener("tutor-started", onTutor);
    window.addEventListener("tutor-completed", onTutorDone);
    window.addEventListener("tutor-error", onTutorError);
    return () => {
      window.removeEventListener("generation-progress", onGeneration);
      window.removeEventListener("ingestion-progress", onIngestion);
      window.removeEventListener("tutor-started", onTutor);
      window.removeEventListener("tutor-completed", onTutorDone);
      window.removeEventListener("tutor-error", onTutorError);
    };
  }, []);

  async function createProject() {
    if (!newProjectTitle.trim()) return;
    setBusy(true);
    try {
      const project = (await request("projects.create", { title: newProjectTitle.trim() })) as ProjectSummary;
      setNewProjectTitle("");
      await refreshProjects();
      await openProject(project);
    } finally {
      setBusy(false);
    }
  }

  async function chooseAndImportSources() {
    if (!activeProject) return;
    setBusy(true);
    try {
      const beforeCount = state.sources.length;
      const sources = (await request("sources.chooseAndImport", { projectId: activeProject.id })) as SourceSummary[];
      setState((current) => ({ ...current, sources }));
      setSelectedSourceIds(new Set(sources.map((source) => source.id)));
      const added = Math.max(0, sources.length - beforeCount);
      setSourceNotice(added ? `${added} source${added === 1 ? "" : "s"} imported` : "No new files selected");
    } catch (error) {
      setSourceNotice(`Import failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function generateMaterial() {
    if (!activeProject || selectedSourceIds.size === 0) return;
    setBusy(true);
    try {
      const material = (await request("materials.generate", { projectId: activeProject.id, sourceIds: [...selectedSourceIds] })) as MaterialSummary;
      const materials = (await request("materials.list", { projectId: activeProject.id })) as MaterialSummary[];
      setState((current) => ({ ...current, materials }));
      await selectMaterial(material);
    } finally {
      setBusy(false);
    }
  }

  async function selectMaterial(material: MaterialSummary) {
    setActiveMaterial(material);
    const [nextArtifacts, sessions] = await Promise.all([
      request("materials.getArtifacts", { materialId: material.id }) as Promise<MaterialArtifacts>,
      request("sessions.list", { materialId: material.id }) as Promise<SessionSnapshot[]>,
    ]);
    setArtifacts(nextArtifacts);
    setState((current) => ({ ...current, sessions }));
    setSession(null);
    setContext(null);
  }

  async function startSession(mode: "new" | "continue") {
    if (!activeMaterial) return;
    setBusy(true);
    setTutorThinking(true);
    try {
      const result = (await request("sessions.start", { materialId: activeMaterial.id, mode })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      const sessions = (await request("sessions.list", { materialId: activeMaterial.id })) as SessionSnapshot[];
      setState((current) => ({ ...current, sessions }));
    } finally {
      setBusy(false);
      setTutorThinking(false);
    }
  }

  async function sendAnswer(text = answer) {
    if (!session || !text.trim()) return;
    setBusy(true);
    setTutorThinking(true);
    try {
      const result = (await request("tutor.sendTurn", { sessionId: session.id, userText: text.trim() })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      setAnswer("");
    } finally {
      setBusy(false);
      setTutorThinking(false);
    }
  }

  const currentMessages = session?.messages || [];
  const currentProgress = context?.session.completedModuleIds.length || 0;
  const progressText = artifacts ? `${currentProgress}/${artifacts.coursePlan.modules.length}` : "0/0";
  const activeModule = context?.moduleOutline.find((item) => item.status === "in_progress");
  const progressPercent = artifacts ? Math.round((currentProgress / Math.max(1, artifacts.coursePlan.modules.length)) * 100) : 0;
  const latestAssistant = [...currentMessages].reverse().find((message) => message.role === "assistant");
  const latestChoices = latestAssistant
    ? latestAssistant.choices.length
      ? latestAssistant.choices
      : ["힌트를 하나만 더 주세요.", "예시 답변을 하나 보여주세요.", "이 질문을 더 쉽게 다시 물어봐 주세요."]
    : [];
  const visibleVisual = isTeachingGuideVisual(context?.visual) ? null : context?.visual;

  const sourceCountLabel = useMemo(() => {
    const count = selectedSourceIds.size;
    return count ? `${count} selected` : "Select sources";
  }, [selectedSourceIds]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <BookOpen size={28} />
          <div>
            <h1>Interactive Learning</h1>
            <p>Project-based source-grounded tutoring</p>
          </div>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} title="Settings">
            <Settings size={18} />
          </button>
        </div>

        <section className="pane-section">
          <div className="section-heading">
            <h2>Projects</h2>
            <button className="icon-button" onClick={refreshProjects} title="Refresh projects">
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="inline-form">
            <input value={newProjectTitle} onChange={(event) => setNewProjectTitle(event.target.value)} placeholder="New project title" />
            <button className="icon-button primary" onClick={createProject} disabled={busy || !newProjectTitle.trim()} title="Create project">
              <Plus size={17} />
            </button>
          </div>
          <div className="list">
            {state.projects.map((project) => (
              <button key={project.id} className={`list-item ${activeProject?.id === project.id ? "active" : ""}`} onClick={() => openProject(project)}>
                <span>{project.title}</span>
                <small>{new Date(project.updatedAt).toLocaleDateString()}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="pane-section">
          <div className="section-heading">
            <h2>Sources</h2>
            <span>{sourceCountLabel}</span>
          </div>
          <button
            className="file-picker-card"
            onClick={chooseAndImportSources}
            disabled={!activeProject || busy}
          >
            <FilePlus2 size={22} />
            <span>Choose source files</span>
            <small>{activeProject ? "Select one or more Markdown, text, or PDF files" : "Create or open a project first"}</small>
          </button>
          {sourceNotice ? <p className="source-notice">{sourceNotice}</p> : null}
          <div className="list compact">
            {state.sources.map((source) => (
              <label key={source.id} className="check-row">
                <input
                  type="checkbox"
                  checked={selectedSourceIds.has(source.id)}
                  onChange={(event) => {
                    const next = new Set(selectedSourceIds);
                    if (event.target.checked) next.add(source.id);
                    else next.delete(source.id);
                    setSelectedSourceIds(next);
                  }}
                />
                <span>{source.title}</span>
                <small>{source.qualityStatus}</small>
              </label>
            ))}
          </div>
          <button className="wide-button primary" onClick={generateMaterial} disabled={!activeProject || busy || selectedSourceIds.size === 0}>
            <Sparkles size={16} /> Generate material
          </button>
        </section>

        <section className="pane-section">
          <div className="section-heading">
            <h2>Materials</h2>
            <Database size={16} />
          </div>
          <div className="list">
            {state.materials.map((material) => (
              <button key={material.id} className={`list-item ${activeMaterial?.id === material.id ? "active" : ""}`} onClick={() => selectMaterial(material)}>
                <span>{material.title}</span>
                <small>{material.status}</small>
              </button>
            ))}
          </div>
        </section>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{activeProject?.title || "No project open"}</p>
            <h2>{activeMaterial?.title || "Create a project, import sources, generate material"}</h2>
          </div>
          <div className="status-pill">
            {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
            {status}
          </div>
        </header>

        {artifacts ? (
          <section className="course-strip">
            <div>
              <span>Course outline</span>
              <strong>{artifacts.coursePlan.modules.length} modules</strong>
            </div>
            <div>
              <span>Progress</span>
              <strong>{progressText}</strong>
            </div>
            <button className="wide-button" onClick={() => startSession("continue")} disabled={busy || state.sessions.length === 0}>
              <Play size={16} /> Continue latest
            </button>
            <button className="wide-button primary" onClick={() => startSession("new")} disabled={busy}>
              <MessageSquare size={16} /> Start fresh
            </button>
          </section>
        ) : null}

        <section className="tutor-surface">
          {session ? (
            <>
              <div className="lesson-header">
                <div>
                  <p className="eyebrow">Learning Session</p>
                  <h3>{activeModule?.title || activeMaterial?.title || session.title}</h3>
                </div>
                <div className="lesson-progress">
                  <span>{progressText}</span>
                  <div className="lesson-bar">
                    <i style={{ width: `${progressPercent}%` }} />
                  </div>
                </div>
              </div>
              <div className="chat-log">
                {currentMessages.map((message) => (
                  <div key={message.id} className={`bubble ${message.role}`}>
                    {message.role === "assistant" && message.blocks?.length ? (
                      <TutorBlockRenderer blocks={message.blocks} />
                    ) : (
                      <MarkdownContent content={message.content} />
                    )}
                  </div>
                ))}
                {tutorThinking ? (
                  <div className="bubble assistant thinking-bubble">
                    <span className="typing-spinner" aria-hidden="true" />
                    <MarkdownContent content="답변을 준비하고 있습니다." compact />
                  </div>
                ) : null}
              </div>
              {visibleVisual ? <VisualRenderer visual={visibleVisual} /> : null}
              {latestChoices.length ? (
                <div className="answer-options">
                  <p>다음으로 탐색</p>
                  <div>
                    {latestChoices.map((choice) => (
                      <button key={choice} onClick={() => sendAnswer(choice)} disabled={busy}>
                        {choice}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="composer">
                <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="궁금한 점을 묻거나 위 탐색 경로 중 하나를 선택하세요" rows={3} />
                <button className="icon-button primary send" onClick={() => sendAnswer()} disabled={busy || !answer.trim()} title="Send answer">
                  <Send size={19} />
                </button>
              </div>
            </>
          ) : artifacts ? (
            <div className="empty-state">
              <h3>{artifacts.coursePlan.title}</h3>
              <p>{artifacts.coursePlan.subtitle}</p>
              <div className="module-grid">
                {artifacts.coursePlan.modules.map((module) => {
                  const learningGoal = displayableLearningGoal(module);
                  return (
                    <div key={module.id} className="module-tile">
                      <strong>{module.title}</strong>
                      {learningGoal ? <span>{learningGoal}</span> : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <h3>Project-first learning workspace</h3>
              <p>Import Markdown or text sources, generate reusable material, then run adaptive sessions without regenerating artifacts.</p>
            </div>
          )}
        </section>
      </main>

      <aside className="inspector">
        <div className="section-heading">
          <h2>Inspector</h2>
        </div>
        {context ? (
          <>
            <SourceInspector refs={context.sourceRefs} />
            <section className="inspector-section">
              <p className="eyebrow">Modules</p>
              <div className="outline-list">
                {context.moduleOutline.map((item) => (
                  <div key={item.id} className={`outline-row ${item.status}`}>
                    <span>{item.title}</span>
                    <small>{item.status}</small>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : providerStatus ? (
          <section className="inspector-section">
            <p className="eyebrow">AI Provider</p>
            <h3>{providerStatus.selectedModel || "No model selected"}</h3>
            <p>{providerStatus.hasApiKey ? "API key saved outside renderer" : "API key not configured"}</p>
            <button className="wide-button" onClick={() => setSettingsOpen(true)}>
              <KeyRound size={16} /> Provider settings
            </button>
          </section>
        ) : null}
        <button className="wide-button danger" onClick={() => activeProject && request("projects.archive", { projectId: activeProject.id }).then(refreshProjects)} disabled={!activeProject}>
          <Archive size={16} /> Archive project
        </button>
      </aside>

      {settingsOpen && settings && providerStatus ? (
        <SettingsModal
          request={request}
          settings={settings}
          providerStatus={providerStatus}
          models={models}
          setModels={setModels}
          onClose={() => setSettingsOpen(false)}
          onUpdated={async () => {
            await refreshSettings();
          }}
        />
      ) : null}
    </div>
  );
}
