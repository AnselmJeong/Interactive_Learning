import { ChevronDown, LocateFixed, MessageSquare, Trash2 } from "lucide-react";
import { useState } from "react";
import type { MaterialAnnotation } from "../../../shared/artifact-types";
import { firstQuestion, questionCount, questionMessages } from "../../../shared/question-thread";
import { MarkdownContent } from "./MarkdownContent";

type QuestionThreadAnnotationCardProps = {
  annotation: MaterialAnnotation;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  onContinue: (annotation: MaterialAnnotation) => void;
  onLocate: (annotation: MaterialAnnotation) => boolean;
  onDelete: (annotationId: string) => void;
};

function updatedLabel(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return new Date(timestamp).toLocaleDateString();
}

export function QuestionThreadAnnotationCard({
  annotation,
  active,
  expanded,
  onToggle,
  onContinue,
  onLocate,
  onDelete,
}: QuestionThreadAnnotationCardProps) {
  if (annotation.result.kind !== "question" && annotation.result.kind !== "question_thread") return null;
  const result = annotation.result;
  const messages = questionMessages(result, annotation.createdAt);
  const contentId = `question-thread-content-${annotation.id}`;
  const sources = result.sourceMeta.length ? result.sourceMeta : annotation.sourceMeta;
  const [locateFailed, setLocateFailed] = useState(false);

  return (
    <article
      id={`annotation-card-${annotation.id}`}
      className={`chat-annotation-card question-thread ${active ? "annotation-card-active" : ""} ${expanded ? "expanded" : "collapsed"}`}
    >
      <header>
        <button
          type="button"
          className="question-thread-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={contentId}
        >
          <span className="question-thread-label">사이드 대화</span>
          <strong>{annotation.selectedText}</strong>
          <em>{firstQuestion(result)}</em>
          <small>{questionCount(result)}개 질문 · {updatedLabel(annotation.updatedAt)}</small>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </header>

      <div id={contentId} className="question-thread-collapse" aria-hidden={!expanded}>
        <div className="question-thread-collapse-inner">
          <div className="question-thread-transcript">
            {messages.map((message) => (
              <article key={message.id} className={`question-thread-message ${message.role}`}>
                <span>{message.role === "user" ? "나" : "Learnie"}</span>
                {message.role === "assistant" ? <MarkdownContent content={message.content} compact /> : <p>{message.content}</p>}
              </article>
            ))}
          </div>

          {sources.length ? (
            <div className="question-thread-meta">
              {sources.map((source, index) => source.url ? (
                <a key={`${source.title}-${index}`} href={source.url} target="_blank" rel="noreferrer">
                  {source.provider || "Source"}: {source.title}
                </a>
              ) : (
                <span key={`${source.title}-${index}`}>{source.provider || "Source"}: {source.title}</span>
              ))}
            </div>
          ) : null}

          {locateFailed ? <p className="question-thread-locate-error">원문 위치를 찾을 수 없음</p> : null}
          <footer>
            <button type="button" className="primary" onClick={() => onContinue(annotation)}>
              <MessageSquare size={14} /> 대화 계속
            </button>
            <button
              type="button"
              onClick={() => {
                const located = onLocate(annotation);
                setLocateFailed(!located);
              }}
            >
              <LocateFixed size={14} /> 원문 위치
            </button>
            <button type="button" className="danger" onClick={() => onDelete(annotation.id)}>
              <Trash2 size={14} /> 삭제
            </button>
          </footer>
        </div>
      </div>
    </article>
  );
}
