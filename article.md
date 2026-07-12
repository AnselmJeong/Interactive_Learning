# Article 지원 구현 계약

## 결정

Article의 PDF 분석, 단일 문서화, scholarly metadata 추출, References 제거는 독립 Preppy project가 소유한다. Learnie는 vendored Preppy 결과를 소비하고 Book/Article 선택 및 학습 UI만 분기한다.

- import 기본값은 항상 `Book`
- `Article`은 현재 PDF만 지원
- article PDF 하나는 source 하나
- 여러 article PDF를 한 번에 선택하면 파일 수만큼 source 생성
- article 내부 section은 chunk/module 생성에 계속 사용
- 단, 학습 session 시작 전 첫 화면에는 module 목록을 표시하지 않음
- 첫 화면은 기존 AI 요약을 사용하되 연구 주제, 문제의식, 배경, 접근만 설명
- 수치, 효과 크기, 통계값, 구체적인 결과와 결론의 강도는 첫 화면 요약에서 제외
- abstract 추출/표시 계획은 폐기

## Preppy contract

Learnie가 반영한 Preppy article mode:

```bash
python -m preppy.cli paper.pdf \
  -o output \
  --document-type article \
  --overwrite \
  --json
```

Article manifest의 핵심:

```json
{
  "schema_version": 2,
  "source": {
    "document_type": "article",
    "title": "Article title",
    "authors": [],
    "year": 2026,
    "journal": null,
    "doi": null
  },
  "chapters": [
    {
      "kind": "article",
      "path": "chapters/001-article-title.md"
    }
  ]
}
```

경로 호환성을 위해 `chapters/`와 `chapters[]` 이름은 유지되지만 article mode의 entry는 정확히 하나이며 `kind: article`이다.

Preppy가 책임지는 것:

- 전체 article을 단일 learning unit으로 렌더링
- 실제 heading으로 판정된 References 이후 제거
- figure/table/compound figure 처리
- title과 가능한 scholarly metadata 기록
- abstract는 structured metadata로 추출하지 않음

## Import UX

파일 dialog 뒤, Preppy 실행 전에 문서 종류 modal을 표시한다.

### Book

- 기본 선택
- 기존 chapter detection 및 chapter 선택 preview 유지
- PDF, EPUB, Markdown, TXT, folder 지원

### Article

- 명시적으로 선택
- PDF만 활성화
- 설명: `PDF 한 편을 source 하나로 가져오고 references를 제외합니다.`
- 여러 PDF를 고른 경우 동일한 article mode를 batch 전체에 적용

`sources.prepareImport`는 optional `documentType`을 받는다. 값이 없으면 backend도 `book`으로 fallback하므로 기존 caller가 깨지지 않는다.

## Persistence

파일 형식인 `source_type`과 문서 의미인 `document_type`을 분리한다.

```ts
type SourceType = "markdown" | "pdf" | "text";
type DocumentType = "book" | "article";
```

`project_sources.document_type`:

- `TEXT NOT NULL DEFAULT 'book'`
- allowed: `book`, `article`
- legacy DB migration은 모든 기존 source를 `book`으로 유지

Learnie의 `source_manifest.json`에도 `documentType`을 기록한다. Project bundle recovery와 project transfer 후에도 article 여부가 유지되어야 한다.

## Learning material

Article도 기존 material/session/tutor pipeline을 재사용한다.

- Preppy가 References를 제거한 Markdown으로 chunks 생성
- section heading으로 course modules 구성
- figures, annotations, source lookup, prepared messages, progress는 기존 구조 재사용
- 별도 article tutor subsystem은 만들지 않음

### Article overview prompt

Article summary는 `article-overview-v1-topic-only` version으로 저장한다.

포함:

- 연구 주제
- 문제의식
- 배경
- 연구가 취한 접근

제외:

- 표본 수
- 수치와 효과 크기
- 통계값
- 세부 결과
- 결과의 강도
- 구체적인 최종 결론
- 학습 안내, module, 목차 언급

Book overview의 기존 `material-overview-v2-llm-full-source` prompt와 결과는 변경하지 않는다.

## Learning workspace 첫 화면

### Book

기존 화면 유지:

- 제목
- 예상 학습 시간
- 대목/module 수
- `이 자료에서 배우는 것`
- 학습 흐름 module list

### Article

session 시작 전:

- 제목
- 예상 학습 시간
- Article label
- `이 논문이 다루는 것`
- 주제 중심 요약

표시하지 않음:

- module count
- 학습 흐름 module list
- Inspector의 Modules tab

session을 시작한 뒤에는 module/chunk progression이 필요하므로 기존 module UI를 다시 사용할 수 있다.

## 변경 지점

- `python/src/preppy/*`: upstream article/schema v2/table/compound-figure 변경 vendoring
- `src/shared/artifact-types.ts`: `DocumentType`
- `src/shared/rpc-types.ts`: source/prepared import/RPC document type
- `src/bun/preppy-service.ts`: `--document-type` 전달
- `src/bun/project-db.ts`: `project_sources.document_type` migration
- `src/bun/source-service.ts`: manifest type 판독 및 source persistence
- `src/bun/project-bundle-sync.ts`: restart/recovery persistence
- `src/bun/course-artifact-service.ts`: article topic-only overview prompt
- `src/views/main/components/SourceDocumentTypeModal.tsx`: Book/Article 선택
- `src/views/main/components/SourceImportModal.tsx`: article-aware import copy
- `src/views/main/components/SourceLearningPreview.tsx`: article summary-only preview
- `src/views/main/App.tsx`, `NewProjectModal.tsx`: 선택 flow와 preview state

## 수용 기준

1. 문서 종류를 선택하지 않으면 Book이다.
2. Article은 PDF에서만 선택 가능하다.
3. article PDF 한 개가 source 한 개가 된다.
4. 여러 article PDF가 각각 source 하나가 된다.
5. article source는 restart와 project transfer 후에도 article이다.
6. References는 article chunks와 downstream prompt에 들어가지 않는다.
7. article 첫 화면에 module count/list가 없다.
8. article 첫 화면에는 abstract가 아니라 topic-only AI summary가 표시된다.
9. summary는 구체적인 연구 결과와 통계값을 나열하지 않는다.
10. Book import와 Book preview는 기존과 동일하다.
