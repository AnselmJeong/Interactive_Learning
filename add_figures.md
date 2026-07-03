# Add Source Figures to Learnie

## Goal

Learnie already imports figure-rich PDF/EPUB sources through Preppy. The next product step is to show source figures and captions by default, then let the learner ask for an explanation of a figure. If the active AI model cannot process images, the app should say that figure explanation needs a vision-capable model instead of pretending to analyze the image.

## Technical Feasibility

This is technically feasible with the current architecture.

The extraction layer is already mostly ready. Preppy defines a durable `Figure` model with `id`, `asset_path`, `caption`, `caption_status`, source locator, dimensions, and hash, and writes a `figures.json` index plus image assets into the source pack. The writer emits:

- `manifest.json`
- `figures.json`
- `diagnostics.json`
- `document.json`
- chapter Markdown under `chapters/`
- figure images under `assets/`

The app layer is not yet wired for figures. `SourceService` currently imports PDF/EPUB output as chapter Markdown files, normalizes those into `SourceChunk[]`, and persists only `source_manifest.json` and `source_chunks.json` per `project_source`. The preppy pack itself is preserved under `source_folders/.../original`, so figure assets are not lost, but figure metadata is not promoted into `SourceSummary`, `SourceManifest`, `MaterialArtifacts`, `TutorContext`, or tutor messages.

The renderer layer is also mostly ready for display. `MarkdownContent` already renders Markdown images as:

- `<figure className="markdown-figure">`
- `<img src=...>`
- `<figcaption>` from the image alt text

Local Markdown image links are already rewritten to `file://` URLs in `SourceService`. Therefore, default figure display can use either existing Markdown image syntax or a first-class `SourceFigure` renderer. I recommend a first-class figure model plus a reusable `SourceFigureCard`, because it gives us stable IDs, captions, explanation buttons, source references, model gating, and future search/filter support without smuggling behavior through Markdown strings.

Vision explanation needs a backend change. Current `AiChatClient` is text-only:

```ts
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
```

The current Gemini adapter also sends only text parts to `generateContent`. Context7 documentation for Gemini confirms that image understanding can be done by sending `contents[].parts` with both text and inline image data:

```json
{
  "parts": [
    { "inlineData": { "mimeType": "image/jpeg", "data": "..." } },
    { "text": "Describe this image." }
  ]
}
```

So the backend can support figure explanation without replacing the current AI stack, but it needs a multimodal request path.

## Product Behavior

Default behavior:

- When a source has figures, show the figure and caption in the source-reading view near the relevant source section.
- Show figures in source evidence panels when a tutor answer references a chunk associated with figures.
- Captions should be visible without requiring AI.
- Missing captions should display a quiet fallback such as `Figure from source` plus locator metadata when available.

Learner-requested explanation:

- Each figure card gets an explain action.
- If the selected model is known or detected as vision-capable, send the image plus caption and nearby source context to the model.
- If the selected model is not vision-capable, show a short explanation that this figure needs a vision-capable model, and suggest selecting a vision model in Settings.
- If capability is unknown, fail closed by default: do not send the image unless the provider/model is in the vision allowlist or a live capability probe has succeeded.

What not to do:

- Do not auto-generate explanations for every figure at import time. That is slow, expensive, and unnecessary.
- Do not mix figure explanation into normal tutor turns unless the user explicitly asks about a figure.
- Do not expose parser or extraction internals to the learner. Figure IDs, caption statuses, and asset paths belong in diagnostics or developer metadata, not primary UI copy.

## Data Model Plan

Add shared figure types in `src/shared/artifact-types.ts`:

```ts
export type SourceFigure = {
  id: string;
  sourceId: string;
  title: string;
  assetPath: string;
  assetUrl: string;
  mimeType: string;
  caption: string | null;
  captionStatus: string;
  width: number | null;
  height: number | null;
  locator: string;
  pageRange?: [number, number];
  sourceChunkIds: string[];
};
```

Extend `MaterialArtifacts`:

```ts
figures: SourceFigure[];
figureIndex: Record<string, { sourceId: string; title: string; locator: string; sourceChunkIds: string[] }>;
```

Extend tutor-facing types only where needed:

- Add `figures?: SourceFigure[]` to `TutorContext`.
- Add optional `figureRefs?: string[]` to `TutorTurnOutput` and `TutorMessage` only if tutor turns need to preserve figure-specific references.
- Prefer not adding a figure block to `TutorContentBlock` until we need inline figure cards inside chat. Default display should live in source/evidence views first.

Database migration options:

1. Low-risk JSON artifact path first:
   - Keep DB schema unchanged.
   - Write per-source `source_figures.json` next to `source_manifest.json` and `source_chunks.json`.
   - Add `figures_path` later only if querying figures without reading artifacts becomes necessary.

2. Full DB-backed figure table:
   - Add `source_figures` with `id`, `source_id`, `asset_path`, `caption`, locator fields, dimensions, and `source_chunk_ids_json`.
   - Better for future search and deduplication, but more migration surface now.

Recommendation: start with `source_figures.json`. It matches the current artifact-based design and keeps the first implementation small.

## Import and Mapping Plan

Add Preppy figure ingestion to `SourceService`.

Current flow:

1. `buildPreppySourcePack(path)` creates a temporary `.preppy` output.
2. `SourceService.importFolder(...)` copies the entire pack to `source_folders/<folderImportId>/original`.
3. Each selected chapter Markdown file becomes a separate `project_source`.
4. Chunks are generated from the copied chapter Markdown.

Needed changes:

1. Read `figures.json` from the copied preppy root.
2. Read `manifest.json` to map `chapter.index` and `chapter.path`.
3. For every imported chapter source, attach figures whose `chapter_index` matches that chapter.
4. Resolve `asset_path` relative to the copied preppy root and create a `file://` URL for renderer use.
5. Associate figures to chunks:
   - First pass: assign every chapter figure to the first chunk of that chapter source.
   - Better pass: if a chunk is `kind: "caption"` or contains the figure caption text, attach the figure to that chunk.
   - If no caption match is found, attach to the nearest heading/chapter chunk and preserve locator metadata.
6. Write `source_figures.json` beside each source's manifest/chunks.

Direct `.md` imports:

- Keep supporting Markdown image links as today.
- Optionally extract Markdown image links into `SourceFigure[]` so direct Markdown sources get the same UI affordances.
- This can be a second pass after Preppy figures work.

## Material Generation Plan

Update `CourseArtifactService`:

- Add `SourceService.loadFigures(sourceId)`.
- During `materials.generate`, load figures alongside chunks.
- Write `figures.json` and `figure_index.json` into the material directory.
- Include figures in `getArtifacts(materialId)`.
- Do not include raw images in AI course generation prompts. Captions and nearby chunk IDs are enough for curriculum planning; image bytes are only needed when the learner asks for a figure explanation.

Figure ordering:

- Preserve source order, then chapter order, then Preppy figure order.
- If multiple sources are combined, group by source title in UI.

## UI Plan

Add `SourceFigureCard`:

- Image
- Caption
- Locator/page/chapter hint
- Explain button
- Loading/error/explanation states

Use it in:

1. `ImmersiveSourceView`
   - Show figures attached to a chunk immediately after that chunk's text.
   - If a chapter has figures but no chunk association, show them after the first chunk in that chapter.

2. `AnswerSourceRefs`
   - When expanded evidence includes a chunk with attached figures, show those figures below the quoted/source text.
   - This keeps learner-visible evidence strong without cluttering normal chat.

3. Optional later: source import preview
   - `SourceImportModal` can show a small figure count per prepared chapter, but this is not required for the first version.

CSS already has `.markdown-figure` image/caption styling. Add separate `.source-figure-card` styles only for action buttons and explanation panels.

## Vision Explanation Plan

Add a backend RPC:

```ts
"figures.explain": {
  params: { materialId: string; figureId: string; userPrompt?: string };
  response: { figureId: string; explanation: string; model: string; visionCapable: true };
}
```

Failure shape:

- If no model/key is configured: return a normal error.
- If selected model is not vision-capable: return a typed error code such as `VISION_MODEL_REQUIRED`.
- If image file is missing: return `FIGURE_ASSET_MISSING`.

Extend AI client types with a multimodal method:

```ts
type ImagePart = { mimeType: string; dataBase64: string };

interface AiChatClient {
  listModels(): Promise<ProviderModel[]>;
  chatJson(params: ChatParams): Promise<unknown>;
  chatText(params: ChatParams): Promise<string>;
  describeImage?(params: {
    image: ImagePart;
    prompt: string;
    system?: string;
    model?: string;
    timeoutMs?: number;
  }): Promise<string>;
}
```

Provider support:

- Gemini native: implement first using `generateContent` with `inlineData`.
- OpenAI-compatible: support later using `messages[].content` parts with `image_url` data URLs, if the provider/model accepts it.
- Anthropic: support later with Anthropic image content blocks.
- Ollama/OpenAI-compatible local or cloud models: only enable when selected model is known vision-capable or a probe succeeds.

