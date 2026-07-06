import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Archive, BookOpen, Check, Info, Loader2, MessageSquare, Moon, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Play, Send, Settings, Sun, Trash2, Upload } from "lucide-react";
import type { MaterialSummary, PreparedSourceImport, ProjectArchiveExport, ProjectSummary, SourceSummary } from "../../shared/rpc-types";
import type { AppSettings, AiProviderStatus, ChatSubmitShortcut, ProviderModel } from "../../shared/settings-types";
import type { MaterialAnnotation, MaterialArtifacts } from "../../shared/artifact-types";
import type { SessionSnapshot, SessionSummary, SourceRef, TutorContext, TutorMessage, TutorPrefetchStatus } from "../../shared/tutor-types";
import { displayableCourseTitle, displayableHeadingPath, displayableOutlineTitle } from "../../shared/display-title";
import { SettingsModal } from "./components/SettingsModal";
import { VisualRenderer } from "./components/VisualRenderer";
import { MarkdownContent } from "./components/MarkdownContent";
import { TutorBlockRenderer } from "./components/TutorBlockRenderer";
import { ImmersiveSourceView } from "./components/ImmersiveSourceView";
import { LearningSelectionLookup } from "./components/LearningSelectionLookup";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProjectDropdown } from "./components/ProjectDropdown";
import { SourceImportModal } from "./components/SourceImportModal";
import { AboutModal } from "./components/AboutModal";
import { SourceFigureCard } from "./components/SourceFigureCard";
import { LearningBuddy } from "./components/LearningBuddy";
import { stripFigureMarkdown } from "./figure-text";
import { playAnswerReadySound, primeAnswerReadySound } from "./notification-sound";
import { nextPrefetchStatusForSession } from "./prefetch-status";
import { shouldSubmitTextArea } from "./submit-shortcut";

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
type AppTheme = "light" | "dark";

const PROGRESSION_CHOICES = new Set(["계속해줘", "계속해줘.", "다음 진도로 넘어가주세요.", "다음 대목으로 넘어가주세요.", "다음 문단으로 넘어가주세요.", "다음 모듈로 넘어가주세요.", "진도로 돌아갈게요."]);
const FINISH_CONFIRMATION_CHOICE = "네, 마칠게요.";
const FALLBACK_CHOICES = ["힌트를 하나만 더 주세요.", "예시 답변을 하나 보여주세요.", "이 질문을 더 쉽게 다시 물어봐 주세요."];
const EMPTY_MESSAGES: TutorMessage[] = [];
const READY_STATUS = "Ready";
const TUTOR_THINKING_STATUS = "Tutor is thinking";
const BUDDY_CONTEXT_EXCERPT_CHARS = 520;
const BUDDY_CONTEXT_MAX_CHARS = 1800;

function resolveTheme(mode: AppSettings["theme"] | undefined, systemDark: boolean): AppTheme {
  if (mode === "dark" || mode === "light") return mode;
  return systemDark ? "dark" : "light";
}

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

function prefetchTargetLabel(status: TutorPrefetchStatus | null) {
  if (!status?.targetEvent) return "";
  if (status.targetEvent === "continue_chunk") return "현재 대목의 나머지 설명";
  if (status.targetEvent === "next_chunk") return "다음 대목";
  if (status.targetEvent === "start_module") return "다음 모듈";
  if (status.targetEvent === "finish_prompt") return "마무리";
  return "";
}

function continueButtonTitle(status: TutorPrefetchStatus | null) {
  const target = prefetchTargetLabel(status);
  if (status?.status === "generating") return target ? `${target}을 미리 준비하고 있습니다.` : "이어질 설명을 미리 준비하고 있습니다.";
  if (status?.status === "ready") return target ? `${target}이 준비되었습니다.` : "이어질 설명이 준비되었습니다.";
  if (status?.status === "failed") return "미리 준비하지 못했습니다. 누르면 바로 새로 요청합니다.";
  return "계속 진행";
}

function displayableLearningGoal(module: CoursePlanModule) {
  const goal = module.learningGoal.trim();
  if (!goal) return "";
  const boilerplate = /^원문을\s*직접\s*읽지\s*않아도\s*.+의\s*핵심\s*주장과\s*긴장을\s*설명할\s*수\s*있다\.?$/;
  return boilerplate.test(goal) ? "" : goal;
}

