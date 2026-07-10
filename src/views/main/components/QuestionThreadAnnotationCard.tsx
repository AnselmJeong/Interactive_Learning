import { ChevronDown, LocateFixed, MessageSquare, Trash2 } from "lucide-react";
import { useState } from "react";
import type { MaterialAnnotation } from "../../../shared/artifact-types";
import { questionMessages } from "../../../shared/question-thread";
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
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        <div className="question-thread-header-actions">
          <button
            type="button"
            className="annotation-card-icon-button"
            onClick={() => {
              const located = onLocate(annotation);
              setLocateFailed(!located);
            }}
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
        </div>
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
          </footer>
        </div>
      </div>
    </article>
  );
}