Capability detection:

- Add `supportsVision?: boolean` to `ProviderModel`.
- Gemini model list currently returns only IDs; add a heuristic allowlist as a fallback.
- Do not trust model names blindly forever. Add a small `visionModelPatterns` helper and keep it isolated:
  - Examples: names containing `vision`, `vl`, `gpt-4o`, `gemini`, or specific configured model IDs.
  - Treat this as a UI hint, not authority.
- Add an optional live probe in Settings later: send a tiny generated 1x1 image to the selected model and cache whether it accepts image input.

Important: do not hardcode the user's example names as the only truth. Model names change. The implementation should support configured vision-capable models while showing a clear fallback for text-only models.

Prompt for figure explanation:

- Input: image, caption, source title, locator, nearby chunk text.
- Ask for:
  - What the figure appears to show.
  - How the caption frames it.
  - How it relates to the nearby source section.
  - Any uncertainty if the image is unclear.
- Keep answer concise and learner-facing.

## Security and Privacy

- Treat figure explanation as an explicit user action. Do not send images to external providers automatically.
- Show provider/model in the explanation result or tooltip so the user understands where analysis came from.
- Use local `file://` URLs only for renderer display. For AI calls, read the image bytes in the Bun process and send base64 only after the user clicks explain.
- Validate the requested `figureId` belongs to the requested `materialId`; do not accept arbitrary file paths from the renderer.
- Enforce MIME type from file extension and/or image sniffing, not from user-controlled metadata alone.
- Bound image size before sending. If a figure is very large, resize or reject with a clear message.

## QA Plan

Unit tests:

- Preppy figure index parsing maps figures to the correct chapter source.
- Caption matching attaches a figure to the expected chunk when caption text appears in a chunk.
- `loadFigures(sourceId)` returns stable `file://` URLs and excludes missing assets with a warning.
- Vision capability helper classifies known text-only and known vision-capable model IDs.

Integration tests:

- Import an EPUB/PDF fixture with figures.
- Prepared import still shows selectable chapters.
- Generated material includes `figures`.
- Source view renders image + caption.
- Evidence expansion renders associated figures.
- Clicking explain with a text-only model shows `VISION_MODEL_REQUIRED`.
- Clicking explain with Gemini vision sends inline image data and displays the returned explanation.

Manual smoke:

- `bun run build`
- Import `python/tests` EPUB fixture or a small figure-rich PDF.
- Start a session and verify:
  - source view shows figures by default
  - chat remains uncluttered
  - evidence panel shows figures for referenced chunks
  - explanation button handles both text-only and vision-capable models

## Implementation Phases

Phase 1: Data plumbing and display

- Add `SourceFigure` types.
- Add `source_figures.json` writing in `SourceService`.
- Add `loadFigures`.
- Add `figures` to `MaterialArtifacts`.
- Render figures in `ImmersiveSourceView` and `AnswerSourceRefs`.
- No AI vision yet; explain button can be present but disabled with a tooltip, or hidden until Phase 2.

Phase 2: Vision explanation

- Add `figures.explain` RPC.
- Add `describeImage` to AI client abstraction.
- Implement Gemini native multimodal support first.
- Add text-only fallback message for non-vision models.
- Add UI explanation state to `SourceFigureCard`.

Phase 3: Capability hardening

- Add model capability hints to `ProviderModel`.
- Add settings UI cue for vision-capable models.
- Add optional live capability probe/cache.
- Add OpenAI-compatible and Anthropic multimodal paths if needed.

Phase 4: Better association and polish

- Improve chunk association using caption text, locator/page, and chapter proximity.
- Add figure count badges in source list or material overview.
- Add lazy loading for large figure sets.
- Add export/archive inclusion checks so source figure metadata and assets remain portable.

## Key Risks

- Chapter-to-figure mapping is available, but chunk-to-figure mapping is approximate until caption matching is implemented.
- Existing materials will not have figure artifacts until regenerated or backfilled. Plan for a lazy backfill when `getArtifacts` sees missing figure files.
- Model capability is provider-specific and changes over time. Use a small isolated heuristic plus explicit failure handling, not broad assumptions.
- Large images can make provider calls slow or expensive. Resize or cap payloads before sending.

## Recommended First Cut

Implement Phase 1 and Phase 2 with Gemini native vision only.

That gives immediate user value:

- figures and captions appear by default
- source evidence becomes richer
- the learner can request an explanation when using a vision model
- text-only models fail honestly with a clear message

It also keeps scope controlled because it does not require redesigning course generation, normal tutor turns, or provider settings all at once.
