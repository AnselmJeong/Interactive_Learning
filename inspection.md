# Inspection Report

Date: 2026-07-07
Repository: `/Users/anselm/_DEV_/Interactive_Learning`

## Scope

Reviewed the current TypeScript/Electrobun frontend/backend and the Python `preppy` runtime for high-probability bugs, error paths, state consistency risks, feature conflicts, and security-sensitive surfaces. This was a static review plus project verification; it did not include a manual GUI session against a packaged app.

## Verification Results

All automated checks passed:

- `bun run typecheck`: passed.
- `bun test`: passed, 51 tests across 14 files.
- `uv run --project python --extra test pytest`: passed, 15 tests.
- `bun run smoke:python`: passed.
- `bun run build:stable`: passed and produced Electrobun artifacts.

Important warning observed during Bun tests:

- Electrobun logs `Failed to read version.json` while tests import app modules that touch Electrobun path utilities. Tests still pass, but this points to an import-time runtime-environment dependency described in finding P3-02.

## Findings

### P1-01: Tutor session mutations are not serialized per session

**Files**

- `src/bun/tutor-service.ts:723`
- `src/bun/tutor-service.ts:755`
- `src/bun/tutor-service.ts:788`
- `src/bun/tutor-service.ts:824`
- `src/bun/tutor-service.ts:994`
- `src/bun/project-db.ts:233`

**What can go wrong**

The main tutor actions all mutate the same session state and message stream, but there is no backend per-session lock or request version check. `sendTurn`, `advance`, `returnToProgress`, and `openModule` can overlap if IPC calls arrive close together. The UI uses `busy` to disable controls, but React state updates are not an atomic backend guard, and IPC replay or double activation can bypass this.

`insertMessage` calculates the next ordinal with `SELECT MAX(ordinal) + 1` and then inserts. A unique index exists on `(session_id, ordinal)`, so overlapping inserts can either fail with a SQLite constraint error or create stale assistant turns against a cursor that has already moved.

**Impact**

- Duplicate or out-of-order assistant/user messages.
- Failed turns under rapid clicking or concurrent IPC.
- Stale AI responses committed after newer progress actions.
- Session snapshot drift from the DB message stream.

**Recommendation**

Add a per-session mutation queue/lock around all session-writing operations. Keep ordinal assignment inside the serialized section, and add stale-response checks before committing generated tutor turns after an awaited model call.

### P2-01: Material generation deduplication is race-prone

**Files**

- `src/bun/course-artifact-service.ts:297`
- `src/bun/course-artifact-service.ts:315`
- `src/views/main/App.tsx:690`

**What can go wrong**

`generate()` reuses only an existing material whose status is reusable, then inserts a new `generating` row. There is no in-flight lock or uniqueness constraint for the project/source set. If two requests for the same source set arrive before either one becomes ready, both can create separate materials and artifact directories.

The UI comment says `materials.generate` deduplicates by source set, but the backend dedupe is only best-effort and not safe under concurrency.

**Impact**

- Duplicate learning materials for the same source set.
- Confusing material lists.
- Extra artifact directories and stale generated files.

**Recommendation**

Introduce an in-memory generation promise keyed by normalized `(projectId, sortedSourceIds)` and/or a durable source-set identity in the DB. Reuse `generating` rows, not only ready rows, when the source set matches exactly.

### P2-02: Annotation writes can commit to DB and then fail while writing the filesystem snapshot

**Files**

- `src/bun/annotation-service.ts:769`
- `src/bun/annotation-service.ts:789`
- `src/bun/annotation-service.ts:799`
- `src/bun/project-bundle-sync.ts:607`

**What can go wrong**

Annotation save/update/delete first mutates SQLite, then awaits `writeMaterialAnnotationsSnapshot`. If snapshot writing fails because the project folder is unavailable, permission-denied, removed, or otherwise broken, the RPC rejects even though the DB mutation already happened.

**Impact**

- UI can report failure while the annotation was actually saved.
- Retrying can create duplicates or confusing state.
- DB and project bundle files can diverge silently after partial failures.

**Recommendation**

Treat filesystem snapshot writing as a secondary sync step with explicit status reporting, or wrap DB changes and snapshot writes in a recoverable consistency strategy. At minimum, catch snapshot write failures, keep the DB result, surface a nonfatal warning, and schedule a retry.

### P2-03: Ollama routing is hard-coded to remote Ollama and cannot be configured in Settings

**Files**

- `src/bun/settings-service.ts:10`
- `src/bun/settings-service.ts:109`
- `src/views/main/components/SettingsModal.tsx:198`
- `src/bun/openai-compatible-client.ts:52`

**What can go wrong**

The default Ollama base URL is `https://ollama.com/v1`, `normalizeSettings()` forcibly resets `providers.ollama.baseUrl` back to that default, and Settings intentionally hides the Ollama base URL field. The OpenAI-compatible client also requires an API key before listing models.

If local Ollama support is expected, `http://localhost:11434/v1` cannot be persisted from the UI and unauthenticated local model listing is blocked. If remote Ollama-only is intentional, the code and UI should make that explicit because the provider name strongly suggests local Ollama compatibility.

**Impact**

- Local Ollama users cannot configure the expected endpoint.
- Saved custom Ollama base URLs are overwritten.
- Model loading can fail with a missing API key even for local-compatible endpoints.

**Recommendation**

