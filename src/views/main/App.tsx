import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { BookOpen, Check, Download, Info, Loader2, LocateFixed, MessageSquare, Moon, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pencil, Play, Send, Settings, Sparkles, Sun, Trash2, Upload, X } from "lucide-react";
import type { MaterialSummary, PreparedSourceImport, ProjectSummary, SourceSummary } from "../../shared/rpc-types";
import type { ProjectTransferExport, ProjectTransferPreview, SessionReadableExport } from "../../shared/project-transfer-types";
import type { AppSettings, AiProviderStatus, ChatSubmitShortcut, ProviderModel } from "../../shared/settings-types";
import type { MaterialAnnotation, MaterialArtifacts } from "../../shared/artifact-types";
import type { LearningMessageSetSummary, SessionSnapshot, SessionSummary, SourceRef, TutorContext, TutorMessage, TutorPrefetchStatus } from "../../shared/tutor-types";
import { displayableCourseTitle, displayableHeadingPath, displayableModuleTitle, displayableOutlineTitle, titleCasedSourceTitle } from "../../shared/display-title";
import { SettingsModal } from "./components/SettingsModal";
import { VisualRenderer } from "./components/VisualRenderer";
import { MarkdownContent } from "./components/MarkdownContent";
import { TutorBlockRenderer } from "./components/TutorBlockRenderer";
import { ImmersiveSourceView } from "./components/ImmersiveSourceView";
import { LearningSelectionLookup } from "./components/LearningSelectionLookup";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProjectDropdown } from "./components/ProjectDropdown";
import { ProjectTransferImportModal } from "./components/ProjectTransferImportModal";
import { SourceImportModal } from "./components/SourceImportModal";
import { AboutModal } from "./components/AboutModal";
import { SourceFigureCard } from "./components/SourceFigureCard";
import { LearningBuddy } from "./components/LearningBuddy";
import { SourceLearningPreview } from "./components/SourceLearningPreview";
import { AnnotationInlineScope } from "./components/AnnotationInlineScope";
import { QuestionThreadAnnotationCard } from "./components/QuestionThreadAnnotationCard";
import { figureIdForExplanationAnnotation } from "./figure-annotations";
import { stripFigureMarkdown } from "./figure-text";
import { placeAnnotationsForMessages, shouldRenderInlineAnnotation } from "./annotation-placement";
import { annotationCardId, focusAnnotationInline } from "./annotation-inline-links";
import { playAnswerReadySound, primeAnswerReadySound } from "./notification-sound";
import { continuePrefetchStateForPreparedRoute, continueReadyFocusKeyForPreparedRoute, nextPrefetchStatusForSession } from "./prefetch-status";
import { hasExpandedTextSelection, shouldAutoFocusReadyAction } from "./focus-management";
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
type DestructiveConfirmation = {
  title: string;
  body: string;
  detail?: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
};

const PROGRESSION_CHOICES = new Set(["계속해줘", "계속해줘.", "다음 진도로 넘어가주세요.", "다음 대목으로 넘어가주세요.", "다음 문단으로 넘어가주세요.", "다음 모듈로 넘어가주세요.", "진도로 돌아갈게요."]);
const FINISH_CONFIRMATION_CHOICE = "네, 마칠게요.";
const FALLBACK_CHOICES = ["힌트를 하나만 더 주세요.", "예시 답변을 하나 보여주세요.", "이 질문을 더 쉽게 다시 물어봐 주세요."];
const EMPTY_MESSAGES: TutorMessage[] = [];
const READY_STATUS = "Ready";
const TUTOR_THINKING_STATUS = "Tutor is thinking";
const BUDDY_CONTEXT_EXCERPT_CHARS = 520;
const BUDDY_CONTEXT_MAX_CHARS = 1800;
const LEFT_PANE_DEFAULT_WIDTH = 318;
const LEFT_PANE_MIN_WIDTH = 260;
const LEFT_PANE_MAX_WIDTH = 520;
const LEFT_PANE_WIDTH_STORAGE_KEY = "learnie.left-pane-width";

function clampLeftPaneWidth(width: number) {
  return Math.min(LEFT_PANE_MAX_WIDTH, Math.max(LEFT_PANE_MIN_WIDTH, Math.round(width)));
}

function initialLeftPaneWidth() {
  if (typeof window === "undefined") return LEFT_PANE_DEFAULT_WIDTH;
  const stored = Number.parseFloat(window.localStorage.getItem(LEFT_PANE_WIDTH_STORAGE_KEY) || "");
  return Number.isFinite(stored) ? clampLeftPaneWidth(stored) : LEFT_PANE_DEFAULT_WIDTH;
}

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
  return titleCasedSourceTitle(source.title, source.originalFileName);
}

function sourceLearningStatusLabel(status: SourceSummary["learningStatus"]) {
  if (status === "in_progress") return "학습 중";
  if (status === "completed") return "학습 완료";
  return "아직 시작하지 않음";
}

