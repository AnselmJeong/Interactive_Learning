# Hyperlinked Annotations and Highlights Plan

## 1. 결론

기술적으로 가능하다. 현재 Learnie에는 이미 선택 텍스트를 기반으로 한 `추가 질문`, `위키 요약`, `이미지 후보`, `노트`, `표시` 저장 모델이 들어와 있다. 다만 지금은 저장된 결과가 "선택된 문장 옆에 설명 카드가 붙는 것"에 가깝고, 원문이나 답변 본문 안의 어떤 문장에 설명이 연결되었는지는 직접 보이지 않는다.

이번 변경의 핵심은 새 기능을 따로 만드는 것이 아니라, 기존 `material_annotations`를 "텍스트 앵커가 있는 annotation"으로 완성하는 것이다.

- 선택한 문장/단어를 저장하면 본문 안의 해당 텍스트가 inline link/mark로 표시된다.
- link를 누르면 저장된 설명 카드로 바로 스크롤한다.
- 설명 카드에서도 원문/답변 안의 marked text로 돌아갈 수 있다.
- highlight는 같은 앵커 시스템을 쓰되, 설명 카드 없이 inline mark 자체가 결과가 된다.
- 생성된 source artifact나 tutor message 원문은 수정하지 않는다. 렌더링 단계에서만 표시한다.

MD_Reader에서 가져올 것은 "선택 범위 감지, occurrence 계산, highlight style token, DOM range wrapping" 아이디어다. MD_Reader의 Markdown highlight처럼 문서 내용을 `==...==`로 직접 바꾸는 방식은 Learnie에는 맞지 않는다. Learnie에서는 source chunks, tutor messages, session progress가 artifact/session state에 묶여 있으므로 원문을 변형하지 않고 별도 annotation sidecar를 유지해야 한다.

## 2. 현재 상태

이미 있는 기반:

- `src/views/main/components/LearningSelectionLookup.tsx`
  - chat/tutor 화면의 선택 텍스트를 감지한다.
  - `question`, `lookup`, `image` action을 제공한다.
  - 저장 시 `annotations.save`를 호출하고 `surface: "chat"`, `anchorMessageId`, `anchorBlockId`를 보낸다.
- `src/views/main/components/ImmersiveSourceView.tsx`
  - source view에서 선택 텍스트 toolbar를 제공한다.
  - `highlight`, `note`, `question`, `lookup`, `image` action을 제공한다.
  - legacy `localStorage` source mark를 DB annotation으로 migration하는 코드가 이미 있다.
- `src/bun/annotation-store.ts`
  - `material_annotations` table에 저장한다.
  - `kind`는 `define | lookup | question | image | note | highlight`를 이미 지원한다.
- `src/bun/annotation-service.ts`
  - lookup/question/image 결과를 생성하고 저장한다.
  - 저장 후 `writeMaterialAnnotationsSnapshot()`으로 project bundle의 `annotations.json`을 갱신한다.
- `src/views/main/annotation-placement.ts`
  - chat annotation을 `anchorMessageId`/`anchorBlockId` 기준으로 정확한 message/block 아래에 배치한다.
- `src/views/main/App.tsx`
  - `handleAnnotationSaved`가 `artifacts.annotations`를 즉시 갱신한다.
  - 저장된 chat annotation card와 source annotation card를 렌더링한다.

현재 빠진 부분:

- 저장된 annotation이 본문 안의 선택 텍스트를 inline으로 표시하지 않는다.
- highlight도 실제 원문 텍스트에 칠해지는 것이 아니라 별도 `source-mark-list` 카드로만 보인다.
- 같은 문장이 chunk 안에 여러 번 나오면 어떤 occurrence였는지 복원할 정보가 부족하다.
- chat toolbar에는 highlight action이 없다.
- 저장된 설명 card에는 stable DOM id가 없고, text mark에서 card로 이동하는 동작도 없다.

## 3. Product Behavior

### 저장된 lookup/question/image

사용자가 선택 텍스트에 대해 `추가 질문`, `위키 요약`, `이미지 후보`를 실행하고 `Save`하면:

1. annotation은 기존처럼 저장된다.
2. 선택된 문장/단어가 본문 안에서 kind별 inline link로 표시된다.
3. 저장된 설명 card가 기존 위치에 나타난다.
   - chat surface: 해당 assistant message 또는 tutor block 아래
   - source surface: 해당 source chunk 아래
4. inline link를 누르면 해당 card로 스크롤하고 짧게 강조한다.
5. card header의 "원문 위치" 버튼을 누르면 inline link 위치로 돌아간다.

