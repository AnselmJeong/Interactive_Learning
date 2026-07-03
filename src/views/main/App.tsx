import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, BookOpen, Check, Info, Loader2, MessageSquare, Play, Send, Settings, Upload } from "lucide-react";
import type { MaterialSummary, PreparedSourceImport, ProjectArchiveExport, ProjectSummary, SourceSummary } from "../../shared/rpc-types";
import type { AppSettings, AiProviderStatus, ProviderModel } from "../../shared/settings-types";
import type { MaterialArtifacts } from "../../shared/artifact-types";
import type { SessionSnapshot, SessionSummary, SourceRef, TutorContext, TutorMessage } from "../../shared/tutor-types";
import { SettingsModal } from "./components/SettingsModal";
import { VisualRenderer } from "./components/VisualRenderer";
import { MarkdownContent } from "./components/MarkdownContent";
import { TutorBlockRenderer } from "./components/TutorBlockRenderer";
import { ImmersiveSourceView } from "./components/ImmersiveSourceView";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProjectDropdown } from "./components/ProjectDropdown";
import { SourceImportModal } from "./components/SourceImportModal";
import { AboutModal } from "./components/AboutModal";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

type LoadState = {
  projects: ProjectSummary[];
  sources: SourceSummary[];
  materials: MaterialSummary[];
  sessions: SessionSummary[];
};

type CoursePlanModule = MaterialArtifacts["coursePlan"]["modules"][number];
type ModuleStatus = TutorContext["moduleOutline"][number]["status"];
type InspectorTab = "modules" | "sessions";

const PROGRESSION_CHOICES = new Set(["다음 진도로 넘어가주세요.", "다음 대목으로 넘어가주세요.", "다음 문단으로 넘어가주세요.", "다음 모듈로 넘어가주세요.", "진도로 돌아갈게요."]);
const FINISH_CONFIRMATION_CHOICE = "네, 마칠게요.";
const FALLBACK_CHOICES = ["힌트를 하나만 더 주세요.", "예시 답변을 하나 보여주세요.", "이 질문을 더 쉽게 다시 물어봐 주세요."];
const EMPTY_MESSAGES: TutorMessage[] = [];

function normalizeChoiceText(choice: string) {
  if (!choice) return "";
  if (choice.includes("원래 흐름") || choice.includes("돌아갈게요")) return "이 설명을 원문 흐름과 다시 연결해 주세요.";
  return choice;
}

function learnerChoices(choices: string[]) {
  const seen = new Set<string>();
  const exploratory = choices
    .map((choice) => normalizeChoiceText(choice.trim()))
    .filter((choice) => {
      if (!choice || PROGRESSION_CHOICES.has(choice) || seen.has(choice)) return false;
      seen.add(choice);
      return true;
    })
    .slice(0, 3);
  return exploratory.length ? exploratory : FALLBACK_CHOICES;
}

function displayableLearningGoal(module: CoursePlanModule) {
  const goal = module.learningGoal.trim();
  if (!goal) return "";
  const boilerplate = /^원문을\s*직접\s*읽지\s*않아도\s*.+의\s*핵심\s*주장과\s*긴장을\s*설명할\s*수\s*있다\.?$/;
  return boilerplate.test(goal) ? "" : goal;
}

function displayableCourseTitle(title: string) {
  return title.replace(/\s+course$/i, "").trim();
}

function cleanHeadingParts(parts: string[]) {
  const normalized = parts.map((part) => displayableCourseTitle(part.trim())).filter(Boolean);
  if (normalized.length > 1 && /^chapter\s+\d+\b/i.test(normalized[0] || "")) return normalized.slice(1);
  return normalized;
}

function displayableHeadingPath(parts: string[], separator = " › ") {
  return cleanHeadingParts(parts).join(separator);
}

function displayableOutlineTitle(title: string) {
  return displayableCourseTitle(title)
    .replace(/^chapter\s+\d+\s*(?:>|›|:|-)\s*/i, "")
    .replace(/\s*(?:>|›)\s*/g, " › ")
    .trim();
}

