# Add Context Menu Lookup to Learnie

## Goal

Learner가 학습/대화 화면에서 어려운 개념, 인명, 지명, 작품명, 전문 용어를 선택한 뒤 학습 surface 우측 edge에 붙는 selection toolbar를 통해 짧은 보조 설명을 볼 수 있게 한다. 원문 보기 화면에서도 동작할 수 있지만, 1차 대상은 learner가 실제로 읽고 상호작용하는 학습 화면이다.

Important product adjustment: do not replace the macOS/WebView default right-click menu. The system menu already has generic `Lookup` and `Define`, and users expect it to stay available. Learnie's custom value is not duplicating that menu; it is source-grounded lookup plus `Save` into the learning material.

초기 명령은 세 가지로 둔다.

- `Define`: 선택어의 간단한 정의. 문맥을 우선 사용하고, 모르면 일반 정의라고 표시한다.
- `Lookup`: Wikipedia 스타일의 짧은 설명. 가능하면 외부 출처와 링크를 함께 보여준다.
- `Find image`: 선택어와 관련된 이미지를 찾고, 썸네일/출처/열기 링크를 보여준다.

결과는 일시적인 floating popover에 표시한다. 사용자가 의미 있다고 판단하면 `Save`로 저장하고, 이후 같은 learning material을 열 때 원문 근처에 다시 보이게 한다.

## Feasibility

기술적으로 가능하다. 현재 앱 구조는 이 기능을 추가하기에 꽤 좋은 상태다.

이미 있는 기반:

- `ImmersiveSourceView`가 `window.getSelection()`으로 원문 선택을 캡처한다.
- 선택 범위를 같은 `.source-chunk` 안으로 제한하고 `chunkId`, 선택 텍스트, 좌표를 상태로 저장한다.
- 같은 컴포넌트에 `highlight` / `note` selection toolbar가 이미 있다.
- `AppRPC`에 typed request를 추가하는 패턴이 있고, Bun main process에서 AI provider와 네트워크 fetch를 처리할 수 있다.
- `CourseArtifactService.getArtifacts()`가 material 렌더링에 필요한 artifacts를 한 번에 조립한다.
- 현재 figure 작업이 `SourceFigureCard`, `figures.explain`, `MaterialArtifacts.figures` 방향으로 이미 진행 중이어서 `Find image`의 UI 패턴과 유사한 action panel을 재사용하기 쉽다.

리스크가 낮은 이유:

- OS native context menu를 건드릴 필요 없이 React DOM 안에서 custom context menu를 만들 수 있다.
- 선택/팝오버 상태는 renderer local state로 시작할 수 있어 세션 진행, tutor runtime, source ingestion을 깨뜨리지 않는다.
- 저장은 생성된 `source_chunks.json`를 직접 수정하지 않고 별도 annotation store로 두면 material 재생성 없이 안전하게 붙일 수 있다.

주의할 점:

- 현재 highlight/note는 `localStorage`에만 저장된다. `Save`된 lookup은 프로젝트의 장기 학습 자료로 남아야 하므로 DB 또는 material artifact sidecar에 저장해야 한다.
- `Find image`는 외부 검색 API, 출처 표시, 캐시 정책이 필요하다. 임의 scraping이나 출처 없는 이미지 저장은 피한다.
- saved lookup을 "원문 자체 수정"으로 구현하면 source hash, chunk mapping, session progress가 흔들릴 수 있다. 대신 saved annotation을 chunk 위에 overlay/injected card로 렌더링하는 것이 안전하다.

## Product Behavior

### Selection entry points

1. 텍스트 선택 직후 학습 surface 우측 edge에 Chrome PDF viewer 스타일의 세로 selection toolbar를 띄운다.
   - 표시
   - 노트
   - 원문 정의
   - 위키 요약
   - 이미지 후보

2. 우클릭은 기본 macOS/WebView context menu를 그대로 둔다.
   - 기본 `Lookup`/`Define`을 막지 않는다.
   - Learnie action은 선택 toolbar에서 제공한다.
   - 경쟁하는 메뉴를 두 개 띄우지 않는다.

3. selection capture는 특정 원문 view의 pointer event만 믿지 않고 `selectionchange`를 전역으로 감지한다.
   - 선택이 `.tutor-surface` 안에 있을 때 toolbar를 보여준다.
   - 선택 DOM에 `data-lookup-chunk-id`가 있으면 해당 source chunk를 사용하고, 없으면 현재 학습 중인 chunk를 fallback으로 사용한다.
   - selection overlay와 겹치지 않도록 toolbar는 선택어 위가 아니라 학습 surface 우측 edge에 고정한다.
   - lookup 결과 popover는 toolbar 왼쪽에 떠서 본문 선택 영역을 최대한 가리지 않는다.

### Floating result window

Popover는 우측 toolbar 왼쪽에 뜨고 다음 상태를 가진다.

- loading
- result
- empty/not found
- provider/config error
- network error