표시 스타일:

- `question`: 부드러운 teal/blue underline + 작은 question affordance
- `lookup`: amber 계열 highlight underline
- `image`: muted slate/teal underline + image affordance
- `note`: green/teal highlight
- `highlight`: yellow background highlight

텍스트를 링크처럼 보이게 하되, 일반 외부 link와 혼동되지 않도록 내부 annotation 전용 스타일을 둔다. 외부 link는 기존 `app.openExternal` 동작을 유지한다.

### Highlight

source view에는 highlight 버튼이 이미 있으나 inline 표시가 없다. chat view에도 highlight를 추가한다.

v1 동작:

- selection toolbar에 `Highlighter` button을 추가한다.
- 누르면 기본 yellow highlight로 즉시 저장한다.
- 저장 후 선택 텍스트에 inline highlight가 표시된다.
- highlight만 저장한 경우에는 별도 설명 card를 만들지 않는다.
- source view의 기존 `source-mark-list`에서 highlight-only 항목은 제거하거나 접어서 중복 표시를 피한다.
- note는 사용자가 내용을 편집해야 하므로 card/list UI를 유지한다.

MD_Reader의 색상 swatch는 바로 복사하지 않고 data model만 준비한다. 즉, `HighlightResult`에 `style?: "yellow" | "green" | "blue" | "pink" | "red-underline"`를 허용하되 v1 UI는 yellow 하나로 시작한다. 이후 필요하면 MD_Reader의 `TextSelectionMenu`처럼 작은 swatch popover를 붙일 수 있다.

### Surface별 규칙

chat surface:

- 저장된 annotation은 선택 당시의 message/block에만 붙는다.
- 같은 source chunk를 공유하는 나중 message로 annotation을 이동시키지 않는다.
- block anchor가 있으면 block 내부에 inline mark를 적용한다.
- block anchor가 없으면 message bubble의 markdown content scope에 inline mark를 적용한다.

source surface:

- 저장된 annotation은 `sourceChunk.id`를 기준으로 해당 chunk body에 inline mark를 적용한다.
- figure card, saved annotation card, selection toolbar, lookup popover 안의 텍스트는 mark 대상에서 제외한다.
- source chunk 텍스트가 재생성되어 anchor를 찾지 못하면 card는 유지하되 "본문 위치를 찾을 수 없음" 상태로 둔다.

## 4. Data Model

현재 `chunk_id`, `selected_text`, `anchor_message_id`, `anchor_block_id`만으로는 "몇 번째 occurrence인지"를 안정적으로 알기 어렵다. `material_annotations`에 optional `anchor_json`을 추가한다.

```sql
ALTER TABLE material_annotations ADD COLUMN anchor_json TEXT;
```

Shared type:

```ts
export type TextSelectionAnchor = {
  version: 1;
  surface: "chat" | "source";
  scope: "source-chunk" | "chat-message" | "tutor-block";
  chunkId: string;
  messageId?: string | null;
  blockId?: string | null;
  selectedText: string;
  normalizedText: string;
  occurrence: number;
  startOffset: number;
  endOffset: number;
  prefix: string;
  suffix: string;
  scopeTextLength: number;
};
```

`MaterialAnnotation`에 추가:

```ts
textAnchor?: TextSelectionAnchor | null;
```

`SaveMaterialAnnotationInput` / RPC `annotations.save` params에도 `textAnchor?: TextSelectionAnchor | null`를 추가한다.

`HighlightResult` 확장:

```ts
export type HighlightResult = {
  kind: "highlight";
  style?: "yellow" | "green" | "blue" | "pink" | "red-underline";
};
```

Backward compatibility:

- 기존 annotation은 `anchor_json`이 없다.
- 기존 annotation은 `selectedText + chunkId + anchorMessageId/anchorBlockId`로 best-effort first match를 시도한다.
- 복원 실패 시 card만 보여주고 inline mark는 생략한다.
- `annotations.json` import/export는 `textAnchor`가 있으면 보존하고, 없으면 기존처럼 읽는다.

## 5. Anchor Capture

새 helper를 둔다.

- `src/views/main/selection-anchor.ts`
- 테스트: `src/views/main/selection-anchor.test.ts`

주요 함수:

```ts
export function buildTextSelectionAnchor(input: {
  range: Range;
  root: HTMLElement;
  surface: "chat" | "source";
  chunkId: string;
  messageId?: string | null;
  blockId?: string | null;
}): TextSelectionAnchor | null;

export function resolveTextSelectionAnchor(input: {
  root: HTMLElement;
  annotation: MaterialAnnotation;
}): ResolvedTextAnchor | null;
```