Decide whether `ollama` means local Ollama, remote Ollama, or both. If both, expose/persist the base URL and allow an empty key for trusted local endpoints. If remote-only, rename/copy clarify the provider to avoid configuration ambiguity.

### P2-04: Project-root sync is disabled while the app still exposes project-root selection and bundle files

**Files**

- `src/bun/project-bundle-sync.ts:583`
- `src/bun/project-service.ts:405`

**What can go wrong**

`syncProjectRootToDb()` always returns `sync_disabled`, so only DB-known projects are listed. At the same time, the app writes project bundle manifests/snapshots and exposes project root migration. `migrateUnsetProjectRoots()` migrates only rows with unset/legacy roots; it does not import or reconcile project folders already present on disk.

**Impact**

- Existing project folders in the selected root can remain invisible.
- Users may assume changing the root discovers projects, but the DB remains authoritative.
- Bundle files can look like a portable project format while import/recovery is disabled.

**Recommendation**

Either implement root-to-DB reconciliation for `project.json` bundles or make the UI copy clear that root selection only controls storage for DB-known projects. Add a recovery/import command if bundle files are meant to be durable.

### P3-01: Duplicate folder imports can leave orphaned copied source folders

**Files**

- `src/bun/source-service.ts:715`
- `src/bun/source-service.ts:761`
- `src/bun/source-service.ts:803`

**What can go wrong**

`importFolder()` copies the entire folder into a new `source_folders/<uuid>/original` directory before importing selected text files. `importTextFileFromCopiedFolder()` returns an existing source immediately when content hash matches an existing source. If all selected files are duplicates, the newly copied folder has no source row pointing to it and is not removed.

**Impact**

- Storage grows with orphaned copied folders.
- Future cleanup cannot easily know which copy is unused.

**Recommendation**

Track whether any new sources were created. If none were created, remove the copied `source_folders/<uuid>` directory before returning. If some were created and some were duplicates, consider whether preserving the full copied folder is required for the new sources.

### P3-02: App path constants invoke Electrobun path utilities at import time

**Files**

- `src/bun/settings-service.ts:8`
- `src/bun/ai-provider-settings.ts:12`
- `src/bun/paths.ts:15`

**What can go wrong**

`SETTINGS_PATH` and `SECRET_PATH` are computed at module load time via `dataPath()`, which calls `appDataDir()`, which reads `Utils.paths.userData`. In the test environment this produces Electrobun `version.json` read errors even though tests pass.

**Impact**

- Noisy tests and harder-to-spot real failures.
- Import-time side effects make modules sensitive to the Electrobun runtime environment.
- Future tests or CLI scripts may fail if Electrobun path resolution gets stricter.

**Recommendation**

Make settings/secret path resolution lazy inside service methods, or let tests inject `LEARNIE_APP_DATA_ROOT` before importing modules that call `dataPath()`. Prefer avoiding filesystem/Electrobun side effects at module import.

### P3-03: Invalid chapter-boundary regex can crash conversion planning

**Files**

- `python/src/preppy/engines/pdf_docling.py:425`
- `python/src/preppy/engines/epub_dom.py:90`

**What can go wrong**

Both PDF and EPUB planning compile user-supplied `boundary_pattern` directly. Invalid regex syntax raises `re.error`. For PDF conversion, this happens after Docling conversion succeeds, so it is not handled by the Docling fallback path. For EPUB planning, it also surfaces as a raw planning error.

**Impact**

- A bad CLI/UI regex can fail conversion with a raw exception instead of a clear validation error.
- Users may interpret this as document conversion failure rather than invalid input.

**Recommendation**

Validate `boundary_pattern` once at the CLI/service boundary and return a clean error message. Reuse the compiled pattern rather than compiling separately in each engine.

## Areas Reviewed With No Blocking Findings

- TypeScript type safety: current code passes `tsc --noEmit`.
- Bun unit tests: current suite passes.
- Python conversion tests: current suite passes.
- Stable packaging path: `bun run build:stable` completes.
- Basic command-injection surface: local file opener and Preppy runner use `spawn` with argument arrays, not shell command strings.
- Unsafe HTML rendering search: no `dangerouslySetInnerHTML`, `eval`, or `new Function` usage found in app source.
- External URL opener: frontend filters to `http:`/`https:` before calling the backend opener.

## Recommended Fix Order

1. Add backend serialization for tutor session mutations and cover it with a concurrent request test.
2. Make material generation idempotent for in-flight duplicate source-set requests.
3. Make annotation snapshot write failures recoverable and visible without lying about DB commit state.
4. Resolve the Ollama provider semantics and update Settings/model listing behavior accordingly.
5. Decide whether project bundle sync is intentionally disabled; either implement reconciliation or make the limitation explicit.
6. Clean up duplicate folder-import copies and validate boundary regex input.

## Suggested Tests

- Concurrent `sessions.sendTurn` plus `sessions.advance` for the same session should produce contiguous ordinals and no stale assistant turn.
- Two parallel `materials.generate(projectId, sameSourceIds)` calls should return the same material.
- Annotation save with a simulated snapshot write failure should not create duplicate annotations on retry.
- Settings normalization should preserve a user-configured Ollama base URL if local Ollama support is intended.
- Folder import with all duplicate files should leave no orphaned `source_folders/<uuid>` directory.
- Invalid `boundary_pattern` should return a controlled validation error for PDF and EPUB paths.