function DestructiveConfirmationModal({
  confirmation,
  busy,
  onCancel,
  onConfirm,
}: {
  confirmation: DestructiveConfirmation;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="destructive-confirm-title">
        <header className="confirm-header">
          <span className="confirm-icon" aria-hidden="true">
            <Trash2 size={18} />
          </span>
          <div>
            <p className="eyebrow">Confirm delete</p>
            <h2 id="destructive-confirm-title">{confirmation.title}</h2>
          </div>
        </header>
        <section className="confirm-body">
          <p>{confirmation.body}</p>
          {confirmation.detail ? <small>{confirmation.detail}</small> : null}
        </section>
        <footer className="modal-actions confirm-actions">
          <button type="button" className="wide-button" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button type="button" className="wide-button danger-action" onClick={onConfirm} disabled={busy} autoFocus>
            {busy ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}
            {confirmation.confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
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

function groupFigureExplanationAnnotations(annotations: MaterialAnnotation[]) {
  const groups = new Map<string, MaterialAnnotation[]>();
  for (const annotation of annotations) {
    const figureId = figureIdForExplanationAnnotation(annotation);
    if (!figureId) continue;
    const group = groups.get(figureId) || [];
    group.push(annotation);
    groups.set(figureId, group);
  }
  return groups;
}

function AnswerSourceRefs({
  refs,
  materialId,
  request,
  figureAnnotationsById,
  onAnnotationSaved,
  onAnnotationDeleted,
}: {
  refs: SourceRef[];
  materialId: string;
  request: RpcRequest;
  figureAnnotationsById: Map<string, MaterialAnnotation[]>;
  onAnnotationSaved?: (annotation: MaterialAnnotation) => void;
  onAnnotationDeleted?: (annotationId: string) => void;
}) {
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
                <SourceFigureCard
                  key={figure.id}
                  figure={figure}
                  materialId={materialId}
                  request={request}
                  compact
                  contextChunkIds={[ref.chunkId]}
                  savedAnnotations={figureAnnotationsById.get(figure.id) || []}
                  onAnnotationSaved={onAnnotationSaved}
                  onAnnotationDeleted={onAnnotationDeleted}
                />
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

function ChatSavedAnnotationCard({
  annotation,
  active,
  expanded,
  onToggle,
  onContinue,
  onLocate,
  onDelete,
}: {
  annotation: MaterialAnnotation;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  onContinue: (annotation: MaterialAnnotation) => void;
  onLocate: (annotation: MaterialAnnotation) => boolean;
  onDelete: (annotationId: string) => void;
}) {
  const result = annotation.result;
  const isQuestion = annotation.kind === "question" && (result.kind === "question" || result.kind === "question_thread");
  if (isQuestion) {
    return (
      <QuestionThreadAnnotationCard
        annotation={annotation}
        active={active}
        expanded={expanded}
        onToggle={onToggle}
        onContinue={onContinue}
        onLocate={onLocate}
        onDelete={onDelete}
      />
    );
  }
  return (
    <article id={annotationCardId(annotation.id)} className={`chat-annotation-card ${annotation.kind} ${active ? "annotation-card-active" : ""}`}>
      <header>
        <span>{annotationKindLabel(annotation.kind)}</span>
        {isQuestion ? null : <strong>{annotation.selectedText}</strong>}
        <button
          type="button"
          className="annotation-card-icon-button"
          onClick={() => onLocate(annotation)}
          title="원문 위치"
          aria-label="원문 위치"
        >
          <LocateFixed size={14} />
        </button>
        <button
          type="button"
          className="annotation-card-icon-button danger"
          onClick={() => onDelete(annotation.id)}
          title="삭제"
          aria-label="삭제"
        >
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
        <MarkdownContent content={result.note} compact />
      ) : (
        <p>저장된 표시입니다.</p>
      )}
    </article>
  );
}

function ChatSavedAnnotations({
  annotations,
  groupKey,
  expandedQuestionId,
  activeAnnotationId,
  onExpandedChange,
  onContinue,
  onLocate,
  onDelete,
}: {
  annotations: MaterialAnnotation[];
  groupKey: string;
  expandedQuestionId?: string | null;
  activeAnnotationId?: string | null;
  onExpandedChange: (groupKey: string, annotationId: string | null) => void;
  onContinue: (annotation: MaterialAnnotation) => void;
  onLocate: (annotation: MaterialAnnotation) => boolean;
  onDelete: (annotationId: string) => void;
}) {
  if (!annotations.length) return null;
  return (
    <div className="chat-annotation-list" aria-label="저장된 선택 설명">
      {annotations.map((annotation) => (
        <ChatSavedAnnotationCard
          key={annotation.id}
          annotation={annotation}
          active={activeAnnotationId === annotation.id}
          expanded={expandedQuestionId === annotation.id}
          onToggle={() => onExpandedChange(groupKey, expandedQuestionId === annotation.id ? null : annotation.id)}
          onContinue={onContinue}
          onLocate={onLocate}
          onDelete={onDelete}
        />
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
  onAnnotationSaved,
  onDeleteAnnotation,
  onContinueQuestionThread,
}: {
  messages: TutorMessage[];
  tutorThinking: boolean;
  expandedSourceMessages: Set<string>;
  sourceRefById: Map<string, SourceRef>;
  materialId: string;
  annotations: MaterialAnnotation[];
  request: RpcRequest;
  onToggleSource: (messageId: string) => void;
  onAnnotationSaved?: (annotation: MaterialAnnotation) => void;
  onDeleteAnnotation: (annotationId: string) => void;
  onContinueQuestionThread: (annotation: MaterialAnnotation) => void;
}) {
  const annotationPlacement = useMemo(() => placeAnnotationsForMessages(annotations, messages), [annotations, messages]);
  const figureAnnotationsById = useMemo(() => groupFigureExplanationAnnotations(annotations), [annotations]);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [expandedQuestionByGroup, setExpandedQuestionByGroup] = useState<Map<string, string>>(new Map());
  const activeAnnotationTimerRef = useRef<number | null>(null);
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const inlineAnnotations = useMemo(() => {
    const messageGroups = new Map<string, MaterialAnnotation[]>();
    const blockGroups = new Map<string, MaterialAnnotation[]>();
    for (const annotation of annotations) {
      if (!shouldRenderInlineAnnotation(annotation)) continue;
      if (annotation.surface !== "chat" && !annotation.anchorMessageId && !annotation.anchorBlockId) continue;
      if (annotation.anchorBlockId) {
        const group = blockGroups.get(annotation.anchorBlockId) || [];
        group.push(annotation);
        blockGroups.set(annotation.anchorBlockId, group);
      } else if (annotation.anchorMessageId) {
        const group = messageGroups.get(annotation.anchorMessageId) || [];
        group.push(annotation);
        messageGroups.set(annotation.anchorMessageId, group);
      }
    }
    return { messageGroups, blockGroups };
  }, [annotations]);

  useEffect(() => {
    setExpandedQuestionByGroup(new Map());
  }, [materialId]);

  useEffect(() => {
    return () => {
      if (activeAnnotationTimerRef.current != null) {
        window.clearTimeout(activeAnnotationTimerRef.current);
      }
    };
  }, []);

  function pulseAnnotation(annotationId: string) {
    setActiveAnnotationId(annotationId);
    if (activeAnnotationTimerRef.current != null) {
      window.clearTimeout(activeAnnotationTimerRef.current);
    }
    activeAnnotationTimerRef.current = window.setTimeout(() => {
      setActiveAnnotationId(null);
      activeAnnotationTimerRef.current = null;
    }, 1600);
  }

  function annotationGroupKey(annotation: MaterialAnnotation) {
    if (annotation.anchorBlockId) return `block:${annotation.anchorBlockId}`;
    if (annotation.anchorMessageId) return `message:${annotation.anchorMessageId}`;
    return "unplaced";
  }

  function setExpandedQuestion(groupKey: string, annotationId: string | null) {
    setExpandedQuestionByGroup((current) => {
      const next = new Map(current);
      if (annotationId) next.set(groupKey, annotationId);
      else next.delete(groupKey);
      return next;
    });
  }

  function scrollToAnnotationCard(annotation: MaterialAnnotation) {
    if (annotation.kind === "question") setExpandedQuestion(annotationGroupKey(annotation), annotation.id);
    pulseAnnotation(annotation.id);
    const card = chatLogRef.current?.querySelector<HTMLElement>(`#${annotationCardId(annotation.id)}`);
    if (card) {
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (chatLogRef.current) focusAnnotationInline(chatLogRef.current, annotation.id);
  }

  function scrollToAnnotationInline(annotation: MaterialAnnotation) {
    pulseAnnotation(annotation.id);
    return chatLogRef.current ? focusAnnotationInline(chatLogRef.current, annotation.id) : false;
  }

  return (
    <div className="chat-log" ref={chatLogRef}>
      {messages.map((message) => {
        const lookupChunkId = message.sourceRefs[0] || undefined;
        const savedAnnotations = annotationPlacement.groups.get(message.id) || [];
        const messageInlineAnnotations = inlineAnnotations.messageGroups.get(message.id) || [];
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
                inlineAnnotationsByBlockId={inlineAnnotations.blockGroups}
                activeAnnotationId={activeAnnotationId}
                onActivateAnnotation={scrollToAnnotationCard}
                figureAnnotationsById={figureAnnotationsById}
                onAnnotationSaved={onAnnotationSaved}
                onAnnotationDeleted={onDeleteAnnotation}
                renderBlockAfter={(blockId) => {
                  const blockAnnotations = annotationPlacement.blockGroups.get(blockId) || [];
                  return blockAnnotations.length ? (
                    <ChatSavedAnnotations
                      annotations={blockAnnotations}
                      groupKey={`block:${blockId}`}
                      expandedQuestionId={expandedQuestionByGroup.get(`block:${blockId}`)}
                      activeAnnotationId={activeAnnotationId}
                      onExpandedChange={setExpandedQuestion}
                      onContinue={onContinueQuestionThread}
                      onLocate={scrollToAnnotationInline}
                      onDelete={onDeleteAnnotation}
                    />
                  ) : null;
                }}
              />
            ) : (
              <AnnotationInlineScope
                annotations={messageInlineAnnotations}
                activeAnnotationId={activeAnnotationId}
                onActivateAnnotation={scrollToAnnotationCard}
                scopeProps={{
                  "data-lookup-chunk-id": lookupChunkId,
                  "data-lookup-message-id": message.id,
                  "data-chat-message-id": message.id,
                  "data-chat-role": message.role,
                }}
              >
                <MarkdownContent content={message.content} />
              </AnnotationInlineScope>
            )}
            {message.role === "assistant" && savedAnnotations.length ? (
              <ChatSavedAnnotations
                annotations={savedAnnotations}
                groupKey={`message:${message.id}`}
                expandedQuestionId={expandedQuestionByGroup.get(`message:${message.id}`)}
                activeAnnotationId={activeAnnotationId}
                onExpandedChange={setExpandedQuestion}
                onContinue={onContinueQuestionThread}
                onLocate={scrollToAnnotationInline}
                onDelete={onDeleteAnnotation}
              />
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
                    figureAnnotationsById={figureAnnotationsById}
                    onAnnotationSaved={onAnnotationSaved}
                    onAnnotationDeleted={onDeleteAnnotation}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {annotationPlacement.unplaced.length ? (
        <div className="bubble assistant annotation-fallback">
          <ChatSavedAnnotations
            annotations={annotationPlacement.unplaced}
            groupKey="unplaced"
            expandedQuestionId={expandedQuestionByGroup.get("unplaced")}
            activeAnnotationId={activeAnnotationId}
            onExpandedChange={setExpandedQuestion}
            onContinue={onContinueQuestionThread}
            onLocate={scrollToAnnotationInline}
            onDelete={onDeleteAnnotation}
          />
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
  const [projectTransferPreview, setProjectTransferPreview] = useState<ProjectTransferPreview | null>(null);
  const [sessionExportBusyId, setSessionExportBusyId] = useState<string | null>(null);
  const [sourceNotice, setSourceNotice] = useState("");
  const [preparedImport, setPreparedImport] = useState<PreparedSourceImport | null>(null);
  const [expandedSourceMessages, setExpandedSourceMessages] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [batchActionBusy, setBatchActionBusy] = useState(false);
  const [sessionStartBusy, setSessionStartBusy] = useState(false);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [destructiveConfirmation, setDestructiveConfirmation] = useState<DestructiveConfirmation | null>(null);
  const [tutorThinking, setTutorThinking] = useState(false);
  const [prefetchStatus, setPrefetchStatus] = useState<TutorPrefetchStatus | null>(null);
  const [messageSetsByMaterial, setMessageSetsByMaterial] = useState<Record<string, LearningMessageSetSummary[]>>({});
  const [status, setStatus] = useState(READY_STATUS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [providerStatus, setProviderStatus] = useState<AiProviderStatus | null>(null);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [viewMode, setViewMode] = useState<"chat" | "source">("chat");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("sessions");
  const [leftPaneOpen, setLeftPaneOpen] = useState(true);
  const [leftPaneWidth, setLeftPaneWidth] = useState(initialLeftPaneWidth);
  const [leftPaneResizing, setLeftPaneResizing] = useState(false);
  const [rightPaneOpen, setRightPaneOpen] = useState(true);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [sourceTitleDraft, setSourceTitleDraft] = useState("");
  const [sourceRenameBusy, setSourceRenameBusy] = useState(false);
  const [systemThemeDark, setSystemThemeDark] = useState(false);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [resumeScrollAnchorId, setResumeScrollAnchorId] = useState<string | null>(null);
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const [sideChatResumeRequest, setSideChatResumeRequest] = useState<{ annotation: MaterialAnnotation; token: number } | null>(null);
  const [pendingAnnotationDeletion, setPendingAnnotationDeletion] = useState<MaterialAnnotation | null>(null);
  const tutorSurfaceRef = useRef<HTMLElement | null>(null);
  const continueButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastFocusedReadyActionKeyRef = useRef<string | null>(null);
  const userPointerDownRef = useRef(false);
  const answerReadyNotificationPendingRef = useRef(false);
  const latestNotifiedAssistantIdRef = useRef<string | null>(null);
  const latestAlignedAssistantKeyRef = useRef<string | null>(null);
  const sessionStartTokenRef = useRef(0);
  const pendingAnnotationDeletionRef = useRef<MaterialAnnotation | null>(null);
  const pendingAnnotationDeletionTimerRef = useRef<number | null>(null);
  const leftPaneResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

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
    const markPointerDown = () => { userPointerDownRef.current = true; };
    const clearPointerDown = () => { userPointerDownRef.current = false; };
    window.addEventListener("pointerdown", markPointerDown, true);
    window.addEventListener("pointerup", clearPointerDown, true);
    window.addEventListener("pointercancel", clearPointerDown, true);
    window.addEventListener("blur", clearPointerDown);
    return () => {
      window.removeEventListener("pointerdown", markPointerDown, true);
      window.removeEventListener("pointerup", clearPointerDown, true);
      window.removeEventListener("pointercancel", clearPointerDown, true);
      window.removeEventListener("blur", clearPointerDown);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(LEFT_PANE_WIDTH_STORAGE_KEY, String(leftPaneWidth));
  }, [leftPaneWidth]);

  useEffect(() => {
    if (!leftPaneResizing) return;
    document.body.classList.add("pane-resizing");
    function onPointerMove(event: globalThis.PointerEvent) {
      const drag = leftPaneResizeRef.current;
      if (!drag) return;
      setLeftPaneWidth(clampLeftPaneWidth(drag.startWidth + event.clientX - drag.startX));
    }
    function finishResize() {
      leftPaneResizeRef.current = null;
      setLeftPaneResizing(false);
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    return () => {
      document.body.classList.remove("pane-resizing");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
  }, [leftPaneResizing]);

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
    sessionStartTokenRef.current += 1;
    setSessionStartBusy(false);
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
    void Promise.all(materials.map((material) => refreshMessageSets(material.id)));
  }

  async function refreshSources(projectId = activeProject?.id) {
    if (!projectId) return [];
    const sources = (await request("sources.list", { projectId })) as SourceSummary[];
    setState((current) => ({ ...current, sources }));
    return sources;
  }

  async function refreshSettings() {
    const [nextSettings, nextStatus] = await Promise.all([request("settings.getPublic", {}), request("aiProvider.status", {})]);
    setSettings(nextSettings as AppSettings);
    setProviderStatus(nextStatus as AiProviderStatus);
  }

  function confirmDestructive(confirmation: DestructiveConfirmation) {
    if (busy || confirmationBusy) return;
    setDestructiveConfirmation(confirmation);
  }

  async function runDestructiveConfirmation() {
    const confirmation = destructiveConfirmation;
    if (!confirmation) return;
    setConfirmationBusy(true);
    try {
      await confirmation.onConfirm();
      setDestructiveConfirmation(null);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setConfirmationBusy(false);
    }
  }

  function deleteProject(project: ProjectSummary) {
    confirmDestructive({
      title: `"${project.title}" 프로젝트를 삭제할까요?`,
      body: "소스, 생성된 material, session, annotation, local project files가 모두 삭제됩니다.",
      detail: "되돌릴 수 없습니다.",
      confirmLabel: "프로젝트 삭제",
      onConfirm: () => deleteProjectConfirmed(project),
    });
  }

  async function deleteProjectConfirmed(project: ProjectSummary) {
    const deletingActiveProject = activeProject?.id === project.id;
    setBusy(true);
    setStatus("Deleting project");
    try {
      if (deletingActiveProject && preparedImport) {
        await request("sources.cancelPreparedImport", { projectId: project.id, importId: preparedImport.id }).catch(() => undefined);
        setPreparedImport(null);
      }
      await request("projects.delete", { projectId: project.id });
      const projects = (await request("projects.list", {})) as ProjectSummary[];
      setState((current) => ({ ...current, projects }));
      if (deletingActiveProject) {
        if (projects[0]) {
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
        }
      }
      setSourceNotice("");
      setStatus(`Deleted ${project.title}`);
    } catch (error) {
      setStatus(`Project delete failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function chooseProjectTransfer() {
    setBusy(true);
    setStatus("프로젝트 transfer를 확인하는 중");
    try {
      const path = (await request("projects.chooseTransferFile", {})) as string;
      if (!path) {
        setStatus(READY_STATUS);
        return;
      }
      const preview = (await request("projects.prepareTransferImport", { path })) as ProjectTransferPreview;
      setProjectTransferPreview(preview);
      setStatus("프로젝트 transfer 준비 완료");
    } catch (error) {
      setStatus(`프로젝트 불러오기 실패: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function cancelProjectTransfer() {
    const preview = projectTransferPreview;
    setProjectTransferPreview(null);
    if (preview) await request("projects.cancelTransferImport", { importId: preview.importId }).catch(() => undefined);
    setStatus(READY_STATUS);
  }

  async function commitProjectTransfer() {
    const preview = projectTransferPreview;
    if (!preview) return;
    const mode = preview.classification === "fast_forward" ? "fast_forward" : "create_new";
    setBusy(true);
    setStatus("프로젝트 transfer를 적용하는 중");
    try {
      await request("projects.commitTransferImport", { importId: preview.importId, mode });
      setProjectTransferPreview(null);
      const projects = (await request("projects.list", {})) as ProjectSummary[];
      setState((current) => ({ ...current, projects }));
      const imported = projects.find((project) => project.id === preview.projectId);
      if (imported) await openProject(imported);
      setStatus(preview.classification === "no_changes" ? "이미 같은 프로젝트 상태입니다" : `${preview.projectTitle} 프로젝트를 불러왔습니다`);
    } catch (error) {
      setStatus(`프로젝트 불러오기 실패: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function exportProjectTransfer(project: ProjectSummary) {
    setBusy(true);
    setStatus("다른 컴퓨터용 project transfer를 만드는 중");
    try {
      const result = (await request("projects.exportTransfer", { projectId: project.id })) as ProjectTransferExport;
      setStatus(`${project.title}: ${result.fileName} 내보내기 완료`);
    } catch (error) {
      setStatus(`프로젝트 내보내기 실패: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const refreshPrefetchStatus = useCallback(async (sessionId: string) => {
    try {
      const next = (await request("sessions.prefetchStatus", { sessionId })) as TutorPrefetchStatus;
      setPrefetchStatus(next);
    } catch {
      setPrefetchStatus(null);
    }
  }, [request]);

  const refreshMessageSets = useCallback(async (materialId: string) => {
    try {
      const sets = (await request("materials.messageSetStatus", { materialId })) as LearningMessageSetSummary[];
      setMessageSetsByMaterial((current) => ({ ...current, [materialId]: sets }));
      return sets;
    } catch {
      setMessageSetsByMaterial((current) => ({ ...current, [materialId]: [] }));
      return [];
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
    const onMessageSetProgress = (event: Event) => {
      const detail = (event as CustomEvent<LearningMessageSetSummary>).detail;
      setMessageSetsByMaterial((current) => {
        const existing = current[detail.materialId] || [];
        return {
          ...current,
          [detail.materialId]: [detail, ...existing.filter((item) => item.id !== detail.id)].sort((a, b) => b.updatedAt - a.updatedAt),
        };
      });
    };
    const onOpenAbout = () => setAboutOpen(true);
    window.addEventListener("generation-progress", onGeneration);
    window.addEventListener("ingestion-progress", onIngestion);
    window.addEventListener("tutor-started", onTutor);
    window.addEventListener("tutor-completed", onTutorDone);
    window.addEventListener("tutor-error", onTutorError);
    window.addEventListener("tutor-prefetch-status", onPrefetchStatus);
    window.addEventListener("message-set-progress", onMessageSetProgress);
    window.addEventListener("app-open-about", onOpenAbout);
    return () => {
      window.removeEventListener("generation-progress", onGeneration);
      window.removeEventListener("ingestion-progress", onIngestion);
      window.removeEventListener("tutor-started", onTutor);
      window.removeEventListener("tutor-completed", onTutorDone);
      window.removeEventListener("tutor-error", onTutorError);
      window.removeEventListener("tutor-prefetch-status", onPrefetchStatus);
      window.removeEventListener("message-set-progress", onMessageSetProgress);
      window.removeEventListener("app-open-about", onOpenAbout);
    };
  }, [activeMaterial?.id, session?.id]);

  useEffect(() => {
    if (!session?.id) {
      setPrefetchStatus(null);
      return;
    }
    void refreshPrefetchStatus(session.id);
  }, [refreshPrefetchStatus, session?.id, session?.updatedAt]);

  async function chooseAndImportSources() {
    if (!activeProject) return;
    try {
      const paths = (await request("sources.openDialog", { projectId: activeProject.id })) as string[];
      if (!paths.length) {
        setSourceNotice("No files selected");
        return;
      }
      setBusy(true);
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

  async function prepareSourceInBackground(source: SourceSummary) {
    if (!activeProject || batchActionBusy) return;
    setBatchActionBusy(true);
    setStatus(`${displayableSourceName(source)} 메시지 준비 시작`);
    try {
      let material = state.materials.find((item) => item.sourceIds.length === 1 && item.sourceIds[0] === source.id) || null;
      if (!material) {
        material = (await request("materials.generate", { projectId: activeProject.id, sourceIds: [source.id] })) as MaterialSummary;
        const materials = (await request("materials.list", { projectId: activeProject.id })) as MaterialSummary[];
        setState((current) => ({ ...current, materials }));
      }
      const next = (await request("materials.prepareMessages", { materialId: material.id })) as LearningMessageSetSummary;
      setMessageSetsByMaterial((current) => ({
        ...current,
        [material!.id]: [next, ...(current[material!.id] || []).filter((item) => item.id !== next.id)],
      }));
      setStatus(READY_STATUS);
    } catch (error) {
      setStatus(`메시지 준비 실패: ${(error as Error).message}`);
    } finally {
      setBatchActionBusy(false);
    }
  }

  function beginSourceRename(source: SourceSummary) {
    if (sourceRenameBusy) return;
    setEditingSourceId(source.id);
    setSourceTitleDraft(source.title);
  }

  function cancelSourceRename() {
    if (sourceRenameBusy) return;
    setEditingSourceId(null);
    setSourceTitleDraft("");
  }

  async function saveSourceTitle(source: SourceSummary) {
    if (!activeProject || sourceRenameBusy) return;
    const title = sourceTitleDraft.replace(/\s+/gu, " ").trim();
    if (!title) {
      setSourceNotice("소스 제목을 입력하세요.");
      return;
    }
    if (title === source.title) {
      cancelSourceRename();
      return;
    }

    setSourceRenameBusy(true);
    setSourceNotice("");
    try {
      const renamed = (await request("sources.rename", {
        projectId: activeProject.id,
        sourceId: source.id,
        title,
      })) as SourceSummary;
      setState((current) => ({
        ...current,
        sources: current.sources.map((item) => item.id === renamed.id ? renamed : item),
      }));
      setEditingSourceId(null);
      setSourceTitleDraft("");
      setSourceNotice(`제목을 “${displayableSourceName(renamed)}”(으)로 변경했습니다.`);
    } catch (error) {
      setSourceNotice(`제목 변경 실패: ${(error as Error).message}`);
    } finally {
      setSourceRenameBusy(false);
    }
  }

  function startLeftPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!leftPaneOpen || event.button !== 0) return;
    event.preventDefault();
    leftPaneResizeRef.current = { startX: event.clientX, startWidth: leftPaneWidth };
    setLeftPaneResizing(true);
  }

  function deleteSource(source: SourceSummary) {
    if (!activeProject) return;
    const sourceName = displayableSourceName(source);
    confirmDestructive({
      title: `"${sourceName}" 소스를 삭제할까요?`,
      body: "연결된 material, session, annotation, local files가 삭제됩니다.",
      detail: "Project는 유지됩니다.",
      confirmLabel: "소스 삭제",
      onConfirm: () => deleteSourceConfirmed(source),
    });
  }

  async function deleteSourceConfirmed(source: SourceSummary) {
    if (!activeProject) return;
    const sourceName = displayableSourceName(source);
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
    sessionStartTokenRef.current += 1;
    setSessionStartBusy(false);
    setActiveMaterial(material);
    const [nextArtifacts, sessions] = await Promise.all([
      request("materials.getArtifacts", { materialId: material.id }) as Promise<MaterialArtifacts>,
      request("sessions.list", { materialId: material.id }) as Promise<SessionSummary[]>,
      refreshMessageSets(material.id),
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
  async function beginSession(materialId: string, mode: "new" | "continue", sessionId?: string) {
    const requestToken = ++sessionStartTokenRef.current;
    if (mode === "new") queueAnswerReadySound();
    setTutorThinking(true);
    setStatus(TUTOR_THINKING_STATUS);
    try {
      const result = (await request("sessions.start", { materialId, mode, sessionId })) as { session: SessionSnapshot; context: TutorContext; messageSet: LearningMessageSetSummary };
      if (requestToken !== sessionStartTokenRef.current) return null;
      await refreshMaterialArtifacts(result.session.materialId);
      setSession(result.session);
      setContext(result.context);
      setMessageSetsByMaterial((current) => ({
        ...current,
        [materialId]: [result.messageSet, ...(current[materialId] || []).filter((item) => item.id !== result.messageSet.id)],
      }));
      setSelectedModuleId(result.session.currentModuleId);
      setResumeScrollAnchorId(mode === "continue" ? result.session.lastRevealedMessageId : null);
      setInspectorTab("modules");
      setExpandedSourceMessages(new Set());
      await Promise.all([refreshSessions(materialId), refreshSources(result.session.projectId)]);
      void refreshMessageSets(materialId);
      setStatus(READY_STATUS);
      return result;
    } catch (error) {
      if (requestToken !== sessionStartTokenRef.current) return null;
      cancelAnswerReadySound();
      setStatus((error as Error).message);
      return null;
    } finally {
      if (requestToken === sessionStartTokenRef.current) {
        setTutorThinking(false);
        setSessionStartBusy(false);
      }
    }
  }

  async function startSession(mode: "new" | "continue") {
    if (!activeMaterial || sessionStartBusy) return;
    setSessionStartBusy(true);
    await beginSession(activeMaterial.id, mode);
  }

  async function startOrContinueSession() {
    if (!activeMaterial || sessionStartBusy) return;
    const existing = state.sessions.find((item) => item.status === "active");
    setSessionStartBusy(true);
    await beginSession(activeMaterial.id, existing ? "continue" : "new", existing?.id);
  }

  async function startBatchMessages(force = false) {
    if (!activeMaterial || batchActionBusy) return;
    setBatchActionBusy(true);
    setStatus("학습 메시지를 background에서 준비합니다");
    try {
      const next = (await request("materials.prepareMessages", {
        materialId: activeMaterial.id,
        forceNewVersion: force,
      })) as LearningMessageSetSummary;
      setMessageSetsByMaterial((current) => ({
        ...current,
        [activeMaterial.id]: [next, ...(current[activeMaterial.id] || []).filter((item) => item.id !== next.id)],
      }));
      setStatus(READY_STATUS);
    } catch (error) {
      setStatus(`전체 메시지 생성 실패: ${(error as Error).message}`);
    } finally {
      setBatchActionBusy(false);
    }
  }

  async function cancelBatchMessages() {
    const currentSet = activeMessageSet;
    if (!currentSet || batchActionBusy) return;
    setBatchActionBusy(true);
    try {
      const next = (await request("materials.pauseMessageSetGeneration", { messageSetId: currentSet.id })) as LearningMessageSetSummary;
      setMessageSetsByMaterial((current) => ({
        ...current,
        [next.materialId]: [next, ...(current[next.materialId] || []).filter((item) => item.id !== next.id)],
      }));
      setStatus(READY_STATUS);
    } catch (error) {
      setStatus(`생성 중지 실패: ${(error as Error).message}`);
    } finally {
      setBatchActionBusy(false);
    }
  }

  async function loadSession(sessionId: string) {
    setBusy(true);
    try {
      const result = (await request("sessions.load", { sessionId })) as { session: SessionSnapshot; context: TutorContext };
      await refreshMaterialArtifacts(result.session.materialId);
      setActiveMaterial((current) => current?.id === result.session.materialId ? current : state.materials.find((material) => material.id === result.session.materialId) || current);
      setSession(result.session);
      setContext(result.context);
      setResumeScrollAnchorId(result.session.lastRevealedMessageId);
      setSelectedModuleId(result.session.currentModuleId);
      setInspectorTab("modules");
      setExpandedSourceMessages(new Set());
      void refreshPrefetchStatus(result.session.id);
      void refreshMessageSets(result.session.materialId);
      setStatus(READY_STATUS);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function deleteSession(item: SessionSummary) {
    confirmDestructive({
      title: `"${item.title}" session을 삭제할까요?`,
      body: "이 session의 대화 기록과 진행 상태가 삭제됩니다.",
      detail: "Source와 material은 유지됩니다.",
      confirmLabel: "세션 삭제",
      onConfirm: () => deleteSessionConfirmed(item),
    });
  }

  async function deleteSessionConfirmed(item: SessionSummary) {
    setBusy(true);
    setStatus("세션 삭제 중");
    try {
      const deleted = (await request("sessions.delete", { sessionId: item.id })) as boolean;
      if (!deleted) throw new Error("Session not found");
      await Promise.all([refreshSessions(item.materialId), refreshSources(item.projectId)]);
      if (session?.id === item.id) {
        setSession(null);
        setContext(null);
        setSelectedModuleId(null);
        setExpandedSourceMessages(new Set());
        setPrefetchStatus(null);
      }
      setStatus(READY_STATUS);
    } catch (error) {
      await refreshSessions(item.materialId).catch(() => undefined);
      await refreshSources(item.projectId).catch(() => undefined);
      setStatus(`세션 삭제 실패: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function exportSession(item: SessionSummary) {
    if (sessionExportBusyId) return;
    setSessionExportBusyId(item.id);
    try {
      const result = (await request("sessions.exportReadable", { sessionId: item.id })) as SessionReadableExport;
      setStatus(`${item.title}: ${result.fileName} 내보내기 완료`);
    } catch (error) {
      setStatus(`세션 내보내기 실패: ${(error as Error).message}`);
    } finally {
      setSessionExportBusyId(null);
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
      setResumeScrollAnchorId(null);
      setSelectedModuleId(result.session.currentModuleId);
      await Promise.all([refreshSessions(result.session.materialId), refreshSources(result.session.projectId), refreshMessageSets(result.session.materialId)]);
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
      const result = (await (mode === "paragraph"
        ? request("sessions.continue", { sessionId: session.id })
        : request("sessions.advance", { sessionId: session.id, mode }))) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      setResumeScrollAnchorId(null);
      setSelectedModuleId(result.session.currentModuleId);
      await Promise.all([refreshSessions(result.session.materialId), refreshSources(result.session.projectId), refreshMessageSets(result.session.materialId)]);
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
      setResumeScrollAnchorId(null);
      setSelectedModuleId(result.session.currentModuleId);
      await Promise.all([refreshSessions(result.session.materialId), refreshSources(result.session.projectId), refreshMessageSets(result.session.materialId)]);
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
      const result = (await request("sessions.resumeModule", { sessionId: session.id, moduleId })) as { session: SessionSnapshot; context: TutorContext };
      setSession(result.session);
      setContext(result.context);
      setResumeScrollAnchorId(null);
      setSelectedModuleId(result.session.currentModuleId || moduleId);
      await Promise.all([refreshSessions(result.session.materialId), refreshSources(result.session.projectId)]);
      void refreshPrefetchStatus(result.session.id);
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
      await Promise.all([refreshSessions(result.session.materialId), refreshSources(result.session.projectId)]);
      void refreshPrefetchStatus(result.session.id);
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

  const allSessionMessages = session?.messages || EMPTY_MESSAGES;
  const currentMessages = useMemo(
    () => (selectedModuleId ? allSessionMessages.filter((message) => message.moduleId === selectedModuleId) : allSessionMessages),
    [allSessionMessages, selectedModuleId]
  );
  const latestAssistantForScrollId = useMemo(() => {
    if (resumeScrollAnchorId && currentMessages.some((message) => message.id === resumeScrollAnchorId)) return resumeScrollAnchorId;
    return [...currentMessages].reverse().find((message) => message.role === "assistant")?.id || null;
  }, [currentMessages, resumeScrollAnchorId]);
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
  const sourceTitleById = useMemo(() => new Map(state.sources.map((source) => [source.id, displayableSourceName(source)])), [state.sources]);
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
    return displayableModuleTitle(module.title, sourceTitlesForModule(module.id)) || module.title;
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
  const learningProgressValue = totalChunks ? Math.min(reachedChunks, totalChunks) : 0;
  const progressText = artifacts ? `${learningProgressValue}/${totalChunks}` : "0/0";
  const progressPercent = totalChunks ? Math.round((learningProgressValue / totalChunks) * 100) : 0;
  const materialMessageSets = activeMaterial ? messageSetsByMaterial[activeMaterial.id] || [] : [];
  const resumableSession = state.sessions.find((item) => item.status === "active") || null;
  const activeMessageSet = (session?.messageSetId ? materialMessageSets.find((item) => item.id === session.messageSetId) : null)
    || materialMessageSets.find((item) => item.status !== "cancelled" && item.status !== "superseded")
    || null;
  const consumedPreparedMessages = session?.messages.filter((message) => Boolean(message.originPreparedMessageId)).length || 0;
  const unreadPreparedMessages = Math.max(0, (activeMessageSet?.completedMessages || 0) - consumedPreparedMessages);
  const preparedMessages = activeMessageSet?.completedMessages || 0;
  const totalPreparedMessages = activeMessageSet?.totalMessages || 0;
  const preparedProgressValue = totalPreparedMessages ? Math.min(preparedMessages, totalPreparedMessages) : 0;
  const preparationPercent = totalPreparedMessages
    ? Math.round((preparedProgressValue / totalPreparedMessages) * 100)
    : 0;
  const preparationText = activeMessageSet
    ? totalPreparedMessages
      ? `${preparedMessages}/${totalPreparedMessages} 메시지 (${preparationPercent}%)`
      : `${preparedMessages}개 메시지`
    : "준비 전";
  const activeModule = context?.moduleOutline.find((item) => item.status === "in_progress");
  const activeModuleTitle = activeModule ? displayModuleTitle(activeModule) : "";
  const buddyModuleTitle = activeModuleTitle || selectedModuleTitle;
  const latestAssistant = [...currentMessages].reverse().find((message) => message.role === "assistant");
  const latestAssistantId = latestAssistant?.id || null;
  const canReturnToProgress = !selectedModuleWaiting && (latestAssistant?.stateUpdate?.conversationMode === "detour" || latestAssistant?.stateUpdate?.turnMode === "digress");
  const batchPreparedReady = unreadPreparedMessages > 0;
  const continuePrefetchState = continuePrefetchStateForPreparedRoute(prefetchStatus, activeMessageSet, unreadPreparedMessages, session?.id);
  const continueButtonClass = `continue-button prefetch-${continuePrefetchState}`;
  const useReadyReturnButton = canReturnToProgress && continuePrefetchState === "ready";
  const readyContinueFocusKey = continueReadyFocusKeyForPreparedRoute({
    prefetchStatus,
    messageSet: activeMessageSet,
    activeSessionId: session?.id,
    lastRevealedRouteIndex: session?.lastRevealedRouteIndex ?? -1,
    unreadPreparedMessages,
    latestAssistantId,
    action: useReadyReturnButton ? "return" : "continue",
  });
  const continueButtonAria = continuePrefetchState === "generating"
    ? "계속해줘, 이어질 설명 준비 중"
    : useReadyReturnButton
      ? "진도로 돌아가기, 이어질 설명 준비됨"
      : continuePrefetchState === "ready"
      ? batchPreparedReady && prefetchStatus?.status !== "ready" ? "계속해줘, 미리 만든 메시지 준비됨" : "계속해줘, 이어질 설명 준비됨"
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
    if (
      viewMode !== "chat"
      || !showProgressActions
      || selectedModuleWaiting
      || continuePrefetchState !== "ready"
      || !readyContinueFocusKey
    ) {
      lastFocusedReadyActionKeyRef.current = null;
      return;
    }
    // Wait through the tutor's foreground turn without forgetting an already handled ready key.
    // This preserves normal post-answer autofocus while preventing a later busy toggle from
    // retrying a key that was deliberately suppressed during user input or text selection.
    if (busy) return;
    if (lastFocusedReadyActionKeyRef.current === readyContinueFocusKey) return;
    // Consume this ready key even when focus is suppressed. A later unrelated render must not
    // steal focus after the learner finishes typing or releases an existing selection.
    lastFocusedReadyActionKeyRef.current = readyContinueFocusKey;
    const target = continueButtonRef.current;
    const activeElement = document.activeElement;
    const activeElementIsIdle = !activeElement
      || activeElement === document.body
      || activeElement === document.documentElement
      || activeElement === target;
    const protectedSurfaceOpen = Boolean(document.querySelector(
      '[role="dialog"], .selection-toolbar, .lookup-popover, .selection-side-chat'
    ));
    if (!shouldAutoFocusReadyAction({
      pointerDown: userPointerDownRef.current,
      hasTextSelection: hasExpandedTextSelection(window.getSelection()),
      activeElementIsIdle,
      protectedSurfaceOpen,
    })) return;
    target?.focus({ preventScroll: true });
  }, [busy, continuePrefetchState, readyContinueFocusKey, selectedModuleWaiting, showProgressActions, viewMode]);
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
    if (annotation.syncWarning) setStatus(annotation.syncWarning);
  }, []);
  const handleAnnotationDeleted = useCallback((annotationId: string) => {
    setArtifacts((current) => current ? {
      ...current,
      annotations: (current.annotations || []).filter((annotation) => annotation.id !== annotationId),
    } : current);
  }, []);
  const continueQuestionThread = useCallback((annotation: MaterialAnnotation) => {
    setSideChatResumeRequest({ annotation, token: Date.now() });
  }, []);
  const handleSideChatResumeHandled = useCallback(() => setSideChatResumeRequest(null), []);
  const finalizeAnnotationDeletion = useCallback(async (annotation: MaterialAnnotation) => {
    try {
      const result = (await request("annotations.delete", { annotationId: annotation.id })) as { deleted: boolean; syncWarning?: string };
      if (result.syncWarning) setStatus(result.syncWarning);
    } catch (error) {
      handleAnnotationSaved(annotation);
      setStatus(`Annotation 삭제 실패: ${(error as Error).message}`);
    }
  }, [handleAnnotationSaved, request]);
  const deleteSavedAnnotation = useCallback((annotationId: string) => {
    const annotation = artifacts?.annotations.find((item) => item.id === annotationId);
    if (!annotation) return;
    const previousPending = pendingAnnotationDeletionRef.current;
    if (previousPending) {
      if (pendingAnnotationDeletionTimerRef.current != null) window.clearTimeout(pendingAnnotationDeletionTimerRef.current);
      void finalizeAnnotationDeletion(previousPending);
    }
    handleAnnotationDeleted(annotationId);
    pendingAnnotationDeletionRef.current = annotation;
    setPendingAnnotationDeletion(annotation);
    pendingAnnotationDeletionTimerRef.current = window.setTimeout(() => {
      pendingAnnotationDeletionRef.current = null;
      pendingAnnotationDeletionTimerRef.current = null;
      setPendingAnnotationDeletion(null);
      void finalizeAnnotationDeletion(annotation);
    }, 6000);
  }, [artifacts?.annotations, finalizeAnnotationDeletion, handleAnnotationDeleted]);
  const undoAnnotationDeletion = useCallback(() => {
    const annotation = pendingAnnotationDeletionRef.current;
    if (!annotation) return;
    if (pendingAnnotationDeletionTimerRef.current != null) window.clearTimeout(pendingAnnotationDeletionTimerRef.current);
    pendingAnnotationDeletionRef.current = null;
    pendingAnnotationDeletionTimerRef.current = null;
    setPendingAnnotationDeletion(null);
    handleAnnotationSaved(annotation);
  }, [handleAnnotationSaved]);

  useEffect(() => () => {
    if (pendingAnnotationDeletionTimerRef.current != null) window.clearTimeout(pendingAnnotationDeletionTimerRef.current);
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
  const defaultLookupChunkId = latestAssistant?.sourceRefs[0] || currentChunkId || artifacts?.sourceChunks[0]?.id || null;
  const batchGenerating = activeMessageSet?.status === "generating" || activeMessageSet?.status === "queued" || activeMessageSet?.status === "interrupted";
  const learningModelReady = Boolean(providerStatus?.hasApiKey && providerStatus.selectedModel);
  const batchButtonLabel = batchGenerating
    ? `준비 중 ${activeMessageSet?.completedMessages || 0}/${activeMessageSet?.totalMessages || "?"}`
    : activeMessageSet?.status === "ready"
      ? `${activeMessageSet.completedMessages}개 준비됨`
      : activeMessageSet?.status === "paused" || activeMessageSet?.status === "partial"
        ? "이어서 만들기"
        : "전체 메시지 일괄 제작";
  const batchButtonDisabled = Boolean(
    !activeMaterial ||
      activeMaterial.status !== "ready" ||
      batchActionBusy ||
      (!batchGenerating && !learningModelReady) ||
      activeMessageSet?.status === "ready"
  );
  const batchButtonTitle = batchGenerating
    ? "현재 준비 작업을 일시 중지합니다. 다음 실행에서도 자동 재개하지 않습니다."
    : !learningModelReady
    ? "Settings에서 learning model과 API key를 먼저 설정하세요."
    : "학습 session을 만들거나 workspace를 전환하지 않고 이 material의 메시지를 준비합니다.";

  const importedSourceLabel = `${state.sources.length} source${state.sources.length === 1 ? "" : "s"} imported`;
  const shellClassName = [
    "app-shell",
    leftPaneOpen ? "" : "left-pane-collapsed",
    leftPaneResizing ? "left-pane-resizing" : "",
    rightPaneOpen ? "" : "right-pane-collapsed",
  ].filter(Boolean).join(" ");
  const shellStyle = { "--left-pane-width": `${leftPaneWidth}px` } as CSSProperties;
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
    <div className={shellClassName} style={shellStyle}>
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
              onImport={() => void chooseProjectTransfer()}
              onExport={(project) => void exportProjectTransfer(project)}
              onDelete={(project) => void deleteProject(project)}
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
                const learningStatusLabel = sourceLearningStatusLabel(source.learningStatus);
                const sourceTitle = `${sourceName} - ${learningStatusLabel}`;
                const sourceMaterial = state.materials.find((item) => item.sourceIds.length === 1 && item.sourceIds[0] === source.id) || null;
                const sourceMessageSet = sourceMaterial
                  ? (messageSetsByMaterial[sourceMaterial.id] || []).find((item) => item.status !== "cancelled" && item.status !== "superseded") || null
                  : null;
                const sourcePreparing = sourceMessageSet?.status === "generating" || sourceMessageSet?.status === "queued" || sourceMessageSet?.status === "interrupted";
                const sourcePreparationTitle = sourceMessageSet?.status === "ready"
                  ? `${sourceName}: ${sourceMessageSet.completedMessages}개 메시지 준비됨`
                  : sourcePreparing
                    ? `${sourceName}: 준비 중 ${sourceMessageSet?.completedMessages || 0}/${sourceMessageSet?.totalMessages || "?"}`
                    : `${sourceName} 학습 메시지를 background에서 준비`;
                return (
                  <div
                    key={source.id}
                    className={`list-item source-learn-row ${isActive ? "active" : ""} ${editingSourceId === source.id ? "editing" : ""}`}
                    title={editingSourceId === source.id ? undefined : sourceTitle}
                  >
                    {editingSourceId === source.id ? (
                      <form className="source-title-edit" onSubmit={(event) => { event.preventDefault(); void saveSourceTitle(source); }}>
                        <input
                          autoFocus
                          value={sourceTitleDraft}
                          onChange={(event) => setSourceTitleDraft(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              cancelSourceRename();
                            }
                          }}
                          maxLength={240}
                          aria-label={`${sourceName} 새 제목`}
                          disabled={sourceRenameBusy}
                        />
                        <button type="submit" className="source-title-save" disabled={sourceRenameBusy || !sourceTitleDraft.trim()} title="제목 저장" aria-label="제목 저장">
                          {sourceRenameBusy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
                        </button>
                        <button type="button" className="source-title-cancel" onClick={cancelSourceRename} disabled={sourceRenameBusy} title="편집 취소" aria-label="편집 취소">
                          <X size={13} />
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="source-learn-main"
                          onClick={() => learnFromSource(source.id)}
                          disabled={!activeProject || busy}
                          title={sourceTitle}
                          aria-label={sourceTitle}
                        >
                          <span className="source-row-index">{sourceIndex + 1}</span>
                          <span className={`source-status-dot ${source.learningStatus}`} aria-hidden="true" />
                          <span className="source-row-title">{sourceName}</span>
                        </button>
                        <button
                          type="button"
                          className={`source-prepare-button ${sourceMessageSet?.status || "idle"}`}
                          onClick={() => void prepareSourceInBackground(source)}
                          disabled={!activeProject || batchActionBusy || !learningModelReady}
                          title={sourcePreparationTitle}
                          aria-label={sourcePreparationTitle}
                        >
                          {sourcePreparing ? <Loader2 size={13} className="spin" /> : sourceMessageSet?.status === "ready" ? <Check size={13} /> : <Sparkles size={13} />}
                        </button>
                        <button
                          type="button"
                          className="source-edit-button"
                          onClick={() => beginSourceRename(source)}
                          disabled={!activeProject || busy || sourceRenameBusy}
                          title={`${sourceName} 제목 변경`}
                          aria-label={`${sourceName} 제목 변경`}
                        >
                          <Pencil size={13} />
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
                      </>
                    )}
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

      <div
        className="left-pane-splitter"
        role="separator"
        aria-label="Left pane width"
        aria-orientation="vertical"
        aria-valuemin={LEFT_PANE_MIN_WIDTH}
        aria-valuemax={LEFT_PANE_MAX_WIDTH}
        aria-valuenow={leftPaneWidth}
        tabIndex={leftPaneOpen ? 0 : -1}
        title="드래그해서 left pane 폭 조절"
        onPointerDown={startLeftPaneResize}
        onDoubleClick={() => setLeftPaneWidth(LEFT_PANE_DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          let nextWidth: number | null = null;
          if (event.key === "ArrowLeft") nextWidth = leftPaneWidth - 16;
          if (event.key === "ArrowRight") nextWidth = leftPaneWidth + 16;
          if (event.key === "Home") nextWidth = LEFT_PANE_MIN_WIDTH;
          if (event.key === "End") nextWidth = LEFT_PANE_MAX_WIDTH;
          if (nextWidth === null) return;
          event.preventDefault();
          setLeftPaneWidth(clampLeftPaneWidth(nextWidth));
        }}
      />

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
            <div className="status-pill" title={status} aria-live="polite">
              {busy || tutorThinking || sessionStartBusy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
              <span className="status-text">{status}</span>
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
                <div className="course-progress-row preparation-progress">
                  <span>준비 진도 · {preparationText}</span>
                  <div
                    className="course-progress-bar"
                    role="progressbar"
                    aria-label="학습 메시지 준비 진도"
                    aria-valuemin={0}
                    aria-valuemax={totalPreparedMessages || 100}
                    aria-valuenow={preparedProgressValue}
                    aria-valuetext={preparationText}
                  >
                    <i style={{ transform: `scaleX(${preparationPercent / 100})` }} />
                  </div>
                </div>
                <div className="course-progress-row learning-progress">
                  <span>학습 진도 · {progressText} 대목 ({progressPercent}%)</span>
                  <div
                    className="course-progress-bar"
                    role="progressbar"
                    aria-label="학습 진도"
                    aria-valuemin={0}
                    aria-valuemax={totalChunks || 100}
                    aria-valuenow={learningProgressValue}
                    aria-valuetext={`${progressText} 대목, ${progressPercent}%`}
                  >
                    <i style={{ transform: `scaleX(${progressPercent / 100})` }} />
                  </div>
                </div>
              </div>
            </div>
            <div className="course-strip-actions">
              <div className="segmented-control" aria-label="View mode">
                <button type="button" className={viewMode === "source" ? "active" : ""} onClick={() => setViewMode("source")}>
                  원문보기
                </button>
                <button type="button" className={viewMode === "chat" ? "active" : ""} onClick={() => setViewMode("chat")}>
                  학습공간
                </button>
              </div>
              <button
                className={`wide-button topbar-button batch-button ${batchGenerating ? "generating" : activeMessageSet?.status || "idle"}`}
                onClick={() => void (batchGenerating ? cancelBatchMessages() : startBatchMessages())}
                disabled={batchButtonDisabled}
                title={batchButtonTitle}
              >
                {batchActionBusy || batchGenerating ? <Loader2 size={16} className="spin" /> : <MessageSquare size={16} />}
                {batchButtonLabel}
              </button>
              {!session ? (
                <button className="wide-button topbar-button primary" onClick={() => void startOrContinueSession()} disabled={busy || sessionStartBusy}>
                  <MessageSquare size={16} /> {resumableSession ? "학습 이어가기" : "학습시작"}
                </button>
              ) : null}
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
                  <h3>{selectedModuleTitle || activeModuleTitle || (activeSource ? displayableSourceName(activeSource) : activeMaterial?.title) || session.title}</h3>
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
                onAnnotationSaved={handleAnnotationSaved}
                onDeleteAnnotation={(annotationId) => void deleteSavedAnnotation(annotationId)}
                onContinueQuestionThread={continueQuestionThread}
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
                        title={
                          useReadyReturnButton
                            ? "원래 진도로 돌아갈 설명이 준비되었습니다."
                            : batchPreparedReady && prefetchStatus?.status !== "ready"
                            ? "미리 만들어 둔 다음 메시지를 바로 보여줍니다."
                            : continueButtonTitle(prefetchStatus)
                        }
                        aria-label={continueButtonAria}
                      >
                        {continuePrefetchState === "generating" ? <Loader2 size={14} className="spin" aria-hidden="true" /> : null}
                        {continuePrefetchState === "ready" ? <Check size={14} aria-hidden="true" /> : null}
                        {useReadyReturnButton ? "진도로 돌아가기" : "계속해줘"}
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
            <SourceLearningPreview artifacts={artifacts} title={activeSource ? displayableSourceName(activeSource) : undefined} />
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
              onDeleteAnnotation={(annotationId) => void deleteSavedAnnotation(annotationId)}
              resumeRequest={sideChatResumeRequest}
              onResumeHandled={handleSideChatResumeHandled}
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
          leftPaneOpen={leftPaneOpen}
          rightPaneOpen={rightPaneOpen}
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
                              <small>{item.model || "Model unavailable"} · {item.consumedCount}/{item.preparedCount || "?"} prepared read</small>
                            </span>
                          </button>
                          <button
                            type="button"
                            className="session-export-button"
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              void exportSession(item);
                            }}
                            disabled={sessionExportBusyId === item.id}
                            title="세션 내보내기"
                            aria-label={`${item.title} 세션 내보내기`}
                          >
                            {sessionExportBusyId === item.id ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                          </button>
                          <button
                            type="button"
                            className="session-delete-button"
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              void deleteSession(item);
                            }}
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
      {destructiveConfirmation ? (
        <DestructiveConfirmationModal
          confirmation={destructiveConfirmation}
          busy={confirmationBusy}
          onCancel={() => setDestructiveConfirmation(null)}
          onConfirm={() => void runDestructiveConfirmation()}
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

      {projectTransferPreview ? (
        <ProjectTransferImportModal
          preview={projectTransferPreview}
          busy={busy}
          onCancel={() => void cancelProjectTransfer()}
          onConfirm={() => void commitProjectTransfer()}
        />
      ) : null}
      {preparedImport ? (
        <SourceImportModal request={request} prepared={preparedImport} onCancel={cancelPreparedImport} onImported={finishPreparedImport} />
      ) : null}
      {pendingAnnotationDeletion ? (
        <div className="annotation-delete-undo-toast" role="status">
          <span>저장된 주석을 삭제했습니다.</span>
          <button type="button" onClick={undoAnnotationDeletion}>실행 취소</button>
        </div>
      ) : null}
    </div>
  );
}