function displayableSourceName(source: SourceSummary) {
  const rawName = source.originalFileName || source.title;
  const fileName = rawName.split(/[\\/]/).filter(Boolean).pop() || source.title;
  return fileName.replace(/\.[^.]+$/u, "").trim() || source.title;
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

function compactInlineText(value: string, limit: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function truncateBuddyContext(value: string) {
  const compact = value
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (compact.length <= BUDDY_CONTEXT_MAX_CHARS) return compact;
  return `${compact.slice(0, BUDDY_CONTEXT_MAX_CHARS - 3).trim()}...`;
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

function AnswerSourceRefs({ refs, materialId, request }: { refs: SourceRef[]; materialId: string; request: RpcRequest }) {
  if (!refs.length) return null;
  return (
    <div className="answer-source-list">
      {refs.map((ref) => (
        <article key={ref.chunkId} className="answer-source-ref" data-lookup-chunk-id={ref.chunkId}>
          <strong>{ref.title}</strong>
          {cleanLocator(ref.locator) ? <small>{cleanLocator(ref.locator)}</small> : null}
          <MarkdownContent content={ref.text} compact />
          {ref.figures?.length ? (
            <div className="answer-source-figures">
              {ref.figures.map((figure) => (
                <SourceFigureCard key={figure.id} figure={figure} materialId={materialId} request={request} compact contextChunkIds={[ref.chunkId]} />
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function annotationKindLabel(kind: MaterialAnnotation["kind"]) {
  if (kind === "define") return "정의";
  if (kind === "lookup") return "위키 요약";
  if (kind === "question") return "추가 질문";
  if (kind === "image") return "이미지";
  if (kind === "note") return "노트";
  return "표시";
}

function AnnotationSourceLinks({ sourceMeta }: { sourceMeta: MaterialAnnotation["sourceMeta"] }) {
  if (!sourceMeta.length) return null;
  return (
    <div className="lookup-source-meta">
      {sourceMeta.map((source, index) => (
        source.url ? (
          <a key={`${source.title}-${index}`} href={source.url} target="_blank" rel="noreferrer">
            {source.provider || "Source"}: {source.title}
          </a>
        ) : (
          <span key={`${source.title}-${index}`}>
            {source.provider || "Source"}: {source.title}
          </span>
        )
      ))}
    </div>
  );
}

function ChatSavedAnnotationCard({ annotation, onDelete }: { annotation: MaterialAnnotation; onDelete: (annotationId: string) => void }) {
  const result = annotation.result;
  const isQuestion = annotation.kind === "question" && result.kind === "question";
  return (
    <article className={`chat-annotation-card ${annotation.kind}`}>
      <header>
        <span>{annotationKindLabel(annotation.kind)}</span>
        {isQuestion ? null : <strong>{annotation.selectedText}</strong>}
        <button type="button" onClick={() => onDelete(annotation.id)} title="삭제">
          <Trash2 size={14} />
        </button>
      </header>
      {result.kind === "define" || result.kind === "lookup" || result.kind === "question" ? (
        <>
          {isQuestion ? <em className="chat-annotation-selected-text">{annotation.selectedText}</em> : null}
          {result.kind === "question" && result.question ? (
            <blockquote className="chat-annotation-question">{result.question}</blockquote>
          ) : null}
          <MarkdownContent content={result.body} compact />
          <AnnotationSourceLinks sourceMeta={annotation.sourceMeta} />
        </>
      ) : result.kind === "image" ? (
        result.images.length ? (
          <div className="lookup-image-grid">
            {result.images.map((image, index) => (
              <a
                key={`${image.title}-${image.pageUrl || image.imageUrl || index}`}
                href={image.pageUrl || image.imageUrl || image.thumbnailUrl}
                target="_blank"
                rel="noreferrer"
                title={image.title}
              >
                <img src={image.thumbnailUrl} alt={image.title} loading="lazy" />
              </a>
            ))}
          </div>
        ) : null
      ) : result.kind === "note" ? (
        <p>{result.note}</p>
      ) : (
        <p>저장된 표시입니다.</p>
      )}
    </article>
  );
}

function ChatSavedAnnotations({ annotations, onDelete }: { annotations: MaterialAnnotation[]; onDelete: (annotationId: string) => void }) {
  if (!annotations.length) return null;
  return (
    <div className="chat-annotation-list" aria-label="저장된 선택 설명">
      {annotations.map((annotation) => (
        <ChatSavedAnnotationCard key={annotation.id} annotation={annotation} onDelete={onDelete} />
      ))}
    </div>
  );
}

const ChatLog = memo(function ChatLog({
  messages,
  tutorThinking,
  expandedSourceMessages,
  sourceRefById,
  materialId,
  annotations,
  request,
  onToggleSource,
  onDeleteAnnotation,
}: {
  messages: TutorMessage[];
  tutorThinking: boolean;
  expandedSourceMessages: Set<string>;
  sourceRefById: Map<string, SourceRef>;
  materialId: string;
  annotations: MaterialAnnotation[];
  request: RpcRequest;
  onToggleSource: (messageId: string) => void;
  onDeleteAnnotation: (annotationId: string) => void;
}) {
  const annotationPlacement = useMemo(() => {
    const assistantMessageIds = new Set(messages.filter((message) => message.role === "assistant").map((message) => message.id));
    const visibleChunkIds = new Set(messages.flatMap((message) => message.sourceRefs));
    const placed = new Set<string>();
    const groups = new Map<string, MaterialAnnotation[]>();
    const blockGroups = new Map<string, MaterialAnnotation[]>();

    function add(messageId: string, annotation: MaterialAnnotation) {
      const group = groups.get(messageId) || [];
      group.push(annotation);
      groups.set(messageId, group);
      placed.add(annotation.id);
    }

    function addBlock(blockId: string, annotation: MaterialAnnotation) {
      const group = blockGroups.get(blockId) || [];
      group.push(annotation);
      blockGroups.set(blockId, group);
      placed.add(annotation.id);
    }

    for (const annotation of annotations) {
      if (annotation.anchorBlockId && annotation.anchorMessageId && assistantMessageIds.has(annotation.anchorMessageId)) {
        addBlock(annotation.anchorBlockId, annotation);
        continue;
      }
      if (annotation.anchorMessageId && assistantMessageIds.has(annotation.anchorMessageId)) {
        add(annotation.anchorMessageId, annotation);
      }
    }

    for (const message of messages) {
      if (message.role !== "assistant" || !message.sourceRefs.length) continue;
      const refs = new Set(message.sourceRefs);
      for (const annotation of annotations) {
        if (placed.has(annotation.id) || !refs.has(annotation.chunkId)) continue;
        add(message.id, annotation);
      }
    }

    for (const group of groups.values()) {
      group.sort((a, b) => a.createdAt - b.createdAt);
    }
    for (const group of blockGroups.values()) {
      group.sort((a, b) => a.createdAt - b.createdAt);
    }
    const unplaced = annotations
      .filter((annotation) => !placed.has(annotation.id) && visibleChunkIds.has(annotation.chunkId))
      .sort((a, b) => a.createdAt - b.createdAt);
    return { groups, blockGroups, unplaced };
  }, [annotations, messages]);

  return (
    <div className="chat-log">
      {messages.map((message) => {
        const lookupChunkId = message.sourceRefs[0] || undefined;
        const savedAnnotations = annotationPlacement.groups.get(message.id) || [];
        return (
          <div
            key={message.id}
            className={`bubble ${message.role}`}
            data-lookup-chunk-id={lookupChunkId}
            data-lookup-message-id={message.id}
            data-chat-message-id={message.id}
            data-chat-role={message.role}
          >
            {message.role === "assistant" && message.blocks?.length ? (
              <TutorBlockRenderer
                blocks={message.blocks}
                sourceRefById={sourceRefById}
                fallbackSourceRefs={message.sourceRefs.map((id) => sourceRefById.get(id)).filter((ref): ref is SourceRef => Boolean(ref))}
                materialId={materialId}
                request={request}
                messageId={message.id}
                renderBlockAfter={(blockId) => {
                  const blockAnnotations = annotationPlacement.blockGroups.get(blockId) || [];
                  return blockAnnotations.length ? (
                    <ChatSavedAnnotations annotations={blockAnnotations} onDelete={onDeleteAnnotation} />
                  ) : null;
                }}
              />
            ) : (
              <MarkdownContent content={message.content} />
            )}
            {message.role === "assistant" && savedAnnotations.length ? (
              <ChatSavedAnnotations annotations={savedAnnotations} onDelete={onDeleteAnnotation} />
            ) : null}
            {message.role === "assistant" && message.sourceRefs.length ? (
              <div className="answer-sources">
                <button type="button" onClick={() => onToggleSource(message.id)}>
                  <BookOpen size={15} />
                  {expandedSourceMessages.has(message.id) ? "근거 닫기" : "근거 보기"}
                </button>
                {expandedSourceMessages.has(message.id) ? (
                  <AnswerSourceRefs
                    refs={message.sourceRefs.map((id) => sourceRefById.get(id)).filter((ref): ref is SourceRef => Boolean(ref))}
                    materialId={materialId}
                    request={request}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {annotationPlacement.unplaced.length ? (
        <div className="bubble assistant annotation-fallback">
          <ChatSavedAnnotations annotations={annotationPlacement.unplaced} onDelete={onDeleteAnnotation} />
        </div>
      ) : null}
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
  submitShortcut,
  onSend,
}: {
  busy: boolean;
  disabled: boolean;
  placeholder: string;
  autoFocusToken?: number;
  submitShortcut: ChatSubmitShortcut;
  onSend: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const trimmed = draft.trim();

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const cssMaxHeight = Number.parseFloat(window.getComputedStyle(textarea).maxHeight);
    const viewportMaxHeight = window.innerHeight * 0.28;
    const maxHeight = Number.isFinite(cssMaxHeight) ? Math.min(cssMaxHeight, viewportMaxHeight) : viewportMaxHeight;
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > nextHeight ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [draft, resizeTextarea]);

  useEffect(() => {
    if (!autoFocusToken || disabled) return;
    textareaRef.current?.focus();
    resizeTextarea();
  }, [autoFocusToken, disabled, resizeTextarea]);

  useEffect(() => {
    window.addEventListener("resize", resizeTextarea);
    return () => window.removeEventListener("resize", resizeTextarea);
  }, [resizeTextarea]);

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
          if (shouldSubmitTextArea(event, submitShortcut)) {
            event.preventDefault();
            void submit(event.currentTarget.value);
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
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
  const [prefetchStatus, setPrefetchStatus] = useState<TutorPrefetchStatus | null>(null);
  const [status, setStatus] = useState(READY_STATUS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [providerStatus, setProviderStatus] = useState<AiProviderStatus | null>(null);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [viewMode, setViewMode] = useState<"chat" | "source">("chat");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("sessions");
  const [leftPaneOpen, setLeftPaneOpen] = useState(true);
  const [rightPaneOpen, setRightPaneOpen] = useState(true);
  const [systemThemeDark, setSystemThemeDark] = useState(false);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const tutorSurfaceRef = useRef<HTMLElement | null>(null);
  const continueButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastFocusedReadyPrefetchKeyRef = useRef<string | null>(null);
  const answerReadyNotificationPendingRef = useRef(false);
  const latestNotifiedAssistantIdRef = useRef<string | null>(null);
  const latestAlignedAssistantKeyRef = useRef<string | null>(null);

  function queueAnswerReadySound() {
    answerReadyNotificationPendingRef.current = true;
    primeAnswerReadySound();
  }

  function cancelAnswerReadySound() {
    answerReadyNotificationPendingRef.current = false;
  }

  const theme = resolveTheme(settings?.theme, systemThemeDark);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemThemeDark(media.matches);
    const onChange = (event: MediaQueryListEvent) => setSystemThemeDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  async function toggleTheme() {
    const nextTheme: AppSettings["theme"] = theme === "dark" ? "light" : "dark";
    try {
      const saved = (await request("settings.updatePublic", { theme: nextTheme })) as AppSettings;
      setSettings(saved);
    } catch (error) {
      setStatus(`Theme update failed: ${(error as Error).message}`);
    }
  }

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
      setPrefetchStatus(null);
      setSelectedModuleId(null);
      setState((current) => ({ ...current, projects, sources: [], materials: [], sessions: [] }));
      setStatus(READY_STATUS);
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
    setPrefetchStatus(null);
    setSelectedModuleId(null);
    setStatus(READY_STATUS);
  }

  async function refreshSettings() {
    const [nextSettings, nextStatus] = await Promise.all([request("settings.getPublic", {}), request("aiProvider.status", {})]);
    setSettings(nextSettings as AppSettings);
    setProviderStatus(nextStatus as AiProviderStatus);
  }

  const refreshPrefetchStatus = useCallback(async (sessionId: string) => {
    try {
      const next = (await request("sessions.prefetchStatus", { sessionId })) as TutorPrefetchStatus;
      setPrefetchStatus(next);
    } catch {
      setPrefetchStatus(null);
    }
  }, [request]);

  useEffect(() => {
    void refreshProjects();
    void refreshSettings();
  }, []);

  useEffect(() => {
    function onExternalLinkClick(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      const href = anchor.href || anchor.getAttribute("href") || "";
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      event.preventDefault();
      event.stopPropagation();
      void request("app.openExternal", { url: url.toString() }).catch((error) => {
        console.warn("Failed to open external link", error);
      });
    }
    document.addEventListener("click", onExternalLinkClick, true);
    return () => {
      document.removeEventListener("click", onExternalLinkClick, true);
    };
  }, [request]);

  useEffect(() => {
    const onGeneration = (event: Event) => setStatus((event as CustomEvent<{ message: string }>).detail.message);
    const onIngestion = (event: Event) => setStatus((event as CustomEvent<{ message: string }>).detail.message);
    const onTutor = () => setStatus(TUTOR_THINKING_STATUS);
    const onTutorDone = () => setStatus(READY_STATUS);
    const onTutorError = (event: Event) => setStatus((event as CustomEvent<{ error: string }>).detail.error);
    const onPrefetchStatus = (event: Event) => {
      const detail = (event as CustomEvent<TutorPrefetchStatus>).detail;
      setPrefetchStatus((current) => nextPrefetchStatusForSession(current, detail, session?.id));
    };
    const onOpenAbout = () => setAboutOpen(true);
    window.addEventListener("generation-progress", onGeneration);
    window.addEventListener("ingestion-progress", onIngestion);
    window.addEventListener("tutor-started", onTutor);
    window.addEventListener("tutor-completed", onTutorDone);
    window.addEventListener("tutor-error", onTutorError);
    window.addEventListener("tutor-prefetch-status", onPrefetchStatus);
    window.addEventListener("app-open-about", onOpenAbout);
    return () => {
      window.removeEventListener("generation-progress", onGeneration);
      window.removeEventListener("ingestion-progress", onIngestion);
      window.removeEventListener("tutor-started", onTutor);
      window.removeEventListener("tutor-completed", onTutorDone);
      window.removeEventListener("tutor-error", onTutorError);
      window.removeEventListener("tutor-prefetch-status", onPrefetchStatus);
      window.removeEventListener("app-open-about", onOpenAbout);
    };
  }, [session?.id]);

  useEffect(() => {
    if (!session?.id) {
      setPrefetchStatus(null);
      return;
    }
    void refreshPrefetchStatus(session.id);
  }, [refreshPrefetchStatus, session?.id, session?.updatedAt]);

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
  // starts the prepared material from the topbar.
  async function learnFromSource(sourceId: string) {
    if (!activeProject) return;
    setBusy(true);
    setStatus("학습 자료 준비 중");
    try {
      const material = (await request("materials.generate", { projectId: activeProject.id, sourceIds: [sourceId] })) as MaterialSummary;
      const materials = (await request("materials.list", { projectId: activeProject.id })) as MaterialSummary[];
      setState((current) => ({ ...current, materials }));
      await selectMaterial(material);
      setStatus(READY_STATUS);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSource(source: SourceSummary) {
    if (!activeProject) return;
    const sourceName = displayableSourceName(source);
    const confirmed = window.confirm(`"${sourceName}" 소스와 연결된 학습 기록을 삭제할까요?\n\n생성된 material, session, annotation, and local files will be removed.`);
    if (!confirmed) return;
    const activeMaterialUsesSource = Boolean(activeMaterial?.sourceIds.includes(source.id));
    setBusy(true);
    setStatus("소스 삭제 중");
    try {
      await request("sources.delete", { projectId: activeProject.id, sourceId: source.id });
      const [sources, materials] = await Promise.all([
        request("sources.list", { projectId: activeProject.id }) as Promise<SourceSummary[]>,
        request("materials.list", { projectId: activeProject.id }) as Promise<MaterialSummary[]>,
      ]);
      setState((current) => ({ ...current, sources, materials, sessions: activeMaterialUsesSource ? [] : current.sessions }));
      if (activeMaterialUsesSource) {
        setActiveMaterial(null);
        setArtifacts(null);
        setSession(null);
        setContext(null);
        setPrefetchStatus(null);
        setSelectedModuleId(null);
      }
      setSourceNotice(`Deleted ${sourceName}`);
      setStatus(READY_STATUS);
    } catch (error) {
      setStatus(`소스 삭제 실패: ${(error as Error).message}`);
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

  async function refreshMaterialArtifacts(materialId: string) {
    const nextArtifacts = (await request("materials.getArtifacts", { materialId })) as MaterialArtifacts;
    setArtifacts(nextArtifacts);
    return nextArtifacts;
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
    setStatus(READY_STATUS);
  }

  // Core session starter, independent of activeMaterial state so it can be called right after
  // selectMaterial without waiting for a state tick. Both startSession and learnFromSource use it.
  async function beginSession(materialId: string, mode: "new" | "continue") {
    if (mode === "new") queueAnswerReadySound();
    setTutorThinking(true);
    setStatus(TUTOR_THINKING_STATUS);
    try {
      const result = (await request("sessions.start", { materialId, mode })) as { session: SessionSnapshot; context: TutorContext };
      await refreshMaterialArtifacts(result.session.materialId);
      setSession(result.session);
      setContext(result.context);
      setSelectedModuleId(result.session.currentModuleId);
      setInspectorTab("modules");
      setExpandedSourceMessages(new Set());
      await refreshSessions(materialId);
      void refreshPrefetchStatus(result.session.id);
      setStatus(READY_STATUS);
      return result;
    } catch (error) {
      cancelAnswerReadySound();
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
      await refreshMaterialArtifacts(result.session.materialId);
      setActiveMaterial((current) => current?.id === result.session.materialId ? current : state.materials.find((material) => material.id === result.session.materialId) || current);
      setSession(result.session);
      setContext(result.context);
      setSelectedModuleId(result.session.currentModuleId);
      setInspectorTab("modules");
      setExpandedSourceMessages(new Set());
      void refreshPrefetchStatus(result.session.id);
      setStatus(READY_STATUS);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSession(item: SessionSummary) {
    const confirmed = window.confirm(`"${item.title}" session을 삭제할까요?\n\n이 session의 대화 기록과 진행 상태가 삭제됩니다. Source와 material은 유지됩니다.`);
    if (!confirmed) return;
    setBusy(true);
    setStatus("세션 삭제 중");
    try {
      await request("sessions.delete", { sessionId: item.id });
      setState((current) => ({ ...current, sessions: current.sessions.filter((sessionItem) => sessionItem.id !== item.id) }));
      if (session?.id === item.id) {
        setSession(null);
        setContext(null);
        setSelectedModuleId(null);
        setExpandedSourceMessages(new Set());
        setPrefetchStatus(null);
      }
      setStatus(READY_STATUS);
    } catch (error) {
      setStatus(`세션 삭제 실패: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function sendAnswer(text: string) {
    if (!session || !text.trim()) return false;
    queueAnswerReadySound();
    const typedProgressionCommand = PROGRESSION_CHOICES.has(text.trim());
    let thinkingDelay: number | null = null;
    setBusy(true);
    setStatus(TUTOR_THINKING_STATUS);
    if (typedProgressionCommand && prefetchStatus?.status === "ready") {
      thinkingDelay = window.setTimeout(() => setTutorThinking(true), 300);
    } else {
      setTutorThinking(true);
    }
    try {
      const result = (await request("tutor.sendTurn", { sessionId: session.id, userText: text.trim() })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      setSelectedModuleId(result.session.currentModuleId);
      await refreshSessions(result.session.materialId);
      void refreshPrefetchStatus(result.session.id);
      setStatus(READY_STATUS);
      return true;
    } catch (error) {
      cancelAnswerReadySound();
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
      if (thinkingDelay) window.clearTimeout(thinkingDelay);
      setBusy(false);
      setTutorThinking(false);
    }
  }

  async function advanceLearning(mode: "paragraph" | "chunk" | "module") {
    if (!session || sessionReadOnly) return;
    queueAnswerReadySound();
    let thinkingDelay: number | null = null;
    setBusy(true);
    setStatus(TUTOR_THINKING_STATUS);
    if (mode === "paragraph" && prefetchStatus?.status === "ready") {
      thinkingDelay = window.setTimeout(() => setTutorThinking(true), 300);
    } else {
      setTutorThinking(true);
    }
    try {
      const result = (await request("sessions.advance", { sessionId: session.id, mode })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      setSelectedModuleId(result.session.currentModuleId);
      await refreshSessions(result.session.materialId);
      void refreshPrefetchStatus(result.session.id);
      setStatus(READY_STATUS);
    } catch (error) {
      cancelAnswerReadySound();
      setStatus(`진행 실패: ${(error as Error).message}`);
    } finally {
      if (thinkingDelay) window.clearTimeout(thinkingDelay);
      setBusy(false);
      setTutorThinking(false);
    }
  }

  async function returnToProgress() {
    if (!session || sessionReadOnly) return;
    queueAnswerReadySound();
    let thinkingDelay: number | null = null;
    setBusy(true);
    setStatus(TUTOR_THINKING_STATUS);
    if (prefetchStatus?.status === "ready") {
      thinkingDelay = window.setTimeout(() => setTutorThinking(true), 300);
    } else {
      setTutorThinking(true);
    }
    try {
      const result = (await request("sessions.returnToProgress", { sessionId: session.id })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      setSelectedModuleId(result.session.currentModuleId);
      await refreshSessions(result.session.materialId);
      void refreshPrefetchStatus(result.session.id);
      setStatus(READY_STATUS);
    } catch (error) {
      cancelAnswerReadySound();
      setStatus(`진도 복귀 실패: ${(error as Error).message}`);
    } finally {
      if (thinkingDelay) window.clearTimeout(thinkingDelay);
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
      setStatus(READY_STATUS);
    } catch (error) {
      setStatus(`Module 선택 실패: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function openSelectedModule() {
    if (!session || !selectedModuleId || sessionReadOnly) return;
    queueAnswerReadySound();
    setBusy(true);
    setTutorThinking(true);
    setStatus(TUTOR_THINKING_STATUS);
    try {
      const result = (await request("sessions.openModule", { sessionId: session.id, moduleId: selectedModuleId })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      setSelectedModuleId(result.session.currentModuleId);
      await refreshSessions(result.session.materialId);
      setStatus(READY_STATUS);
    } catch (error) {
      cancelAnswerReadySound();
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
  const latestAssistantForScrollId = useMemo(() => {
    return [...currentMessages].reverse().find((message) => message.role === "assistant")?.id || null;
  }, [currentMessages]);
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
  const sourceTitleById = useMemo(() => new Map(state.sources.map((source) => [source.id, source.title])), [state.sources]);
  const sourceTitlesForModule = useCallback((moduleId: string | null | undefined) => {
    const module = moduleId ? artifacts?.coursePlan.modules.find((item) => item.id === moduleId) : null;
    if (!module || !artifacts) return [];
    const titles: string[] = [];
    for (const chunkId of module.sourceChunkIds) {
      const sourceId = artifacts.sourceIndex[chunkId]?.sourceId;
      const title = sourceId ? sourceTitleById.get(sourceId) : undefined;
      if (title && !titles.includes(title)) titles.push(title);
    }
    return titles;
  }, [artifacts, sourceTitleById]);
  const displayModuleTitle = useCallback((module: { id: string; title: string }) => {
    return displayableOutlineTitle(module.title, sourceTitlesForModule(module.id)) || module.title;
  }, [sourceTitlesForModule]);
  const selectedModuleTitle = selectedModule ? displayModuleTitle(selectedModule) : "";

  useEffect(() => {
    if (viewMode !== "chat") {
      latestAlignedAssistantKeyRef.current = null;
      return;
    }
    if (!latestAssistantForScrollId) return;
    const alignmentKey = `${selectedModuleId || "all"}:${latestAssistantForScrollId}`;
    if (latestAlignedAssistantKeyRef.current === alignmentKey) return;
    latestAlignedAssistantKeyRef.current = alignmentKey;
    let secondFrame = 0;
    const alignLatestAssistant = () => {
      const surface = tutorSurfaceRef.current;
      if (!surface) return;
      const target = Array.from(surface.querySelectorAll<HTMLElement>("[data-chat-message-id]"))
        .find((element) => element.dataset.chatMessageId === latestAssistantForScrollId);
      if (!target) return;
      const surfaceRect = surface.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const topInset = 0;
      const nextTop = surface.scrollTop + targetRect.top - surfaceRect.top - topInset;
      const maxTop = Math.max(0, surface.scrollHeight - surface.clientHeight);
      surface.scrollTo({ top: Math.max(0, Math.min(nextTop, maxTop)), behavior: "auto" });
    };
    const firstFrame = requestAnimationFrame(() => {
      alignLatestAssistant();
      secondFrame = requestAnimationFrame(alignLatestAssistant);
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [latestAssistantForScrollId, selectedModuleId, viewMode]);

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
  const activeModuleTitle = activeModule ? displayModuleTitle(activeModule) : "";
  const buddyModuleTitle = activeModuleTitle || selectedModuleTitle;
  const progressPercent = totalChunks ? Math.round((reachedChunks / totalChunks) * 100) : 0;
  const latestAssistant = [...currentMessages].reverse().find((message) => message.role === "assistant");
  const latestAssistantId = latestAssistant?.id || null;
  const canReturnToProgress = !selectedModuleWaiting && (latestAssistant?.stateUpdate?.conversationMode === "detour" || latestAssistant?.stateUpdate?.turnMode === "digress");
  const continuePrefetchState =
    prefetchStatus?.status === "generating" || prefetchStatus?.status === "ready" || prefetchStatus?.status === "failed"
      ? prefetchStatus.status
      : "idle";
  const continueButtonClass = `continue-button prefetch-${continuePrefetchState}`;
  const useReadyReturnButton = canReturnToProgress && continuePrefetchState === "ready";
  const continueButtonAria = continuePrefetchState === "generating"
    ? "계속해줘, 이어질 설명 준비 중"
    : useReadyReturnButton
      ? "진도로 돌아가기, 이어질 설명 준비됨"
      : continuePrefetchState === "ready"
      ? "계속해줘, 이어질 설명 준비됨"
      : "계속해줘";

  useEffect(() => {
    if (!answerReadyNotificationPendingRef.current) return;
    if (!settings?.answerReadySound) {
      cancelAnswerReadySound();
      return;
    }
    if (tutorThinking || !latestAssistantId) return;
    if (latestNotifiedAssistantIdRef.current === latestAssistantId) {
      cancelAnswerReadySound();
      return;
    }
    latestNotifiedAssistantIdRef.current = latestAssistantId;
    cancelAnswerReadySound();
    const frame = requestAnimationFrame(() => {
      void playAnswerReadySound();
    });
    return () => cancelAnimationFrame(frame);
  }, [latestAssistantId, settings?.answerReadySound, tutorThinking]);

  // Once every chunk is covered, the tutor offers an explicit "마칠게요 / 더 질문 있어요" pair.
  // Normal turns show three exploratory choices, while chunk/module progression lives in
  // separate command buttons below the choices.
  const allModulesCovered = totalChunks > 0 && coveredChunks >= totalChunks;
  const showCompletionActions = Boolean(!sessionReadOnly && !selectedModuleWaiting && allModulesCovered);
  const showProgressActions = Boolean(!sessionReadOnly && !selectedModuleReadOnly && !allModulesCovered);
  useEffect(() => {
    if (viewMode !== "chat" || !showProgressActions || busy || selectedModuleWaiting) return;
    if (prefetchStatus?.status !== "ready") return;

    const readyKey = `${prefetchStatus.sessionId}:${prefetchStatus.updatedAt ?? "ready"}`;
    if (lastFocusedReadyPrefetchKeyRef.current === readyKey) return;
    lastFocusedReadyPrefetchKeyRef.current = readyKey;
    continueButtonRef.current?.focus({ preventScroll: true });
  }, [busy, prefetchStatus, selectedModuleWaiting, showProgressActions, viewMode]);

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
  const activeSourceId = activeMaterial && activeMaterial.sourceIds.length === 1 ? activeMaterial.sourceIds[0] : null;
  const activeSource = activeSourceId ? state.sources.find((source) => source.id === activeSourceId) || null : null;
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
      const figuresByChunk = new Map<string, MaterialArtifacts["figures"]>();
      for (const figure of artifacts.figures || []) {
        for (const chunkId of figure.sourceChunkIds) {
          const group = figuresByChunk.get(chunkId) || [];
          group.push(figure);
          figuresByChunk.set(chunkId, group);
        }
      }
      for (const chunk of artifacts.sourceChunks) {
        const meta = artifacts.sourceIndex[chunk.id];
        refs.set(chunk.id, {
          chunkId: chunk.id,
          title: displayableOutlineTitle(meta?.title || displayableHeadingPath(chunk.headingPath, " > ") || "Source") || "Source",
          locator: meta?.locator || chunk.locator,
          text: stripFigureMarkdown(chunk.text, figuresByChunk.get(chunk.id) || []),
          figures: figuresByChunk.get(chunk.id) || [],
        });
      }
    }
    return refs;
  }, [artifacts, context?.sourceRefs]);
  const buddyModuleContext = useMemo(() => {
    if (!artifacts) return null;
    const moduleId = activeModule?.id || selectedModuleId || session?.currentModuleId || artifacts.coursePlan.modules[0]?.id || null;
    const module = (moduleId ? artifacts.coursePlan.modules.find((item) => item.id === moduleId) : null) || artifacts.coursePlan.modules[0];
    if (!module) return null;

    const lecture = artifacts.lecturePlan?.modules.find((item) => item.moduleId === module.id);
    const conceptNames = artifacts.conceptMap
      .filter((concept) => module.conceptIds.includes(concept.id))
      .map((concept) => concept.name)
      .slice(0, 4)
      .join(", ");
    const currentChunkIdInModule = session?.currentChunkId && module.sourceChunkIds.includes(session.currentChunkId) ? session.currentChunkId : null;
    const orderedChunkIds = Array.from(new Set([currentChunkIdInModule, ...module.sourceChunkIds].filter((id): id is string => Boolean(id)))).slice(0, 3);
    const sourceLines = orderedChunkIds
      .map((chunkId) => {
        const ref = sourceRefById.get(chunkId);
        if (!ref?.text.trim()) return null;
        const label = chunkId === currentChunkIdInModule ? "Current source excerpt" : "Module source excerpt";
        const locator = ref.locator ? `, ${compactInlineText(ref.locator, 60)}` : "";
        return `${label} (${compactInlineText(ref.title, 80)}${locator}): ${compactInlineText(ref.text, BUDDY_CONTEXT_EXCERPT_CHARS)}`;
      })
      .filter((line): line is string => Boolean(line));

    return truncateBuddyContext([
      `Module: ${displayModuleTitle(module)}`,
      displayableLearningGoal(module) ? `Learning goal: ${displayableLearningGoal(module)}` : "",
      conceptNames ? `Concepts: ${conceptNames}` : "",
      lecture?.intrigue.surpriseLine ? `Interesting angle: ${compactInlineText(lecture.intrigue.surpriseLine, 220)}` : "",
      lecture?.intrigue.tension ? `Tension: ${compactInlineText(lecture.intrigue.tension, 220)}` : "",
      ...sourceLines,
    ].filter(Boolean).join("\n"));
  }, [activeModule?.id, artifacts, displayModuleTitle, selectedModuleId, session?.currentChunkId, session?.currentModuleId, sourceRefById]);
  const toggleSourceMessage = useCallback((messageId: string) => {
    setExpandedSourceMessages((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);
  const handleAnnotationSaved = useCallback((annotation: MaterialAnnotation) => {
    setArtifacts((current) => {
      if (!current || current.manifest.id !== annotation.materialId) return current;
      return {
        ...current,
        annotations: [annotation, ...(current.annotations || []).filter((item) => item.id !== annotation.id)],
      };
    });
  }, []);
  const handleAnnotationDeleted = useCallback((annotationId: string) => {
    setArtifacts((current) => current ? {
      ...current,
      annotations: (current.annotations || []).filter((annotation) => annotation.id !== annotationId),
    } : current);
  }, []);
  const deleteSavedAnnotation = useCallback(async (annotationId: string) => {
    const previous = artifacts;
    handleAnnotationDeleted(annotationId);
    try {
      await request("annotations.delete", { annotationId });
    } catch (error) {
      setArtifacts(previous);
      setStatus(`Annotation 삭제 실패: ${(error as Error).message}`);
    }
  }, [artifacts, handleAnnotationDeleted, request]);

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
  const defaultLookupChunkId = latestAssistant?.sourceRefs[0] || currentChunkId || artifacts?.sourceChunks[0]?.id || null;

  const importedSourceLabel = `${state.sources.length} source${state.sources.length === 1 ? "" : "s"} imported`;
  const shellClassName = [
    "app-shell",
    leftPaneOpen ? "" : "left-pane-collapsed",
    rightPaneOpen ? "" : "right-pane-collapsed",
  ].filter(Boolean).join(" ");
  const inspectorModules = useMemo(() => {
    if (context?.moduleOutline.length) {
      return context.moduleOutline.map((item) => ({
        ...item,
        title: displayModuleTitle(item),
      }));
    }
    return (artifacts?.coursePlan.modules || []).map((module, index) => ({
      id: module.id,
      title: displayModuleTitle(module),
      status: (index === 0 ? "in_progress" : "not_started") as ModuleStatus,
    }));
  }, [artifacts?.coursePlan.modules, context?.moduleOutline, displayModuleTitle]);

  return (
    <div className={shellClassName}>
      <aside className="sidebar">
        <button
          type="button"
          className="icon-button pane-edge-toggle left-pane-toggle"
          onClick={() => setLeftPaneOpen((open) => !open)}
          title={leftPaneOpen ? "Hide left pane" : "Show left pane"}
          aria-label={leftPaneOpen ? "Hide left pane" : "Show left pane"}
          aria-pressed={leftPaneOpen}
        >
          {leftPaneOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
        <div className="pane-content">
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
              {state.sources.map((source, sourceIndex) => {
                const isActive = activeSourceId === source.id;
                const sourceName = displayableSourceName(source);
                return (
                  <div
                    key={source.id}
                    className={`list-item source-learn-row ${isActive ? "active" : ""}`}
                    title={sourceName}
                  >
                    <button
                      type="button"
                      className="source-learn-main"
                      onClick={() => learnFromSource(source.id)}
                      disabled={!activeProject || busy}
                      title={sourceName}
                    >
                      <span className="source-row-index">{sourceIndex + 1}</span>
                      <span className="source-row-title">{sourceName}</span>
                    </button>
                    <button
                      type="button"
                      className="source-delete-button"
                      onClick={() => deleteSource(source)}
                      disabled={!activeProject || busy}
                      title={`${sourceName} 삭제`}
                      aria-label={`${sourceName} 삭제`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
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
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="project-title">{activeProject?.title || "Learning Workspace"}</p>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="icon-button theme-toggle"
              onClick={() => void toggleTheme()}
              title={theme === "dark" ? "Light theme" : "Dark theme"}
              aria-label={theme === "dark" ? "Light theme" : "Dark theme"}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
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
                  Source
                </button>
                <button type="button" className={viewMode === "chat" ? "active" : ""} onClick={() => setViewMode("chat")}>
                  Chat
                </button>
              </div>
              <button className="wide-button topbar-button primary" onClick={() => startSession("new")} disabled={busy}>
                <MessageSquare size={16} /> Start
              </button>
            </div>
          </section>
        ) : null}

        <div className="tutor-shell">
          <section className="tutor-surface" ref={tutorSurfaceRef}>
          {viewMode === "source" && artifacts ? (
            <ImmersiveSourceView
              artifacts={artifacts}
              sourceProgress={sourceProgress}
              sessionReadOnly={sessionReadOnly}
              displayHeadingPath={displayableHeadingPath}
              cleanSourceText={stripRepeatedSourceHeading}
              request={request}
              submitShortcut={settings?.chatSubmitShortcut || "cmd-enter"}
              onAnnotationSaved={handleAnnotationSaved}
              onAnnotationDeleted={handleAnnotationDeleted}
            />
          ) : session ? (
            <>
              <div className="lesson-header">
                <div>
                  <p className="eyebrow">Learning Session</p>
                  <h3>{selectedModuleTitle || activeModuleTitle || activeMaterial?.title || session.title}</h3>
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
                materialId={artifacts?.manifest.id || session.materialId}
                annotations={artifacts?.annotations || []}
                request={request}
                onToggleSource={toggleSourceMessage}
                onDeleteAnnotation={(annotationId) => void deleteSavedAnnotation(annotationId)}
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
                      {canReturnToProgress && !useReadyReturnButton ? (
                        <button type="button" onClick={returnToProgress} disabled={busy || selectedModuleWaiting}>
                          진도로 돌아가기
                        </button>
                      ) : null}
                      <button
                        ref={continueButtonRef}
                        type="button"
                        className={continueButtonClass}
                        onClick={() => (useReadyReturnButton ? returnToProgress() : advanceLearning("paragraph"))}
                        disabled={busy || selectedModuleWaiting}
                        title={useReadyReturnButton ? "원래 진도로 돌아갈 설명이 준비되었습니다." : continueButtonTitle(prefetchStatus)}
                        aria-label={continueButtonAria}
                      >
                        {continuePrefetchState === "generating" ? <Loader2 size={14} className="spin" aria-hidden="true" /> : null}
                        {continuePrefetchState === "ready" ? <Check size={14} aria-hidden="true" /> : null}
                        {useReadyReturnButton ? "진도로 돌아가기" : "계속해줘"}
                      </button>
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
              ) : null}
            </>
          ) : artifacts ? (
            <div className="empty-state">
              <h3>{courseTitle}</h3>
              <p>{artifacts.coursePlan.subtitle}</p>
              {overviewModules.length ? (
                <div className="module-grid">
                  {overviewModules.map((module) => {
                    const learningGoal = displayableLearningGoal(module);
                    const moduleTitle = displayModuleTitle(module) || displayableCourseTitle(module.title);
                    return (
                      <div key={module.id} className="module-tile">
                        <div className="module-tile-head">
                          <strong title={moduleTitle}>{moduleTitle}</strong>
                        </div>
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
          {viewMode === "chat" && artifacts ? (
            <LearningSelectionLookup
              rootRef={tutorSurfaceRef}
              materialId={artifacts.manifest.id}
              defaultChunkId={defaultLookupChunkId}
              request={request}
              submitShortcut={settings?.chatSubmitShortcut || "cmd-enter"}
              onAnnotationSaved={handleAnnotationSaved}
            />
          ) : null}
          </section>
          {viewMode === "chat" && session && !sessionReadOnly && !selectedModuleReadOnly ? (
            <ChatComposer
              key={`${session.id}:${selectedModuleId || "all"}`}
              busy={busy}
              disabled={selectedModuleWaiting}
              autoFocusToken={composerFocusToken}
              submitShortcut={settings?.chatSubmitShortcut || "cmd-enter"}
              placeholder={
                selectedModuleWaiting
                  ? "이 module을 시작하면 질문할 수 있습니다"
                  : allModulesCovered
                    ? "더 짚어 보고 싶은 부분을 적어 주세요"
                    : "궁금한 점을 묻거나 위 탐색 경로 중 하나를 선택하세요"
              }
              onSend={sendAnswer}
            />
          ) : null}
        </div>
        <LearningBuddy
          enabled={Boolean(settings?.learningBuddyEnabled)}
          active={Boolean(artifacts)}
          request={request}
          viewMode={viewMode}
          thinking={tutorThinking}
          prefetchState={continuePrefetchState}
          progressPercent={progressPercent}
          currentModuleTitle={buddyModuleTitle}
          currentModuleContext={buddyModuleContext}
          complete={allModulesCovered || session?.status === "completed"}
        />
      </main>

      <aside className="inspector">
        <button
          type="button"
          className="icon-button pane-edge-toggle right-pane-toggle"
          onClick={() => setRightPaneOpen((open) => !open)}
          title={rightPaneOpen ? "Hide right pane" : "Show right pane"}
          aria-label={rightPaneOpen ? "Hide right pane" : "Show right pane"}
          aria-pressed={rightPaneOpen}
        >
          {rightPaneOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        </button>
        <div className="pane-content">
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
                        <article key={item.id} className={`session-row ${session?.id === item.id ? "active" : ""}`}>
                          <button type="button" className="session-row-open" onClick={() => loadSession(item.id)} disabled={busy}>
                            <span className="session-row-main">
                              <strong>{item.title}</strong>
                              <small>{item.currentModuleTitle || "No current module"}</small>
                            </span>
                            <em className={`session-status ${item.status}`}>{item.status}</em>
                            <span className="session-row-meta">
                              <small>{new Date(item.updatedAt).toLocaleString()}</small>
                              <small>
                                {item.completedModuleCount}/{item.totalModuleCount || "?"} modules · {item.messageCount} messages
                              </small>
                            </span>
                          </button>
                          <button
                            type="button"
                            className="session-delete-button"
                            onClick={() => void deleteSession(item)}
                            disabled={busy}
                            title="세션 삭제"
                            aria-label={`${item.title} 세션 삭제`}
                          >
                            <Trash2 size={14} />
                          </button>
                        </article>
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
        </div>
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