capture 방식:

1. selection start/end가 같은 annotation scope 안에 있는지 확인한다.
2. scope root의 plain text를 TreeWalker로 만든다.
3. scope 시작부터 selection start까지의 text length로 `startOffset`을 계산한다.
4. `selectedText`가 scope text에서 몇 번째 occurrence인지 계산한다.
5. selection 앞뒤 40-80자 정도를 `prefix`, `suffix`로 저장한다.
6. code/pre/link/button/input/textarea/contenteditable/popover 안의 selection은 제외한다.

scope root:

- source: `.source-chunk[data-chunk-id]` 안의 body 영역. 새로 `.source-chunk-body[data-annotation-scope]`를 둔다.
- tutor block: `[data-lookup-block-id]`
- fallback chat message: `[data-chat-message-id]`

중요한 제약:

- v1에서는 cross-scope selection을 저장 가능 annotation으로 만들지 않는다.
- 예를 들어 두 tutor block을 가로질러 선택하면 toolbar를 숨기거나, 저장은 허용하더라도 inline link anchor는 만들지 않는다.
- 이 제약이 있어야 잘못된 위치에 link가 생기는 것을 막을 수 있다.

## 6. Inline Link Rendering

source/tutor markdown string을 직접 수정하지 않는다. 렌더된 DOM 위에 annotation mark를 적용한다.

새 helper:

- `src/views/main/annotation-inline-links.ts`
- 테스트: `src/views/main/annotation-inline-links.test.ts`

새 component:

- `src/views/main/components/AnnotationInlineScope.tsx`

역할:

```tsx
<AnnotationInlineScope
  annotations={scopeAnnotations}
  activeAnnotationId={activeAnnotationId}
  onActivateAnnotation={scrollToAnnotationCard}
>
  <MarkdownContent content={text} />
</AnnotationInlineScope>
```

동작:

1. React children이 렌더된 후 `useLayoutEffect`에서 root DOM을 검사한다.
2. 이전에 삽입한 `.annotation-inline-link` wrapper를 먼저 제거한다.
3. annotation anchor를 root 안에서 resolve한다.
4. 뒤쪽 offset부터 순서대로 Range를 만들어 wrapper를 삽입한다.
5. wrapper는 `<a href="#annotation-card-${id}">`를 쓰되 click은 preventDefault 후 내부 scroll handler가 처리한다.
6. skip selector는 다음을 포함한다.
   - `a`, `button`, `input`, `textarea`, `select`
   - `code`, `pre`, `kbd`, `samp`
   - `.katex`, `.selection-toolbar`, `.lookup-popover`
   - `.source-annotation-list`, `.chat-annotation-list`, `.source-mark-list`
   - `.annotation-inline-link`

DOM wrapper 예시:

```html
<a
  href="#annotation-card-..."
  class="annotation-inline-link annotation-kind-lookup"
  data-annotation-id="..."
  data-annotation-kind="lookup"
>
  selected text
</a>
```

highlight는 같은 wrapper를 쓰되 class만 다르게 둔다.

```html
<a
  href="#annotation-card-..."
  class="annotation-inline-link annotation-kind-highlight annotation-highlight-yellow"
  data-annotation-id="..."
>
  selected text
</a>
```

highlight-only는 이동할 card가 없을 수 있으므로 `href`는 `#annotation-link-${id}` 또는 없게 두고, click 시 간단한 inline focus만 수행한다. note/lookup/question/image는 card id로 이동한다.

## 7. File-Level Implementation Plan

### Shared types

Modify:

- `src/shared/artifact-types.ts`
  - `TextSelectionAnchor` type 추가
  - `MaterialAnnotation.textAnchor` 추가
  - `HighlightResult.style` 추가
- `src/shared/rpc-types.ts`
  - `annotations.save` params에 `textAnchor?: TextSelectionAnchor | null` 추가

### Database and persistence

Modify:

- `src/bun/project-db.ts`
  - `material_annotations` create SQL에 `anchor_json TEXT` 추가
  - 기존 DB migration에서 column 없으면 `ALTER TABLE` 수행
  - `migrateMaterialAnnotationKindCheck()` table rebuild에도 `anchor_json` 포함
- `src/bun/annotation-store.ts`
  - row type에 `anchor_json`
  - `rowToAnnotation()`에서 parse
  - `saveMaterialAnnotation()`에서 stringify
  - `replaceMaterialAnnotations()`에서 import/export 보존
- `src/bun/annotation-service.ts`
  - `SaveLookupInput.textAnchor`를 store로 전달

