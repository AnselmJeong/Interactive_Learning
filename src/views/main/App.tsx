import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, BookOpen, Check, Loader2, MessageSquare, Play, Send, Settings, Upload } from "lucide-react";
import type { MaterialSummary, ProjectArchiveExport, ProjectSummary, SourceSummary } from "../../shared/rpc-types";
import type { AppSettings, AiProviderStatus, ProviderModel } from "../../shared/settings-types";
import type { MaterialArtifacts } from "../../shared/artifact-types";
import type { SessionSnapshot, SessionSummary, SourceRef, TutorContext } from "../../shared/tutor-types";
import { SettingsModal } from "./components/SettingsModal";
import { VisualRenderer } from "./components/VisualRenderer";
import { MarkdownContent } from "./components/MarkdownContent";
import { TutorBlockRenderer } from "./components/TutorBlockRenderer";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProjectDropdown } from "./components/ProjectDropdown";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

type LoadState = {
  projects: ProjectSummary[];
  sources: SourceSummary[];
  materials: MaterialSummary[];
  sessions: SessionSummary[];
};

type CoursePlanModule = MaterialArtifacts["coursePlan"]["modules"][number];

const NEXT_PROGRESS_CHOICE = "다음 진도로 넘어가주세요.";
const FALLBACK_CHOICES = ["힌트를 하나만 더 주세요.", "예시 답변을 하나 보여주세요.", "이 질문을 더 쉽게 다시 물어봐 주세요.", NEXT_PROGRESS_CHOICE];

function normalizeChoiceText(choice: string) {
  if (!choice) return "";
  if (choice.includes("원래 흐름") || choice.includes("돌아갈게요")) return NEXT_PROGRESS_CHOICE;
  return choice;
}

function learnerChoices(choices: string[]) {
  const seen = new Set<string>();
  const exploratory = choices
    .map((choice) => normalizeChoiceText(choice.trim()))
    .filter((choice) => {
      if (!choice || choice === NEXT_PROGRESS_CHOICE || seen.has(choice)) return false;
      seen.add(choice);
      return true;
    })
    .slice(0, 3);
  return [...exploratory, NEXT_PROGRESS_CHOICE];
}

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

function cleanLocator(locator: string) {
  return locator.replace(/^before\s+/i, "").replace(/^document$/i, "").trim();
}

function AnswerSourceRefs({ refs }: { refs: SourceRef[] }) {
  if (!refs.length) return null;
  return (
    <div className="answer-source-list">
      {refs.map((ref) => (
        <article key={ref.chunkId} className="answer-source-ref">
          <strong>{ref.title}</strong>
          {cleanLocator(ref.locator) ? <small>{cleanLocator(ref.locator)}</small> : null}
          <MarkdownContent content={ref.text} compact />
        </article>
      ))}
    </div>
  );
}

