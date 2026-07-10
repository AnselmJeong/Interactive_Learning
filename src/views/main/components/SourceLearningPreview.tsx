import { BookOpen, Clock3 } from "lucide-react";
import type { MaterialArtifacts } from "../../../shared/artifact-types";
import { displayableCourseTitle, displayableModuleTitle } from "../../../shared/display-title";

export function SourceLearningPreview({
  artifacts,
  title: sourceTitle,
}: {
  artifacts: MaterialArtifacts;
  title?: string;
}) {
  const title = sourceTitle || displayableCourseTitle(artifacts.coursePlan.title) || artifacts.coursePlan.title;

  return (
    <article className="source-learning-preview" aria-labelledby="source-preview-title">
      <header className="source-preview-header">
        <p className="eyebrow">Source preview</p>
        <h2 id="source-preview-title">{title}</h2>
        <div className="source-preview-meta" aria-label="예상 학습 범위">
          <span><Clock3 size={15} aria-hidden="true" /> 약 {artifacts.coursePlan.estimatedTimeMinutes}분</span>
          <span><BookOpen size={15} aria-hidden="true" /> {artifacts.sourceChunks.length}개 대목 · {artifacts.coursePlan.modules.length}개 module</span>
        </div>
      </header>

      <section className="source-preview-overview" aria-labelledby="source-overview-title">
        <h3 id="source-overview-title">이 자료에서 배우는 것</h3>
        <p>{artifacts.overview.paragraph}</p>
      </section>

      <section className="source-preview-outline" aria-labelledby="source-outline-title">
        <div className="source-preview-section-heading">
          <h3 id="source-outline-title">학습 흐름</h3>
          <span>{artifacts.coursePlan.modules.length} modules</span>
        </div>
        <ol>
          {artifacts.coursePlan.modules.map((module, index) => (
            <li key={module.id}>
              <span className="source-preview-module-index">{String(index + 1).padStart(2, "0")}</span>
              <strong>{displayableModuleTitle(module.title) || module.title}</strong>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