### Selection capture

Modify:

- `src/views/main/components/LearningSelectionLookup.tsx`
  - `SelectionState`에 `textAnchor` 추가
  - readSelection에서 same scope anchor 계산
  - toolbar에 highlight action 추가
  - highlight는 `annotations.save`를 직접 호출
  - question/lookup/image save에도 `textAnchor` 포함
- `src/views/main/components/ImmersiveSourceView.tsx`
  - `SelectionState`에 `textAnchor` 추가
  - source chunk body scope를 명확히 분리
  - highlight save에 `{ kind: "highlight", style: "yellow" }` 저장
  - lookup/question/image save에도 `textAnchor` 포함
  - legacy mark migration은 `textAnchor` 없이 유지하되 best-effort inline 표시만 시도

### Inline rendering in source view

Modify:

- `src/views/main/components/ImmersiveSourceView.tsx`
  - `annotationsByChunk`와 별도로 `inlineAnnotationsByChunk` 계산
  - `MarkdownContent`를 `AnnotationInlineScope`로 감싼다.
  - saved source annotation card에 `id="annotation-card-${annotation.id}"` 부여
  - active card state를 두고 scroll/pulse 처리
  - highlight-only는 `source-mark-list`에 중복 표시하지 않는다.
  - note는 기존 textarea card/list 유지

### Inline rendering in chat view

Modify:

- `src/views/main/App.tsx`
  - `ChatLog`에 active annotation state/scroll handler 추가
  - fallback plain markdown message도 `AnnotationInlineScope`로 감싼다.
  - `ChatSavedAnnotationCard`에 stable card id와 "원문 위치" action 추가
- `src/views/main/components/TutorBlockRenderer.tsx`
  - block별 inline annotations를 받을 수 있게 props 확장
  - 각 `[data-lookup-block-id]` wrapper 안에서 `AnnotationInlineScope` 적용
  - paragraph/bullets/flow/table 내부는 개별 `MarkdownContent` 수정이 아니라 block wrapper DOM 기준으로 mark한다.
- `src/views/main/annotation-placement.ts`
  - card placement는 기존 규칙 유지
  - inline placement용 helper를 별도로 추가한다.
  - source card render와 inline mark 대상 필터를 분리한다.

### CSS

Modify:

- `src/views/main/styles/app.css`
  - `.annotation-inline-link`
  - `.annotation-kind-question`
  - `.annotation-kind-lookup`
  - `.annotation-kind-image`
  - `.annotation-kind-note`
  - `.annotation-kind-highlight`
  - `.annotation-highlight-yellow`
  - `.annotation-card-active`
  - dark theme variants

CSS 원칙:

- 링크/하이라이트가 line-height를 바꾸지 않게 `box-decoration-break: clone`과 background/underline 중심으로 처리한다.
- hover/focus-visible은 명확히 보이게 한다.
- text selection과 충돌하지 않게 pointer behavior를 과하게 만들지 않는다.
- card pulse animation은 짧고 한 번만 수행한다.

## 8. Detailed Flow

### Source lookup save

```text
user selects source text
-> ImmersiveSourceView.readSelection()
-> buildTextSelectionAnchor(range, source chunk body)
-> user clicks lookup/question/image
-> result appears in LookupPopover
-> Save
-> annotations.save({ surface: "source", textAnchor, ... })
-> DB + annotations.json updated
-> App.handleAnnotationSaved updates artifacts.annotations
-> ImmersiveSourceView rerenders
-> AnnotationInlineScope wraps selected source text
-> SourceAnnotationCard appears below chunk
-> inline link click scrolls to card
```

### Chat lookup save

```text
user selects tutor answer text
-> LearningSelectionLookup.readSelection()
-> nearest tutor block/message scope found
-> buildTextSelectionAnchor(range, scope)
-> user clicks question/lookup/image
-> Save
-> annotations.save({ surface: "chat", anchorMessageId, anchorBlockId, textAnchor, ... })
-> App.handleAnnotationSaved updates artifacts.annotations
-> ChatLog/TutorBlockRenderer rerender
-> AnnotationInlineScope wraps selected answer text
-> ChatSavedAnnotationCard appears after exact block/message
-> inline link click scrolls to card
```

### Highlight save

```text
user selects text
-> anchor computed
-> user clicks Highlighter
-> annotations.save({
     kind: "highlight",
     result: { kind: "highlight", style: "yellow" },
     sourceMeta: [],
     textAnchor
   })
-> inline yellow mark appears
```

No AI call is needed for highlight.

## 9. Tests