Popover는 긴 결과를 읽을 수 있도록 header drag로 위치를 옮길 수 있어야 한다. 초기 위치는 viewport 하단에 붙지 않도록 여백을 두고 clamp하며, 사용자가 header를 잡아 원하는 위치로 이동할 수 있게 한다.

공통 구성:

- 선택어
- action label
- 짧은 결과 본문
- 출처/모델/검색 provider 메타데이터
- `Save`
- `Close`

`Save` 후:

- popover는 `Saved` 상태를 짧게 보여준다.
- 해당 chunk 아래 또는 margin note 영역에 saved lookup card가 표시된다.
- 이후 material을 다시 열어도 유지된다.

### Result policy

`Define`:

- AI provider를 사용한다.
- 선택어와 현재 chunk 전후 문맥을 함께 전달한다.
- 1-3문장으로 제한한다.
- 원문 문맥에서의 의미와 일반 의미가 다르면 구분한다.

`Lookup`:

- 1차: English Wikipedia REST lookup으로 정확한 항목을 찾고, 해당 영어 항목 extract를 AI provider로 한국어 심화 요약한다.
- 2차: English Wikipedia 항목이 없거나 네트워크 실패 시에만 AI provider fallback을 사용한다.
- 외부 출처가 있으면 title, URL, retrievedAt을 저장한다.
- Wiki 요약에는 원문 context를 넣지 않는다. 원문 context는 `Define`과 Wikipedia 항목이 없을 때의 AI fallback에만 사용한다.
- AI fallback은 "AI-generated, source-context assisted"로 표시한다.

`Find image`:

- 1차 구현은 이미지 검색 provider 결과를 보여주되, 이미지를 앱 데이터에 영구 복사하지 않는다.
- 저장 시에는 thumbnail URL, page URL, source/provider, license/caption이 있을 때만 저장한다.
- provider가 없으면 검색 URL 열기 또는 "image search is not configured" 상태를 보여준다.
- 나중에 명시적 "cache image locally"를 추가할 수 있지만, 첫 버전에서는 링크/썸네일 저장이 안전하다.

## Data Model

`learning_materials` 자체나 `source_chunks.json`를 직접 수정하지 않는다. 새 table을 추가한다.

```sql
CREATE TABLE IF NOT EXISTS material_annotations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES learning_materials(id) ON DELETE CASCADE,
  source_id TEXT,
  chunk_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('define', 'lookup', 'image', 'note', 'highlight')),
  selected_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  result_json TEXT NOT NULL,
  source_meta_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_material_annotations_material_chunk
  ON material_annotations(material_id, chunk_id, created_at ASC);
```

Shared types:

```ts
export type MaterialAnnotationKind = "define" | "lookup" | "image" | "note" | "highlight";

export type MaterialAnnotation = {
  id: string;
  projectId: string;
  materialId: string;
  sourceId: string | null;
  chunkId: string;
  kind: MaterialAnnotationKind;
  selectedText: string;
  normalizedText: string;
  result: LookupResult | ImageLookupResult | NoteResult | HighlightResult;
  sourceMeta: Array<{ title: string; url?: string; provider?: string; retrievedAt?: string }>;
  createdAt: number;
  updatedAt: number;
};
```

Extend `MaterialArtifacts`:

```ts
annotations: MaterialAnnotation[];
```

This lets `ImmersiveSourceView` render saved annotations alongside chunks without mutating source text or regenerating the course.

Migration note: existing localStorage marks can remain for now. A later migration can import `learnie.source-marks.<materialId>` into `material_annotations`.

## RPC Plan

Add requests to `AppRPC`:

```ts
"annotations.define": {
  params: { materialId: string; chunkId: string; selectedText: string };
  response: LookupResult;
};
"annotations.lookup": {
  params: { materialId: string; chunkId: string; selectedText: string };
  response: LookupResult;
};
"annotations.findImages": {
  params: { materialId: string; chunkId: string; selectedText: string };
  response: ImageLookupResult;
};
"annotations.save": {
  params: {
    materialId: string;
    chunkId: string;
    kind: MaterialAnnotationKind;
    selectedText: string;
    result: LookupResult | ImageLookupResult;
    sourceMeta: MaterialAnnotation["sourceMeta"];
  };
  response: MaterialAnnotation;
};
"annotations.delete": {
  params: { annotationId: string };
  response: boolean;
};
```

Backend service:

- Add `AnnotationService` in `src/bun/annotation-service.ts`.
- It owns DB CRUD and lookup orchestration.
- It loads `MaterialArtifacts` only to validate `materialId` and pull chunk context.
- It reuses `providerClient()` for AI calls.
- It keeps external fetch timeouts short, around 8-12 seconds, so a lookup cannot freeze the app.

## Prompt Plan

`Define` system prompt:

```text
You are Learnie, a source-grounded tutor. Define the selected term for a learner.
Use the provided source context first. If the context is insufficient, say that the definition is general.
Keep the answer under 80 Korean words. Do not expose internal app terminology.
```

`Lookup` AI fallback prompt:

```text
Write a concise encyclopedia-style lookup for the selected term.
Prefer stable facts and explain why it matters in this source context.
If uncertain, say what is uncertain. Keep it under 140 Korean words.
```

Inputs:

- selected text
- current chunk text
- chunk heading/locator
- neighboring chunk snippets if available
- source title

Do not send whole material contents. The selected text plus bounded local context is enough and protects performance.

## UI Implementation Plan

### Component changes

Modify `ImmersiveSourceView`:

- Replace `selection` state with richer state:
  - `chunkId`
  - `text`
  - `x`
  - `y`
  - `rangeRect`
- Keep existing `onMouseUp` selection capture.
- Do not add `onContextMenu`; leave right-click to the system menu.

Add components:

- `LookupPopover`
- `SavedAnnotationCard`

Render saved annotations:

- Group `artifacts.annotations` by `chunkId`.
- Show cards after chunk text and before figures/marks.
- Keep cards compact. They should feel like margin notes, not chat bubbles.

### Styling

Use existing app tokens:

- `--panel`
- `--line`
- `--accent`
- `--teal`
- `--shadow`

Popover constraints:

- fixed positioning
- max-width around 360-420px
- max-height around 55vh with internal scroll
- clamp to viewport edges
- no layout shift in source text
- keyboard accessible close with Escape

### Accessibility

- Context menu uses `role="menu"`.
- Menu items use buttons with visible focus.
- Popover uses `role="dialog"` or `role="status"` depending on interaction.
- Escape closes menu/popover.
- Saving announces status through an aria-live region or visible status line.

## Security And Privacy

- Do not execute returned HTML. Render text/markdown through the existing safe `MarkdownContent` path.
- Bound selected text length, e.g. 160 chars for term lookup and 420 chars for selected phrase.
- Bound context length, e.g. current chunk 1800 chars plus neighboring snippets 600 chars each.
- External lookup URLs must be rendered as links, not loaded into a webview.
- Image result URLs should be displayed as remote image URLs only if they are HTTPS.
- Store provider metadata and retrievedAt for saved external content.
- Do not store API keys or request payloads in annotations.
- Do not send private source text to external Wikipedia/image APIs except the selected term. AI provider calls may receive bounded local context because that is already the app's configured tutor provider.

## Phased Implementation

### Phase 1: Low-risk local UX

- Extend existing selection toolbar with Define/Lookup/Image buttons.
- Do not add a custom right-click context menu. Keep the native menu intact.
- Add `LookupPopover` loading/result/error states.
- Implement Define using AI provider only.
- No persistence yet except transient popover state.

Validation:

- `bun run typecheck`
- Manual source-view selection and right-click smoke
- Verify chat typing and module navigation are unaffected

### Phase 2: Durable save

- Add `material_annotations` table and migration.
- Add shared annotation types.
- Add `AnnotationService`.
- Add `annotations.save`, `annotations.delete`, and `annotations.list` or include annotations in `materials.getArtifacts`.
- Render saved annotations under source chunks.
- Optionally migrate current localStorage note/highlight later; do not combine this with Phase 2 unless needed.

Validation:

- Save lookup, close material, reopen material, verify card persists.
- Delete saved lookup and verify DB/artifact reload.
- Verify project archive export includes annotations if archive is meant to preserve learning material state.

### Phase 3: External lookup

- Add Wikipedia/Wikidata lookup provider.
- Add source metadata and link rendering.
- Add timeout and fallback to AI provider.
- Save source metadata with annotations.

Validation:

- Known person, concept, and ambiguous term cases.
- Offline/network failure case.
- Korean and English selected terms.

### Phase 4: Image search

- Choose an explicit image search provider or configuration path.
- Implement backend-only search request.
- Show thumbnail, source page, provider, and license/caption when available.
- Save only metadata and HTTPS thumbnail URL in first version.

Validation:

- Provider missing state.
- No-results state.
- Broken thumbnail state.
- Saved image result reload.

## QA Checklist

- Selecting text in one chunk opens menu; selecting across chunks does not.
- Right-click on source text opens custom menu; right-click on buttons/inputs keeps expected behavior.
- Menu and popover positions are clamped on small windows.
- Escape closes menu/popover.
- Define works with configured provider and shows a useful error without provider config.
- Lookup does not block tutor turns or leave permanent spinner state.
- Save persists across material reload and app restart.
- Saved annotations do not alter `source_chunks.json`, course plan, session progress, or current module selection.
- Image result cards never hide source text or figures.
- `bun run typecheck` passes.
- If external lookup/image search is implemented, test offline behavior.

## Recommendation

Build this, but do it in phases. Phase 1 and Phase 2 are well within the current app architecture and should not destabilize the tutor engine if kept inside `ImmersiveSourceView`, typed RPC, and a new annotation service.

The main product decision is persistence semantics: saved lookup content should be treated as user-created material annotations, not as regenerated learning material. That gives the learner the feeling that the material has been enriched while preserving source integrity, chunk IDs, session progress, and future regeneration behavior.