export function App({ request }: { request: RpcRequest }) {
  const [state, setState] = useState<LoadState>({ projects: [], sources: [], materials: [], sessions: [] });
  const [activeProject, setActiveProject] = useState<ProjectSummary | null>(null);
  const [activeMaterial, setActiveMaterial] = useState<MaterialSummary | null>(null);
  const [artifacts, setArtifacts] = useState<MaterialArtifacts | null>(null);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [context, setContext] = useState<TutorContext | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [sourceNotice, setSourceNotice] = useState("");
  const [answer, setAnswer] = useState("");
  const [expandedSourceMessages, setExpandedSourceMessages] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [tutorThinking, setTutorThinking] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [providerStatus, setProviderStatus] = useState<AiProviderStatus | null>(null);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [viewMode, setViewMode] = useState<"chat" | "source">("chat");
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const currentChunkRef = useRef<HTMLElement | null>(null);

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

  async function chooseAndImportSources() {
    if (!activeProject) return;
    setBusy(true);
    try {
      const beforeCount = state.sources.length;
      const sources = (await request("sources.chooseAndImport", { projectId: activeProject.id })) as SourceSummary[];
      setState((current) => ({ ...current, sources }));
      const added = Math.max(0, sources.length - beforeCount);
      setSourceNotice(added ? `${added} source${added === 1 ? "" : "s"} imported` : "No new files selected");
    } catch (error) {
      setSourceNotice(`Import failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  // Pick a source and prepare its learning material. Reuses the material for that source if one
  // already exists (materials.generate deduplicates by source set), otherwise generates it on the
  // fly, then selects it so the course outline appears. It deliberately does NOT start a session:
  // auto-starting spawned a brand-new session on every source click. The learner now explicitly
  // chooses "Continue latest" or "Start" to begin.
  async function learnFromSource(sourceId: string) {
    if (!activeProject) return;
    setBusy(true);
    setStatus("학습 자료 준비 중");
    try {
      const material = (await request("materials.generate", { projectId: activeProject.id, sourceIds: [sourceId] })) as MaterialSummary;
      const materials = (await request("materials.list", { projectId: activeProject.id })) as MaterialSummary[];
      setState((current) => ({ ...current, materials }));
      await selectMaterial(material);
      setStatus("Ready");
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function refreshSessions(materialId = activeMaterial?.id) {
    if (!materialId) return [];
    const sessions = (await request("sessions.list", { materialId })) as SessionSummary[];
    setState((current) => ({ ...current, sessions }));
    return sessions;
  }

  async function selectMaterial(material: MaterialSummary) {
    setActiveMaterial(material);
    const [nextArtifacts, sessions] = await Promise.all([
      request("materials.getArtifacts", { materialId: material.id }) as Promise<MaterialArtifacts>,
      request("sessions.list", { materialId: material.id }) as Promise<SessionSummary[]>,
    ]);
    setArtifacts(nextArtifacts);
    setState((current) => ({ ...current, sessions }));
    setSession(null);
    setContext(null);
    setAnswer("");
    setExpandedSourceMessages(new Set());
  }

  // Core session starter, independent of activeMaterial state so it can be called right after
  // selectMaterial without waiting for a state tick. Both startSession and learnFromSource use it.
  async function beginSession(materialId: string, mode: "new" | "continue") {
    setTutorThinking(true);
    try {
      const result = (await request("sessions.start", { materialId, mode })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      setExpandedSourceMessages(new Set());
      await refreshSessions(materialId);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setTutorThinking(false);
    }
  }

  async function startSession(mode: "new" | "continue") {
    if (!activeMaterial) return;
    setBusy(true);
    await beginSession(activeMaterial.id, mode);
    setBusy(false);
  }

  async function loadSession(sessionId: string) {
    setBusy(true);
    try {
      const result = (await request("sessions.load", { sessionId })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      setAnswer("");
      setExpandedSourceMessages(new Set());
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
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
      await refreshSessions(result.session.materialId);
    } catch (error) {
      // The turn was killed server-side (timeout/connection error). Surface it and re-sync so the
      // dangling user message is gone, the spinner stops, and the learner can resubmit their input
      // (we intentionally keep their text in the composer).
      setStatus(`튜터 응답 실패: ${(error as Error).message}`);
      try {
        const reload = (await request("sessions.load", { sessionId: session.id })) as { session: SessionSnapshot; context: TutorContext };
        setSession(reload.session);
        setContext(reload.context);
      } catch {
        /* keep current state if reload also fails */
      }
    } finally {
      setBusy(false);
      setTutorThinking(false);
    }
  }

  async function exportProjectArchive() {
    if (!activeProject) return;
    setBusy(true);
    try {
      const result = (await request("projects.exportArchive", { projectId: activeProject.id })) as ProjectArchiveExport;
      setStatus(`Exported ${result.sessionCount} sessions to ${result.fileName}`);
    } catch (error) {
      setStatus(`Archive export failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const currentMessages = session?.messages || [];
  const sessionReadOnly = session?.status === "completed" || session?.status === "archived";

  useEffect(() => {
    chatLogRef.current?.scrollTo({ top: chatLogRef.current.scrollHeight, behavior: "smooth" });
  }, [currentMessages.length, tutorThinking]);

  // Progress is measured in source paragraphs (chunks), not modules: a small source is a single
  // module of many paragraphs, so module-based progress would read 0/1 the entire session.
  const totalChunks = artifacts?.sourceChunks.length || 0;
  const coveredChunks = context?.session.coveredChunkIds.length || 0;
  // "Reached" = paragraphs finished plus the one being taught right now, so the indicator reflects
  // the learner's current position and advances with each new paragraph the tutor opens.
  const currentChunkId = context?.session.currentChunkId || null;
  const reachedChunks = coveredChunks + (currentChunkId && !context?.session.coveredChunkIds.includes(currentChunkId) ? 1 : 0);
  const progressText = artifacts ? `${reachedChunks}/${totalChunks}` : "0/0";
  const activeModule = context?.moduleOutline.find((item) => item.status === "in_progress");
  const progressPercent = totalChunks ? Math.round((reachedChunks / totalChunks) * 100) : 0;
  const latestAssistant = [...currentMessages].reverse().find((message) => message.role === "assistant");
  // Once every paragraph is covered, the tutor offers an explicit "마칠게요 / 더 질문 있어요" pair.
  // Don't run those through learnerChoices, which would append "다음 진도로 넘어가주세요" — that
  // choice reads as "next paragraph" yet, at the very end, would re-trip the finish flow.
  const allModulesCovered = totalChunks > 0 && coveredChunks >= totalChunks;
  const latestChoices = latestAssistant
    && !sessionReadOnly
    ? latestAssistant.choices.length
      ? allModulesCovered
        ? latestAssistant.choices
        : learnerChoices(latestAssistant.choices)
      : FALLBACK_CHOICES
    : [];
  const visibleVisual = isTeachingGuideVisual(context?.visual) ? null : context?.visual;
  const activeSessions = useMemo(() => state.sessions.filter((item) => item.status === "active"), [state.sessions]);
  // Per-source material lookup. A source is "ready to learn" when a material built from exactly
  // that source exists and is ready; this drives the status hint shown on each source row.
  const materialForSource = useMemo(() => {
    const map = new Map<string, MaterialSummary | undefined>();
    for (const source of state.sources) {
      map.set(
        source.id,
        state.materials.find((material) => material.sourceIds.length === 1 && material.sourceIds[0] === source.id && material.status === "ready"),
      );
    }
    return map;
  }, [state.sources, state.materials]);
  const activeSourceId = activeMaterial && activeMaterial.sourceIds.length === 1 ? activeMaterial.sourceIds[0] : null;
  const sourceRefById = useMemo(() => {
    const refs = new Map<string, SourceRef>();
    for (const ref of context?.sourceRefs || []) refs.set(ref.chunkId, ref);
    if (artifacts) {
      for (const chunk of artifacts.sourceChunks) {
        const meta = artifacts.sourceIndex[chunk.id];
        refs.set(chunk.id, {
          chunkId: chunk.id,
          title: meta?.title || chunk.headingPath.join(" > ") || "Source",
          locator: meta?.locator || chunk.locator,
          text: chunk.text,
        });
      }
    }
    return refs;
  }, [artifacts, context?.sourceRefs]);

  // Source-coverage model, driven by the paragraph cursor. Each source paragraph (chunk) is
  // "covered" (already taught and stepped past), "current" (the paragraph being taught right now),
  // or "upcoming" (not reached yet). This drives both the highlighted source document and the
  // progression bar, so the learner sees exactly how much of the source has been taught — and
  // notices if the tutor wraps up while paragraphs are still untouched.
  const sourceProgress = useMemo(() => {
    if (!artifacts) return null;
    const chunks = artifacts.sourceChunks;
    const total = chunks.length;
    const coveredIds = new Set(session?.coveredChunkIds || []);
    const currentId = session?.currentChunkId || null;
    const statusFor = (id: string): "covered" | "current" | "upcoming" =>
      id === currentId ? "current" : coveredIds.has(id) ? "covered" : "upcoming";
    const reached = chunks.filter((chunk) => statusFor(chunk.id) !== "upcoming").length;
    const coveredCount = chunks.filter((chunk) => statusFor(chunk.id) === "covered").length;
    const firstCurrentIndex = chunks.findIndex((chunk) => statusFor(chunk.id) === "current");
    return { total, reached, coveredCount, percent: total ? Math.round((reached / total) * 100) : 0, statusFor, firstCurrentIndex };
  }, [artifacts, session?.coveredChunkIds, session?.currentChunkId]);

  // Center the source document on the part being discussed whenever the learner opens the
  // source view or the conversation moves to a new chunk.
  useEffect(() => {
    if (viewMode === "source") currentChunkRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [viewMode, sourceProgress?.firstCurrentIndex]);

  const importedSourceLabel = `${state.sources.length} source${state.sources.length === 1 ? "" : "s"} imported`;
  const inspectorModules = useMemo(() => {
    if (context?.moduleOutline.length) return context.moduleOutline;
    return (artifacts?.coursePlan.modules || []).map((module, index) => ({
      id: module.id,
      title: module.title,
      status: index === 0 ? "in_progress" : "not_started",
    }));
  }, [artifacts?.coursePlan.modules, context?.moduleOutline]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">il</div>
          <div>
            <h1>Interactive Learning</h1>
            <p>Source-grounded tutoring</p>
          </div>
        </div>

        <section className="pane-section">
          <div className="section-heading">
            <h2>Project</h2>
          </div>
          <ProjectDropdown
            projects={state.projects}
            activeProject={activeProject}
            busy={busy}
            onSelect={(project) => void openProject(project)}
            onCreate={() => setNewProjectOpen(true)}
          />
        </section>

        <section className="pane-section sources-section">
          <div className="section-heading">
            <h2>Sources</h2>
            <button className="icon-button ghost" onClick={chooseAndImportSources} disabled={!activeProject || busy} title="소스 추가">
              <Upload size={16} />
            </button>
          </div>
          {sourceNotice ? <p className="source-notice">{sourceNotice}</p> : null}
          <div className="list source-list-fill">
            {state.sources.map((source) => {
              const ready = materialForSource.get(source.id);
              const isActive = activeSourceId === source.id;
              return (
                <button
                  key={source.id}
                  className={`list-item source-learn-row ${isActive ? "active" : ""}`}
                  onClick={() => learnFromSource(source.id)}
                  disabled={!activeProject || busy}
                  title={ready ? "학습 자료 열기" : "학습 자료 생성하기"}
                >
                  <span>{source.title}</span>
                  {ready ? <small>ready</small> : null}
                </button>
              );
            })}
            {!state.sources.length ? (
              <p className="muted-copy">{activeProject ? "아직 가져온 소스가 없습니다. + 버튼으로 소스를 추가하세요." : "프로젝트를 열면 소스를 추가할 수 있습니다."}</p>
            ) : null}
          </div>
        </section>

        <div className="sidebar-footer">
          <button className="wide-button" onClick={() => setSettingsOpen(true)}>
            <Settings size={16} /> Settings
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            {activeMaterial ? (
              <>
                <p className="eyebrow">{activeProject?.title || "Project"}</p>
                <h2>{activeMaterial.title}</h2>
              </>
            ) : activeProject ? (
              <h2>{activeProject.title}</h2>
            ) : (
              <h2>Learning Workspace</h2>
            )}
          </div>
          <div className="topbar-actions">
            <div className="status-pill">
              {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
              {status}
            </div>
          </div>
        </header>

        {artifacts ? (
          <section className="course-strip">
            <div>
              <span>Course outline</span>
              <strong>{artifacts.coursePlan.modules.length} modules</strong>
            </div>
            <div className="course-progress">
              <span>Progress · {progressText} 문단 ({progressPercent}%)</span>
              <div className="lesson-bar">
                <i style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
            <span className="strip-divider" aria-hidden="true" />
            <div className="segmented-control" aria-label="View mode">
              <button type="button" className={viewMode === "source" ? "active" : ""} onClick={() => setViewMode("source")}>
                학습 자료
              </button>
              <button type="button" className={viewMode === "chat" ? "active" : ""} onClick={() => setViewMode("chat")}>
                대화
              </button>
            </div>
            <button className="wide-button topbar-button" onClick={() => startSession("continue")} disabled={busy || activeSessions.length === 0}>
              <Play size={16} /> Continue latest
            </button>
            <button className="wide-button topbar-button primary" onClick={() => startSession("new")} disabled={busy}>
              <MessageSquare size={16} /> Start
            </button>
          </section>
        ) : null}

        <section className="tutor-surface">
          {viewMode === "source" && artifacts ? (
            <div className="source-view">
              <div className="source-progress-head">
                <div>
                  <p className="eyebrow">원문 진행</p>
                  <h3>{sourceProgress?.percent || 0}% 다룸</h3>
                </div>
                <div className="source-progress-meta">
                  <span>{sourceProgress ? `${sourceProgress.reached}/${sourceProgress.total}` : "0/0"} 단락</span>
                  <div className="lesson-bar">
                    <i style={{ width: `${sourceProgress?.percent || 0}%` }} />
                  </div>
                  <div className="source-legend">
                    <span className="covered">다룸</span>
                    <span className="current">진행 중</span>
                    <span className="upcoming">예정</span>
                  </div>
                </div>
              </div>
              {sessionReadOnly && sourceProgress && sourceProgress.percent < 90 ? (
                <p className="source-incomplete-note">아직 다루지 않은 원문이 남아 있습니다. 새 세션을 시작해 이어서 학습할 수 있습니다.</p>
              ) : null}
              <div className="source-doc">
                {artifacts.sourceChunks.map((chunk, index) => {
                  const status = sourceProgress?.statusFor(chunk.id) || "upcoming";
                  const heading = chunk.headingPath.join(" › ");
                  const prevHeading = index > 0 ? (artifacts.sourceChunks[index - 1]?.headingPath.join(" › ") || "") : "";
                  const showHeading = Boolean(heading) && heading !== prevHeading;
                  return (
                    <article
                      key={chunk.id}
                      className={`source-chunk ${status}`}
                      ref={index === sourceProgress?.firstCurrentIndex ? currentChunkRef : undefined}
                    >
                      {showHeading ? <h4 className="source-heading">{heading}</h4> : null}
                      <MarkdownContent content={chunk.text} />
                    </article>
                  );
                })}
              </div>
            </div>
          ) : session ? (
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
              <div className="chat-log" ref={chatLogRef}>
                {currentMessages.map((message) => (
                  <div key={message.id} className={`bubble ${message.role}`}>
                    {message.role === "assistant" && message.blocks?.length ? (
                      <TutorBlockRenderer blocks={message.blocks} />
                    ) : (
                      <MarkdownContent content={message.content} />
                    )}
                    {message.role === "assistant" && message.sourceRefs.length ? (
                      <div className="answer-sources">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedSourceMessages((current) => {
                              const next = new Set(current);
                              if (next.has(message.id)) next.delete(message.id);
                              else next.add(message.id);
                              return next;
                            })
                          }
                        >
                          <BookOpen size={15} />
                          {expandedSourceMessages.has(message.id) ? "근거 닫기" : "근거 보기"}
                        </button>
                        {expandedSourceMessages.has(message.id) ? (
                          <AnswerSourceRefs refs={message.sourceRefs.map((id) => sourceRefById.get(id)).filter((ref): ref is SourceRef => Boolean(ref))} />
                        ) : null}
                      </div>
                    ) : null}
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
              {sessionReadOnly ? (
                <div className="read-only-session">
                  <p>{session.status === "completed" ? "Completed session opened for review." : "Archived session opened for review."}</p>
                  <button className="wide-button primary" onClick={() => startSession("new")} disabled={busy}>
                    <MessageSquare size={16} /> Start new from this material
                  </button>
                </div>
              ) : (
                <div className="composer">
                  <textarea
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.altKey || event.metaKey) && event.key === "Enter") {
                        event.preventDefault();
                        const text = event.currentTarget.value;
                        if (!busy && text.trim()) void sendAnswer(text);
                      }
                    }}
                    placeholder="궁금한 점을 묻거나 위 탐색 경로 중 하나를 선택하세요"
                    rows={3}
                  />
                  <button className="icon-button primary send" onClick={() => sendAnswer()} disabled={busy || !answer.trim()} title="Send answer">
                    <Send size={19} />
                  </button>
                </div>
              )}
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
              <h3>Learning Workspace</h3>
            </div>
          )}
        </section>
      </main>

      <aside className="inspector">
        <div className="section-heading">
          <h2>Inspector</h2>
        </div>
        {activeMaterial ? (
          <>
            <section className="inspector-section">
              <p className="eyebrow">Modules</p>
              <div className="outline-list">
                {inspectorModules.map((item) => (
                  <div key={item.id} className={`outline-row ${item.status}`}>
                    <span>{item.title}</span>
                    <small>{item.status.replace(/_/g, " ")}</small>
                  </div>
                ))}
              </div>
            </section>
            <section className="inspector-section">
              <p className="eyebrow">Sessions</p>
              <div className="session-list">
                {state.sessions.length ? (
                  state.sessions.map((item) => (
                    <button key={item.id} className={`session-row ${session?.id === item.id ? "active" : ""}`} onClick={() => loadSession(item.id)} disabled={busy}>
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.currentModuleTitle || "No current module"}</small>
                      </span>
                      <em className={item.status}>{item.status}</em>
                      <small>{new Date(item.updatedAt).toLocaleString()}</small>
                      <small>
                        {item.completedModuleCount}/{item.totalModuleCount || "?"} modules · {item.messageCount} messages
                      </small>
                    </button>
                  ))
                ) : (
                  <p className="muted-copy">No sessions for this material yet.</p>
                )}
              </div>
            </section>
          </>
        ) : null}
        <button className="wide-button archive-action" onClick={exportProjectArchive} disabled={!activeProject || busy}>
          <Archive size={16} /> Export project archive
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

      {newProjectOpen ? (
        <NewProjectModal
          request={request}
          onClose={() => setNewProjectOpen(false)}
          onCreated={async (project) => {
            await refreshProjects();
            await openProject(project);
          }}
        />
      ) : null}
    </div>
  );
}