Add unit tests:

- `src/views/main/selection-anchor.test.ts`
  - computes start/end offsets inside a simple paragraph
  - distinguishes repeated selected text by occurrence
  - stores prefix/suffix context
  - returns null for cross-scope selection
  - returns null for selection inside ignored controls/code
- `src/views/main/annotation-inline-links.test.ts`
  - wraps the correct occurrence
  - resolves by offset when selected text repeats
  - falls back to prefix/suffix when offset drifted
  - skips existing external links and code blocks
  - unwraps old marks before reapplying
  - calls activation handler on click
- `src/bun/annotation-store.test.ts` or existing DB test area
  - saves and loads `textAnchor`
  - `replaceMaterialAnnotations()` preserves `textAnchor`
  - old annotations without `anchor_json` still load
- `src/views/main/annotation-placement.test.ts`
  - existing card placement stays exact
  - inline helper groups chat annotations by block/message
  - highlight-only annotations do not become source explanation cards

Run:

```bash
bun test
bun run typecheck
```

Manual QA:

1. Start app with a material containing repeated terms.
2. In chat view, select the second occurrence of a repeated word in a tutor block.
3. Save a wiki lookup.
4. Confirm the second occurrence, not the first, becomes linked.
5. Click inline link and confirm it scrolls to the saved card.
6. Click card's source-position action and confirm it returns to the text.
7. Switch to source view and save highlight/note/lookup.
8. Restart app and confirm annotations persist from SQLite/project `annotations.json`.
9. Delete a card and confirm inline mark disappears.
10. Confirm external Markdown links still open through `app.openExternal`.

## 10. Phased Implementation

### Phase 1: Data and anchor foundation

- Add `TextSelectionAnchor` type.
- Add `anchor_json` DB column and migration.
- Thread `textAnchor` through save/load/import/export.
- Add anchor capture/resolve helpers with tests.

Exit criteria:

- Existing annotations still load.
- New annotations can persist `textAnchor`.
- `bun test` passes for store/helper tests.

### Phase 2: Source view inline marks

- Add `AnnotationInlineScope`.
- Apply inline marks in `ImmersiveSourceView`.
- Make source lookup/question/image cards stable scroll targets.
- Convert source highlight from list-only to actual inline highlight.
- Keep note editing UI.

Exit criteria:

- Source highlights visibly mark selected source text.
- Saved source lookup card is reachable from selected text.
- Deleting annotation removes mark.

### Phase 3: Chat view inline links

- Add highlight action to `LearningSelectionLookup`.
- Capture text anchors for chat message/block selections.
- Extend `TutorBlockRenderer` and `ChatLog` with inline scopes.
- Make chat saved cards stable scroll targets.

Exit criteria:

- Saved tutor answer lookup/question/image creates a visible inline link.
- Link scrolls to exact saved card.
- Block-anchored annotations stay on the block where they were created.

### Phase 4: Polish and MD_Reader-style affordances

- Add focused/active pulse.
- Add accessible keyboard activation for inline links.
- Add optional highlight style support in UI if the single yellow highlight feels limiting.
- Tune dark theme colors.

Exit criteria:

- The feature reads as one coherent annotation system, not separate lookup/highlight hacks.
- No layout shift or text overlap in source/chat view.

## 11. Risks and Mitigations

Repeated text:

- Store occurrence + offset + prefix/suffix.
- Resolve by offset first, then occurrence, then prefix/suffix scoring.
- If confidence is low, do not mark inline. Show card only.

Markdown/DOM mismatch:

- Do not inject markdown syntax into source text.
- Apply marks after `ReactMarkdown` renders.
- Skip code, pre, link, form controls, KaTeX, annotation cards.

React DOM mutation risk:

- Keep mutations inside `AnnotationInlineScope`.
- Always unwrap previous marks before reapplying.
- Reapply only after children render and annotation list changes.
- Do not mutate nodes outside the scope root.

Performance:

- Group annotations by visible scope before rendering.
- Skip inline resolver when group is empty.
- Bound source/chunk annotation count in helper loops.
- Prefer source chunk/block scope instead of scanning the whole app.

Old annotations:

- Keep old cards visible.
- Best-effort inline mark only when unambiguous.
- Do not force migration that guesses wrong text positions.

## 12. Non-Goals

- Do not rewrite source markdown files or generated tutor messages.
- Do not store copied image binaries for image lookup in this pass.
- Do not implement cross-chunk or cross-message annotation ranges in v1.
- Do not replace the OS/WebView default context menu.
- Do not make a separate annotation database when `material_annotations` already owns this behavior.