function stripRepeatedSourceHeading(content: string, heading: string) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex < 0) return content;
  const firstHeading = /^(#{1,6})\s+(.+)$/.exec(lines[firstContentIndex]!.trim());
  if (!firstHeading) return content;

  const firstTitle = displayableOutlineTitle(firstHeading[2] || "") || displayableCourseTitle(firstHeading[2] || "");
  const currentTitle = displayableOutlineTitle(heading) || displayableCourseTitle(heading);
  const isRepeated = Boolean(currentTitle) && firstTitle.toLowerCase() === currentTitle.toLowerCase();
  const isBareChapter = /^chapter\s+\d+\b/i.test(firstTitle);
  if (!isRepeated && !isBareChapter) return content;

  const nextLines = lines.slice(0, firstContentIndex).concat(lines.slice(firstContentIndex + 1));
  while (nextLines[0]?.trim() === "") nextLines.shift();
  return nextLines.join("\n").trim();
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

const ChatLog = memo(function ChatLog({
  messages,
  tutorThinking,
  expandedSourceMessages,
  sourceRefById,
  onToggleSource,
}: {
  messages: TutorMessage[];
  tutorThinking: boolean;
  expandedSourceMessages: Set<string>;
  sourceRefById: Map<string, SourceRef>;
  onToggleSource: (messageId: string) => void;
}) {
  return (
    <div className="chat-log">
      {messages.map((message) => (
        <div key={message.id} className={`bubble ${message.role}`}>
          {message.role === "assistant" && message.blocks?.length ? (
            <TutorBlockRenderer blocks={message.blocks} />
          ) : (
            <MarkdownContent content={message.content} />
          )}
          {message.role === "assistant" && message.sourceRefs.length ? (
            <div className="answer-sources">
              <button type="button" onClick={() => onToggleSource(message.id)}>
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
  );
});

const ChatComposer = memo(function ChatComposer({
  busy,
  disabled,
  placeholder,
  autoFocusToken,
  onSend,
}: {
  busy: boolean;
  disabled: boolean;
  placeholder: string;
  autoFocusToken?: number;
  onSend: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const trimmed = draft.trim();

  useEffect(() => {
    if (!autoFocusToken || disabled) return;
    textareaRef.current?.focus();
  }, [autoFocusToken, disabled]);

  async function submit(text = draft) {
    const next = text.trim();
    if (busy || disabled || !next) return;
    const sent = await onSend(next);
    if (sent) setDraft("");
  }

  return (
    <div className="composer">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.altKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            void submit(event.currentTarget.value);
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        rows={3}
      />
      <button className="icon-button primary send" onClick={() => void submit()} disabled={busy || disabled || !trimmed} title="Send answer">
        <Send size={19} />
      </button>
    </div>
  );
});

export function App({ request }: { request: RpcRequest }) {
  const [state, setState] = useState<LoadState>({ projects: [], sources: [], materials: [], sessions: [] });
  const [activeProject, setActiveProject] = useState<ProjectSummary | null>(null);
  const [activeMaterial, setActiveMaterial] = useState<MaterialSummary | null>(null);
  const [artifacts, setArtifacts] = useState<MaterialArtifacts | null>(null);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [context, setContext] = useState<TutorContext | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [sourceNotice, setSourceNotice] = useState("");
  const [preparedImport, setPreparedImport] = useState<PreparedSourceImport | null>(null);
  const [expandedSourceMessages, setExpandedSourceMessages] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [tutorThinking, setTutorThinking] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [providerStatus, setProviderStatus] = useState<AiProviderStatus | null>(null);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [viewMode, setViewMode] = useState<"chat" | "source">("chat");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("sessions");
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const tutorSurfaceRef = useRef<HTMLElement | null>(null);

  async function refreshProjects() {
    const projects = (await request("projects.list", {})) as ProjectSummary[];
    setState((current) => ({ ...current, projects }));
    const currentProject = activeProject ? projects.find((project) => project.id === activeProject.id) : null;
    if (currentProject) {
      setActiveProject(currentProject);
    } else if (projects[0]) {
      await openProject(projects[0]);
    } else {
      setActiveProject(null);
      setActiveMaterial(null);
      setArtifacts(null);
      setSession(null);
      setContext(null);
      setSelectedModuleId(null);
      setState((current) => ({ ...current, projects, sources: [], materials: [], sessions: [] }));
    }
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
    setSelectedModuleId(null);
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
    const onOpenAbout = () => setAboutOpen(true);
    window.addEventListener("generation-progress", onGeneration);
    window.addEventListener("ingestion-progress", onIngestion);
    window.addEventListener("tutor-started", onTutor);
    window.addEventListener("tutor-completed", onTutorDone);
    window.addEventListener("tutor-error", onTutorError);
    window.addEventListener("app-open-about", onOpenAbout);
    return () => {
      window.removeEventListener("generation-progress", onGeneration);
      window.removeEventListener("ingestion-progress", onIngestion);
      window.removeEventListener("tutor-started", onTutor);
      window.removeEventListener("tutor-completed", onTutorDone);
      window.removeEventListener("tutor-error", onTutorError);
      window.removeEventListener("app-open-about", onOpenAbout);
    };
  }, []);

  async function chooseAndImportSources() {
    if (!activeProject) return;
    setBusy(true);
    try {
      const paths = (await request("sources.openDialog", { projectId: activeProject.id })) as string[];
      if (!paths.length) {
        setSourceNotice("No files selected");
        return;
      }
      const prepared = (await request("sources.prepareImport", { projectId: activeProject.id, paths })) as PreparedSourceImport;
      setPreparedImport(prepared);
      setSourceNotice("");
    } catch (error) {
      setSourceNotice(`Import failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function finishPreparedImport(imported: SourceSummary[]) {
    if (!activeProject) return;
    const [sources, materials] = await Promise.all([
      request("sources.list", { projectId: activeProject.id }) as Promise<SourceSummary[]>,
      request("materials.list", { projectId: activeProject.id }) as Promise<MaterialSummary[]>,
    ]);
    setState((current) => ({ ...current, sources, materials }));
    setPreparedImport(null);
    setSourceNotice(imported.length ? `${imported.length} source${imported.length === 1 ? "" : "s"} imported` : "No sources imported");
  }

  async function cancelPreparedImport() {
    if (activeProject && preparedImport) {
      await request("sources.cancelPreparedImport", { projectId: activeProject.id, importId: preparedImport.id });
    }
    setPreparedImport(null);
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
    setSelectedModuleId(null);
    setInspectorTab("sessions");
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
      setSelectedModuleId(result.session.currentModuleId);
      setInspectorTab("modules");
      setExpandedSourceMessages(new Set());
      await refreshSessions(materialId);
      return result;
    } catch (error) {
      setStatus((error as Error).message);
      return null;
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
      setSelectedModuleId(result.session.currentModuleId);
      setInspectorTab("modules");
      setExpandedSourceMessages(new Set());
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendAnswer(text: string) {
    if (!session || !text.trim()) return false;
    setBusy(true);
    setTutorThinking(true);
    try {
      const result = (await request("tutor.sendTurn", { sessionId: session.id, userText: text.trim() })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      setSelectedModuleId(result.session.currentModuleId);
      await refreshSessions(result.session.materialId);
      return true;
    } catch (error) {
      // The turn was killed server-side (timeout/connection error). Surface it and re-sync so the
      // dangling user message is gone, the spinner stops, and the learner can resubmit their input
      // (we intentionally keep their text in the composer).
      setStatus(`튜터 응답 실패: ${(error as Error).message}`);
      try {
        const reload = (await request("sessions.load", { sessionId: session.id })) as { session: SessionSnapshot; context: TutorContext };
        setSession(reload.session);
        setContext(reload.context);
        setSelectedModuleId(reload.session.currentModuleId);
      } catch {
        /* keep current state if reload also fails */
      }
      return false;
    } finally {
      setBusy(false);
      setTutorThinking(false);
    }
  }

  async function advanceLearning(mode: "chunk" | "module") {
    if (!session || sessionReadOnly) return;
    setBusy(true);
    setTutorThinking(true);
    try {
      const result = (await request("sessions.advance", { sessionId: session.id, mode })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      setSelectedModuleId(result.session.currentModuleId);
      await refreshSessions(result.session.materialId);
    } catch (error) {
      setStatus(`진행 실패: ${(error as Error).message}`);
    } finally {
      setBusy(false);
      setTutorThinking(false);
    }
  }

  async function returnToProgress() {
    if (!session || sessionReadOnly) return;
    setBusy(true);
    setTutorThinking(true);
    try {
      const result = (await request("sessions.returnToProgress", { sessionId: session.id })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      setSelectedModuleId(result.session.currentModuleId);
      await refreshSessions(result.session.materialId);
    } catch (error) {
      setStatus(`진도 복귀 실패: ${(error as Error).message}`);
    } finally {
      setBusy(false);
      setTutorThinking(false);
    }
  }

  async function selectModuleFromOutline(moduleId: string, status: ModuleStatus) {
    if (!session) {
      setStatus("먼저 세션을 시작한 뒤 module을 선택하세요.");
      return;
    }
    setSelectedModuleId(moduleId);
    setExpandedSourceMessages(new Set());
    if (status === "completed" || status === "needs_review" || sessionReadOnly) return;
    setBusy(true);
    try {
      const result = (await request("sessions.selectModule", { sessionId: session.id, moduleId })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      await refreshSessions(result.session.materialId);
    } catch (error) {
      setStatus(`Module 선택 실패: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function openSelectedModule() {
    if (!session || !selectedModuleId || sessionReadOnly) return;
    setBusy(true);
    setTutorThinking(true);
    try {
      const result = (await request("sessions.openModule", { sessionId: session.id, moduleId: selectedModuleId })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      setSelectedModuleId(result.session.currentModuleId);
      await refreshSessions(result.session.materialId);
    } catch (error) {
      setStatus(`Module 시작 실패: ${(error as Error).message}`);
    } finally {
      setBusy(false);
      setTutorThinking(false);
    }
  }

  function continueFromCompletedModule() {
    if (!session?.currentModuleId) return;
    setSelectedModuleId(session.currentModuleId);
    setInspectorTab("modules");
    setExpandedSourceMessages(new Set());
  }

  function focusReviewComposer() {
    setComposerFocusToken(Date.now());
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

  const allSessionMessages = session?.messages || EMPTY_MESSAGES;
  const currentMessages = useMemo(
    () => (selectedModuleId ? allSessionMessages.filter((message) => message.moduleId === selectedModuleId) : allSessionMessages),
    [allSessionMessages, selectedModuleId]
  );
  const sessionReadOnly = session?.status === "completed" || session?.status === "archived";
  const selectedModule = selectedModuleId
    ? context?.moduleOutline.find((item) => item.id === selectedModuleId) || artifacts?.coursePlan.modules.find((module) => module.id === selectedModuleId)
    : null;
  const selectedModuleStatus = context?.moduleOutline.find((item) => item.id === selectedModuleId)?.status || null;
  const selectedModuleReadOnly = selectedModuleStatus === "completed" || selectedModuleStatus === "needs_review";
  const selectedModuleWaiting = Boolean(
    session
      && selectedModuleId
      && !sessionReadOnly
      && currentMessages.length === 0
      && selectedModuleStatus !== "completed"
      && selectedModuleStatus !== "needs_review"
  );
  const selectedModuleTitle = selectedModule ? displayableOutlineTitle(selectedModule.title) || selectedModule.title : "";

  useEffect(() => {
    if (viewMode !== "chat") return;
    let secondFrame = 0;
    const scrollToBottom = () => {
      const surface = tutorSurfaceRef.current;
      if (!surface) return;
      surface.scrollTo({ top: surface.scrollHeight, behavior: "auto" });
    };
    const firstFrame = requestAnimationFrame(() => {
      scrollToBottom();
      secondFrame = requestAnimationFrame(scrollToBottom);
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [currentMessages.length, selectedModuleId, tutorThinking, viewMode]);

  // Progress is measured in semantic source chunks, not modules: a small source can be a single
  // module of many chunks, so module-based progress would read 0/1 the entire session.
  const totalChunks = artifacts?.sourceChunks.length || 0;
  const coveredChunks = context?.session.coveredChunkIds.length || 0;
  // "Reached" = chunks finished plus the one being taught right now, so the indicator reflects
  // the learner's current position and advances with each new chunk the tutor opens.
  const currentChunkId = context?.session.currentChunkId || null;
  const reachedChunks = coveredChunks + (currentChunkId && !context?.session.coveredChunkIds.includes(currentChunkId) ? 1 : 0);
  const progressText = artifacts ? `${reachedChunks}/${totalChunks}` : "0/0";
  const activeModule = context?.moduleOutline.find((item) => item.status === "in_progress");
  const progressPercent = totalChunks ? Math.round((reachedChunks / totalChunks) * 100) : 0;
  const latestAssistant = [...currentMessages].reverse().find((message) => message.role === "assistant");
  const canReturnToProgress = !selectedModuleWaiting && (latestAssistant?.stateUpdate?.conversationMode === "detour" || latestAssistant?.stateUpdate?.turnMode === "digress");
  // Once every chunk is covered, the tutor offers an explicit "마칠게요 / 더 질문 있어요" pair.
  // Normal turns show three exploratory choices, while chunk/module progression lives in
  // separate command buttons below the choices.
  const allModulesCovered = totalChunks > 0 && coveredChunks >= totalChunks;
  const showCompletionActions = Boolean(!sessionReadOnly && !selectedModuleWaiting && allModulesCovered);
  const showProgressActions = Boolean(!sessionReadOnly && !selectedModuleReadOnly && !allModulesCovered);
  const canContinueFromCompletedModule = Boolean(
    !sessionReadOnly
      && selectedModuleReadOnly
      && !allModulesCovered
      && session?.currentModuleId
      && session.currentModuleId !== selectedModuleId
  );
  const latestChoices = latestAssistant
    && !sessionReadOnly
    && !selectedModuleReadOnly
    && !allModulesCovered
    ? latestAssistant.choices.length
      ? learnerChoices(latestAssistant.choices)
      : FALLBACK_CHOICES
    : [];
  const visibleVisual = isTeachingGuideVisual(context?.visual) ? null : context?.visual;
  const activeSessions = useMemo(() => state.sessions.filter((item) => item.status === "active"), [state.sessions]);
  const activeSourceId = activeMaterial && activeMaterial.sourceIds.length === 1 ? activeMaterial.sourceIds[0] : null;
  const courseTitle = artifacts ? displayableCourseTitle(artifacts.coursePlan.title) : "";
  const overviewModules = useMemo(() => {
    if (!artifacts) return [];
    return artifacts.coursePlan.modules.filter((module) => {
      const learningGoal = displayableLearningGoal(module);
      const moduleTitle = displayableCourseTitle(module.title);
      return moduleTitle !== courseTitle || Boolean(learningGoal);
    });
  }, [artifacts, courseTitle]);
  const sourceRefById = useMemo(() => {
    const refs = new Map<string, SourceRef>();
    for (const ref of context?.sourceRefs || []) refs.set(ref.chunkId, ref);
    if (artifacts) {
      for (const chunk of artifacts.sourceChunks) {
        const meta = artifacts.sourceIndex[chunk.id];
        refs.set(chunk.id, {
          chunkId: chunk.id,
          title: displayableOutlineTitle(meta?.title || displayableHeadingPath(chunk.headingPath, " > ") || "Source") || "Source",
          locator: meta?.locator || chunk.locator,
          text: chunk.text,
        });
      }
    }
    return refs;
  }, [artifacts, context?.sourceRefs]);
  const toggleSourceMessage = useCallback((messageId: string) => {
    setExpandedSourceMessages((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  // Source-coverage model, driven by the source-chunk cursor. Each semantic source chunk is
  // "covered" (already taught and stepped past), "current" (the chunk being taught right now),
  // or "upcoming" (not reached yet). This drives both the highlighted source document and the
  // progression bar, so the learner sees exactly how much of the source has been taught — and
  // notices if the tutor wraps up while chunks are still untouched.
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

  const importedSourceLabel = `${state.sources.length} source${state.sources.length === 1 ? "" : "s"} imported`;
  const inspectorModules = useMemo(() => {
    if (context?.moduleOutline.length) {
      return context.moduleOutline.map((item) => ({
        ...item,
        title: displayableOutlineTitle(item.title) || item.title,
      }));
    }
    return (artifacts?.coursePlan.modules || []).map((module, index) => ({
      id: module.id,
      title: displayableOutlineTitle(module.title) || module.title,
      status: (index === 0 ? "in_progress" : "not_started") as ModuleStatus,
    }));
  }, [artifacts?.coursePlan.modules, context?.moduleOutline]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">lr</div>
          <div>
            <h1>Learnie</h1>
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
              const isActive = activeSourceId === source.id;
              return (
                <button
                  key={source.id}
                  className={`list-item source-learn-row ${isActive ? "active" : ""}`}
                  onClick={() => learnFromSource(source.id)}
                  disabled={!activeProject || busy}
                  title={source.title}
                >
                  <span>{source.title}</span>
                </button>
              );
            })}
            {!state.sources.length ? (
              <p className="muted-copy">{activeProject ? "아직 가져온 소스가 없습니다. + 버튼으로 소스를 추가하세요." : "프로젝트를 열면 소스를 추가할 수 있습니다."}</p>
            ) : null}
          </div>
        </section>

        <div className="sidebar-footer">
          <button className="wide-button settings-button" onClick={() => setSettingsOpen(true)}>
            <Settings size={16} /> Settings
          </button>
          <button className="wide-button settings-button" onClick={() => setAboutOpen(true)}>
            <Info size={16} /> About
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="project-title">{activeProject?.title || "Learning Workspace"}</p>
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
            <div className="course-strip-summary">
              <div className="course-outline-stat">
                <span>Course outline</span>
                <strong>{artifacts.coursePlan.modules.length} modules</strong>
              </div>
              <div className="course-progress">
                <span>Progress · {progressText} 대목 ({progressPercent}%)</span>
                <div className="lesson-bar">
                  <i style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            </div>
            <div className="course-strip-actions">
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
            </div>
          </section>
        ) : null}

        <section className="tutor-surface" ref={tutorSurfaceRef}>
          {viewMode === "source" && artifacts ? (
            <ImmersiveSourceView
              artifacts={artifacts}
              sourceProgress={sourceProgress}
              sessionReadOnly={sessionReadOnly}
              displayHeadingPath={displayableHeadingPath}
              cleanSourceText={stripRepeatedSourceHeading}
            />
          ) : session ? (
            <>
              <div className="lesson-header">
                <div>
                  <p className="eyebrow">Learning Session</p>
                  <h3>{selectedModuleTitle || activeModule?.title || activeMaterial?.title || session.title}</h3>
                </div>
              </div>
              {selectedModuleWaiting ? (
                <div className="module-standby">
                  <p className="eyebrow">{selectedModuleStatus === "in_progress" ? "Module selected" : "Ready to start"}</p>
                  <h3>{selectedModuleTitle}</h3>
                  <p>이 module은 아직 대화가 시작되지 않았습니다. 시작하면 해당 module의 첫 대목부터 학습합니다.</p>
                  <button className="wide-button primary" onClick={openSelectedModule} disabled={busy}>
                    <MessageSquare size={16} /> 이 module 시작
                  </button>
                </div>
              ) : null}
              <ChatLog
                messages={currentMessages}
                tutorThinking={tutorThinking}
                expandedSourceMessages={expandedSourceMessages}
                sourceRefById={sourceRefById}
                onToggleSource={toggleSourceMessage}
              />
              {visibleVisual ? <VisualRenderer visual={visibleVisual} /> : null}
              {latestChoices.length || showProgressActions || showCompletionActions ? (
                <div className="answer-options">
                  {latestChoices.length ? (
                    <>
                      <p>다음으로 탐색</p>
                      <div className="choice-grid">
                        {latestChoices.map((choice) => (
                          <button key={choice} onClick={() => void sendAnswer(choice)} disabled={busy || selectedModuleWaiting}>
                            {choice}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : null}
                  {showProgressActions ? (
                    <div className="progress-actions" aria-label="학습 진행">
                      {canReturnToProgress ? (
                        <button type="button" onClick={returnToProgress} disabled={busy || selectedModuleWaiting}>
                          진도로 돌아가기
                        </button>
                      ) : null}
                      <button type="button" onClick={() => advanceLearning("chunk")} disabled={busy || selectedModuleWaiting}>
                        다음 대목으로
                      </button>
                      <button type="button" onClick={() => advanceLearning("module")} disabled={busy || selectedModuleWaiting}>
                        다음 모듈로
                      </button>
                    </div>
                  ) : null}
                  {showCompletionActions ? (
                    <div className="completion-actions" aria-label="학습 종료">
                      <button type="button" className="primary" onClick={() => void sendAnswer(FINISH_CONFIRMATION_CHOICE)} disabled={busy}>
                        학습 종료
                      </button>
                      <button type="button" onClick={focusReviewComposer} disabled={busy}>
                        더 짚어보기
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {selectedModuleReadOnly && !sessionReadOnly && !allModulesCovered ? (
                <div className="read-only-session">
                  <p>완료된 module의 과거 대화입니다.</p>
                  {canContinueFromCompletedModule ? (
                    <button className="wide-button primary" onClick={continueFromCompletedModule} disabled={busy}>
                      <Play size={16} /> 다음 모듈로
                    </button>
                  ) : null}
                </div>
              ) : sessionReadOnly ? (
                <div className="read-only-session">
                  <p>{session.status === "completed" ? "Completed session opened for review." : "Archived session opened for review."}</p>
                  <button className="wide-button primary" onClick={() => startSession("new")} disabled={busy}>
                    <MessageSquare size={16} /> Start new from this material
                  </button>
                </div>
              ) : (
                <ChatComposer
                  key={`${session.id}:${selectedModuleId || "all"}`}
                  busy={busy}
                  disabled={selectedModuleWaiting}
                  autoFocusToken={composerFocusToken}
                  placeholder={
                    selectedModuleWaiting
                      ? "이 module을 시작하면 질문할 수 있습니다"
                      : allModulesCovered
                        ? "더 짚어 보고 싶은 부분을 적어 주세요"
                        : "궁금한 점을 묻거나 위 탐색 경로 중 하나를 선택하세요"
                  }
                  onSend={sendAnswer}
                />
              )}
            </>
          ) : artifacts ? (
            <div className="empty-state">
              <h3>{courseTitle}</h3>
              <p>{artifacts.coursePlan.subtitle}</p>
              {overviewModules.length ? (
                <div className="module-grid">
                  {overviewModules.map((module) => {
                    const learningGoal = displayableLearningGoal(module);
                    return (
                      <div key={module.id} className="module-tile">
                        <strong title={displayableOutlineTitle(module.title) || displayableCourseTitle(module.title)}>
                          {displayableOutlineTitle(module.title) || displayableCourseTitle(module.title)}
                        </strong>
                        {learningGoal ? <span>{learningGoal}</span> : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
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
            <div className="inspector-tabs" role="tablist" aria-label="Inspector sections">
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === "sessions"}
                aria-controls="inspector-sessions-panel"
                className={inspectorTab === "sessions" ? "active" : ""}
                onClick={() => setInspectorTab("sessions")}
              >
                Sessions
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === "modules"}
                aria-controls="inspector-modules-panel"
                className={inspectorTab === "modules" ? "active" : ""}
                onClick={() => setInspectorTab("modules")}
              >
                Modules
              </button>
            </div>
            {inspectorTab === "modules" ? (
              <section className="inspector-section inspector-tab-panel" id="inspector-modules-panel" role="tabpanel">
                <p className="inspector-count">{inspectorModules.length} module{inspectorModules.length === 1 ? "" : "s"}</p>
                <div className="outline-list">
                  {inspectorModules.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`outline-row ${item.status} ${selectedModuleId === item.id ? "active" : ""}`}
                      onClick={() => selectModuleFromOutline(item.id, item.status)}
                      disabled={busy}
                      title={item.title}
                    >
                      <span>{item.title}</span>
                      <small>{item.status.replace(/_/g, " ")}</small>
                    </button>
                  ))}
                </div>
              </section>
            ) : (
              <section className="inspector-section inspector-tab-panel" id="inspector-sessions-panel" role="tabpanel">
                <p className="inspector-count">{state.sessions.length} session{state.sessions.length === 1 ? "" : "s"}</p>
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
            )}
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
            await refreshProjects();
          }}
        />
      ) : null}
      {aboutOpen ? <AboutModal onClose={() => setAboutOpen(false)} /> : null}

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
      {preparedImport ? (
        <SourceImportModal request={request} prepared={preparedImport} onCancel={cancelPreparedImport} onImported={finishPreparedImport} />
      ) : null}
    </div>
  );
}
