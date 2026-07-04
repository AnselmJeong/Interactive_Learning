# Learnie stabilization and optimization action plan

작성일: 2026-07-04
입력 문서: `fable_suggestion.md`
대상: Learnie 0.4.5

## 판단 기준

`fable_suggestion.md`의 지적은 대부분 현재 코드와 맞다. 다만 전부 즉시 적용하면 `tutor-service.ts`와 persistence 경로가 동시에 크게 흔들리므로, 실제 사용자 피해가 큰 순서대로 나눈다.

수용 기준은 다음과 같다.

- 크래시, 데이터 손실, 학습 진도 누락은 즉시 수용한다.
- 반복 디스크 I/O, 세션 snapshot 남용, 이미지 재전송처럼 체감 성능에 직접 영향을 주는 항목은 수용하되 안정화 패치 뒤에 둔다.
- 거대 파일 분리, prompt 리소스화처럼 맞는 방향이지만 당장 버그를 줄이지 않는 변경은 테스트가 생긴 뒤 단계적으로 한다.
- Windows build가 목표이므로 OS lock-in 제거는 선택적 정리가 아니라 release blocker로 본다. macOS 전용 path/command/bundle 가정은 Phase 1 직후 바로 다룬다.

## 현재 진단

- 앱 구조는 Electrobun/Bun backend services, React main view, Python `preppy` ingestion으로 나뉜다.
- 검증 명령은 `bun run typecheck`, `bun run smoke:python`, `bun run test:python`가 있다.
- TypeScript 단위 테스트는 사실상 없다. 이번 계획의 첫 구현 묶음에서 `bun test` 기반 최소 회귀 테스트를 추가해야 한다.
- Windows build 예정이므로 현재 macOS 중심 설계인 `detailed_plan.md`의 전제는 더 이상 제품 전제가 아니다. runtime code와 build config는 최소 macOS + Windows를 동등한 target으로 둔다.
- 현재 작업 트리에는 `fable_suggestion.md`와 `action_plan.md`만 untracked로 보인다. 이후 구현 시 기존 사용자 변경과 섞이지 않게 좁게 staging한다.

## Phase 1: 즉시 안정화 패치

목표: 크래시, 데이터 손실, stuck 상태, 잘못된 UI 상태를 작게 제거한다.

1. `headingPath` null 오염 방지
   - 수용: 즉시.
   - 파일: `src/bun/source-service.ts`, 필요 시 `src/views/main/App.tsx`, `src/bun/course-artifact-service.ts`.
   - 내용: markdown heading stack을 sparse array로 만들지 않도록 수정하고, `loadChunks`에서 기존 `null`/non-string headingPath를 sanitize한다.
   - 테스트: `##`로 시작하는 문서, `#` 뒤 `###`로 건너뛰는 문서에 대한 TS 회귀 테스트.
   - 리스크: 낮음. 저장된 오염 데이터 정화까지 포함해야 한다.

2. 프로젝트 root purge 안전장치
   - 수용: 즉시.
   - 파일: `src/bun/project-bundle-sync.ts`.
   - 내용: root에 project 후보가 하나도 없을 때는 DB cascade delete를 하지 않고 warning만 남긴다. macOS `/Volumes/`, Windows drive letter/removable drive, UNC/network share처럼 root가 일시적으로 unavailable일 수 있는 경로는 mount/access 상태를 먼저 확인한다.
   - 테스트: 빈 root sync가 기존 DB project를 삭제하지 않는 단위/스모크 테스트.
   - 리스크: 낮음. 의도적 전체 삭제 기능은 별도 explicit action으로만 허용해야 한다.

3. stuck `generating` material 복구
   - 수용: 즉시.
   - 파일: `src/bun/course-artifact-service.ts`, `src/bun/index.ts`.
   - 내용: 앱 시작 시 `learning_materials.status = 'generating'`을 `failed`로 정리한다. dedupe는 오래된 `generating`을 재사용하지 않게 한다.
   - 테스트: generating row가 남은 상태에서 같은 source set으로 다시 generate 가능해야 한다.
   - 리스크: 낮음. 현재 generator는 deterministic path라 재생성이 안전하다.

4. Settings provider deep merge
   - 수용: 즉시.
   - 파일: `src/bun/settings-service.ts`.
   - 내용: `providers`를 shallow overwrite하지 않고 provider id 단위로 deep merge한다.
   - 테스트: OpenAI 모델 저장 후 Gemini 일부 patch를 저장해도 OpenAI 선택 모델이 유지되어야 한다.
   - 리스크: 낮음.

5. Prefetch status session guard
   - 수용: 즉시.
   - 파일: `src/views/main/App.tsx`.
   - 내용: 현재 session이 없거나 event sessionId가 다르면 prefetch status를 반영하지 않는다.
   - 테스트: session null 상태에서 다른 session prefetch event를 무시한다.
   - 리스크: 낮음.

## Phase 1.5: Cross-platform portability baseline

목표: Windows build를 막는 OS lock-in을 early blocker로 제거한다. 이 단계는 UI 기능 추가가 아니라 runtime/build compatibility 작업이다.

1. Platform adapter 추가
   - 수용: 필수.
   - 파일: `src/bun/platform-utils.ts` 신규, `src/bun/index.ts`, `src/bun/project-service.ts`, `src/bun/paths.ts`, `src/bun/preppy-service.ts`.
   - 내용: platform 감지를 한 곳에 모으고, path/open/archive/python executable 같은 OS별 차이를 service code에서 직접 쓰지 않게 한다.
   - 범위: `openPath`, archive zip, user data fallback, bundled Python executable path, executable extension, packaged resource root.
   - 검증: macOS에서 기존 동작 유지. Windows에서는 unit test가 platform path candidates와 command selection을 검증한다.
   - 리스크: 중간. adapter만 만들고 business logic은 바꾸지 않는다.

2. Archive export에서 `/usr/bin/zip` 제거
   - 수용: 필수.
   - 파일: `src/bun/project-service.ts`, 필요 시 `src/bun/archive-writer.ts`.
   - 내용: macOS 전용 `/usr/bin/zip` 호출을 제거한다. 우선순위는 Bun/Node 기반 zip writer 또는 Electrobun/Node에서 안정적으로 동작하는 cross-platform archive helper다. 외부 CLI fallback을 둔다면 `zip`, PowerShell `Compress-Archive` 등을 adapter 뒤에 숨기고 capability check를 둔다.
   - 검증: macOS와 Windows에서 export zip 내부 구조가 동일해야 한다.
   - 리스크: 중간. archive format이 사용자-visible output이므로 snapshot-style 테스트가 필요하다.

3. Folder/file open 동작 cross-platform화
   - 수용: 필수.
   - 파일: `src/bun/index.ts`, `src/bun/platform-utils.ts`.
   - 내용: `spawn("open")`을 직접 호출하지 않는다. Electrobun/OS API를 먼저 쓰고, fallback은 macOS `open`, Windows `explorer.exe`, Linux `xdg-open`으로 adapter가 선택한다.
   - 검증: path with spaces, non-existing path, URL open과 folder open이 분리되어야 한다.
   - 리스크: 낮음.

4. Bundled Python runtime 경로 일반화
   - 수용: 필수.
   - 파일: `scripts/prepare-python-runtime.ts`, `src/bun/preppy-service.ts`, `electrobun.config.ts`.
   - 내용: `.bundle/<platform-arch>/runtime/bin/python3.12` 같은 POSIX-only path를 추상화한다. Windows는 `runtime/python.exe` 또는 `runtime/Scripts/python.exe` 후보를 지원하고 `.exe` extension을 처리한다.
   - 함께 수정: `targetName`은 `macos-arm64`뿐 아니라 `win32-x64` 등 packaging target을 명시적으로 다룬다. build artifact 검증도 platform별로 분리한다.
   - 검증: restricted PATH에서 bundled interpreter로 `python -m preppy.cli --help`가 실행되어야 한다. macOS와 Windows 각각 별도 smoke가 필요하다.
   - 리스크: 높음. Python native wheels/docling dependency가 platform-specific이므로 Windows runner나 실제 Windows machine 검증이 필요하다.

5. Electrobun build config와 assets 다중 target화
   - 수용: 필수.
   - 파일: `electrobun.config.ts`, `assets/`, package scripts.
   - 내용: macOS `build.mac.icons`만으로 끝내지 않는다. Windows icon/installer metadata/signing placeholder를 별도 target 설정으로 둔다. macOS `.icns`와 Windows `.ico`를 같은 source asset에서 생성하는 script를 둔다.
   - 검증: `build/stable-macos-*`와 Windows stable artifact가 각각 필요한 resources를 포함해야 한다.
   - 리스크: 중간. Electrobun의 Windows packaging 지원 범위는 구현 전에 현재 docs/API를 확인한다.

6. Cross-platform path tests
   - 수용: 필수.
   - 파일: `src/bun/*.test.ts` 또는 `tests/platform-utils.test.ts`.
   - 내용: Windows-style path, UNC path, spaces, non-ASCII project title, archive filename sanitization, resource root detection을 테스트한다.
   - 검증: `bun test`가 macOS host에서도 Windows path logic을 pure function으로 검증해야 한다.
   - 리스크: 낮음.

## Phase 2: 세션 정합성 및 진행 cursor 통합

목표: 매 턴마다 상태가 조용히 꼬이거나, 새 메시지가 sync에 의해 사라지는 구조를 제거한다.

1. `listSessions`에서 전체 project root sync 제거
   - 수용: 우선순위 높음.
   - 파일: `src/bun/tutor-service.ts`, `src/bun/project-bundle-sync.ts`, 필요 시 `src/bun/project-service.ts`.
   - 내용: `sessions.list`는 DB read만 수행한다. root sync는 앱 시작, root 변경, project open/import 같은 명시적 경계에서만 실행한다.
   - 함께 수정: `importSessions`는 `existing.updated_at >= snapshot.updatedAt`이면 skip, delete+reinsert는 transaction으로 감싼다.
   - 함께 수정: `insertMessage`는 `learning_sessions.updated_at`도 bump한다.
   - 검증: 긴 세션에서 턴 후 `refreshSessions`가 파일 hash 재계산을 하지 않아야 한다.
   - 리스크: 중간. sync 호출 시점 누락이 생기지 않도록 project open/import 경로를 함께 점검한다.

2. message ordinal 무결성
   - 수용: Phase 2에 포함.
   - 파일: `src/bun/project-db.ts`, `src/bun/tutor-service.ts`.
   - 내용: `UNIQUE(session_id, ordinal)` 인덱스를 추가하고 ordinal은 `COUNT(*)` 대신 `COALESCE(MAX(ordinal)+1, 0)`로 계산한다.
   - 검증: 동시 insert나 재시도에서 중복 ordinal이 발생하지 않아야 한다.
   - 리스크: 중간. 기존 DB에 중복 ordinal이 있으면 migration 보정이 필요하다.

3. cursor 변경을 success-only commit path로 통합
   - 수용: 우선순위 높음.
   - 파일: `src/bun/tutor-service.ts`.
   - 내용: typed "계속/넘어가" heuristic, `advance("chunk")`, `advance("module")`, last-chunk finish prompt가 모두 `plan -> generate -> commit` 경로를 사용하게 한다. AI 턴 생성 성공 전에는 cursor를 persist하지 않는다.
   - 기존 활용: `planDefaultContinue`, `progressPlan`, `generatePlannedProgressTurn`, `commitPlannedTutorTurn`.
   - 검증: AI timeout/failure 후 같은 진행 명령을 다시 보내도 chunk가 건너뛰어지지 않아야 한다.
   - 리스크: 높음. 학습 흐름 핵심이므로 Phase 1 테스트를 먼저 깔고 작은 diff로 진행한다.

4. typed progression heuristic 축소
   - 수용: Phase 2에 포함.
   - 파일: `src/bun/tutor-service.ts`, `src/shared/` 새 shared command module.
   - 내용: 짧은 문장 heuristic은 보조로 낮추고, 명시적 진행 문구를 우선한다. "그 얘기로 넘어가기 전에..." 같은 문장은 질문/답변으로 남아야 한다.
   - 검증: 명시적 버튼/문구는 진행, 애매한 문장은 tutor answer path.
   - 리스크: 중간. 한국어 UX 문구 회귀 테스트가 필요하다.

## Phase 3: 체감 성능 개선

목표: 같은 턴에서 반복되는 JSON parse, DB full snapshot, 이미지 base64 전송을 줄인다.

1. `CourseArtifactService.getArtifacts` heavy cache
   - 수용: 우선순위 높음.
   - 파일: `src/bun/course-artifact-service.ts`, `src/bun/annotation-service.ts`.
   - 내용: `materialId + learning_materials.updated_at` 기준으로 manifest, plans, visuals, sourceIndex, persisted `source_chunks.json`, figures, figureIndex를 cache한다. annotations는 가볍게 매번 읽거나 save/delete 후 cache를 명시 무효화한다.
   - 함께 수정: 현재 source 파일 재파싱 대신 material 생성 시점의 `source_chunks.json`을 읽어 chunk id drift를 막는다.
   - 함께 수정: `chunkModuleMap`을 artifacts cache에 붙이거나 `TutorService`에서 materialId 기준 memoize한다.
   - 검증: source를 재임포트해도 기존 material session은 생성 시점 chunk ids로 안정적으로 동작해야 한다.
   - 리스크: 중간. annotation freshness와 material regeneration invalidation을 명확히 해야 한다.

2. `snapshot()` 다이어트
   - 수용: 우선순위 높음.
   - 파일: `src/bun/tutor-service.ts`.
   - 내용: ordinal 계산, cursor 검증, recent AI history가 전체 messages load를 반복하지 않게 `snapshotHeader`, `nextOrdinal`, `recentMessages(limit)`를 분리한다.
   - 검증: 100+ messages 세션에서 한 턴 처리 시 full message parse 횟수가 줄어야 한다.
   - 리스크: 중간. external response shape는 유지해야 한다.

3. sessions list count JOIN
   - 수용: Phase 3에 포함.
   - 파일: `src/bun/tutor-service.ts`.
   - 내용: session별 `COUNT(*)` N+1을 `LEFT JOIN ... GROUP BY`로 대체한다.
   - 검증: `SessionSummary.messageCount` 유지.
   - 리스크: 낮음.

4. Figure asset 전송 최적화
   - 수용: Phase 3에 포함.
   - 파일: `src/views/main/components/SourceFigureCard.tsx`, `src/bun/index.ts`.
   - 내용: `figure.assetUrl` file URL을 우선 사용하고 `onError`에서만 `figures.getAsset` RPC fallback을 호출한다. 프론트에 figureId별 dataUrl cache를 둔다.
   - 추가 검토: `figures.explain`은 vision provider로 보내기 전 이미지 크기 상한/리사이즈를 둔다.
   - 검증: source view를 열고 닫아도 같은 큰 이미지를 반복 base64 RPC로 전송하지 않아야 한다.
   - 리스크: 낮음.

5. Prefetch concurrency와 wait policy
   - 수용: Phase 3에 포함.
   - 파일: `src/bun/tutor-service.ts`.
   - 내용: `activePrefetches`를 `Map<sessionId, prefetchId>`로 바꾸고, `finally`는 자기 id가 현재 slot일 때만 지운다. 100초 고정 wait는 prefetch 시작 시각과 provider timeout을 기준으로 남은 시간만 기다리게 바꾼다.
   - 검증: stale 처리 중 같은 session에 중복 AI 호출이 2개 이상 뜨지 않아야 한다.
   - 리스크: 중간.

## Phase 4: 사용자에게 보이는 일관성 개선

1. Provider HTTP error 분류
   - 수용: 필요.
   - 파일: `src/bun/openai-compatible-client.ts`, `src/bun/ai-provider-client.ts`, `src/bun/tutor-service.ts`.
   - 내용: provider error에 `kind/status/provider/model`을 구조화한다. 401/403은 API key, 404는 model/base URL, 429는 quota/rate limit, 5xx/timeout은 retry 안내로 분리한다.
   - 리스크: 중간. 문자열 매칭을 줄이고 Error subclass 또는 plain structured error helper를 쓴다.

2. Theme 설정 단일화
   - 수용: 필요.
   - 파일: `src/views/main/App.tsx`, `src/views/main/components/SettingsModal.tsx`, `src/bun/settings-service.ts`.
   - 내용: `AppSettings.theme`을 실제 UI theme source of truth로 삼고 `system`은 `matchMedia('(prefers-color-scheme: dark)')`로 반영한다. topbar toggle도 settings 저장과 일관되게 동작해야 한다.
   - 리스크: 낮음.

3. SourceMark localStorage를 material annotations로 통합
   - 수용: 필요하지만 Phase 4.
   - 파일: `src/views/main/components/ImmersiveSourceView.tsx`, `src/bun/annotation-service.ts`, `src/bun/annotation-store.ts`.
   - 내용: highlight/note를 이미 존재하는 `material_annotations.kind IN ('note', 'highlight')` 경로로 저장한다. 기존 localStorage marks는 일회성 migration 후 제거한다.
   - 리스크: 중간. 사용자 기존 표시/노트 유실 없이 migration해야 한다.

4. Wikipedia lookup 언어 fallback
   - 수용: Phase 4.
   - 파일: `src/bun/annotation-service.ts`.
   - 내용: tutor language 또는 selected text script를 기준으로 `ko` lookup을 먼저 시도하고 실패하면 `en`으로 fallback한다.
   - 리스크: 낮음.

5. preppy `--json` stdout 순도
   - 수용: Phase 4 또는 Python pass.
   - 파일: `python/src/preppy/cli.py`, `src/bun/preppy-service.ts`.
   - 내용: JSON mode에서는 stdout에 JSON만 남기고 human-readable diagnostics는 stderr로 보낸다.
   - 검증: `preppy-service.ts` JSON.parse가 rich/error 출력에 오염되지 않아야 한다.
   - 리스크: 낮음.

## Phase 5: 유지보수성 개선

1. TS test harness 도입
   - 수용: Phase 1부터 시작하고 계속 확장.
   - 대상 테스트:
     - markdown chunk heading stack.
     - settings provider deep merge.
     - progression command classification.
     - cursor success-only commit.
     - prefetch fingerprint/stale concurrency.
     - artifact cache invalidation.
   - 명령: `bun test`, `bun run typecheck`.

2. shared constants 정리
   - 수용: 테스트가 생긴 뒤.
   - 파일: `src/shared/` 새 module, `src/bun/tutor-service.ts`, `src/views/main/App.tsx`, `src/bun/annotation-service.ts`.
   - 내용: `PROGRESSION_CHOICES`, `normalizeChoiceText`, `TERM_RENDERING_RULE` 중복을 제거한다.
   - 리스크: 낮음.

3. React RPC typed wrapper
   - 수용: Phase 5.
   - 파일: `src/views/main/App.tsx`, 필요 시 `src/views/main/rpc-client.ts`.
   - 내용: `request(method, params)`의 `unknown` casting을 `AppRPC` 기반 typed wrapper로 감싼다.
   - 리스크: 중간. 한 번에 전부 바꾸지 말고 main flow부터 교체한다.

4. Prompt version 관리
   - 수용: Phase 5.
   - 파일: `src/bun/tutor-service.ts`, `prompts/` 또는 `src/bun/prompts/`.
   - 내용: prefetch prompt version을 수동 문자열이 아니라 prompt content hash에서 파생한다.
   - 리스크: 낮음.

5. File logging
   - 수용: Phase 5.
   - 파일: `src/bun/logger.ts`, About/settings UI.
   - 내용: `dataPath("logs")`에 rotating log를 남기고, About에서 log folder 열기를 제공한다.
   - 리스크: 낮음.

## 지금은 보류할 항목

- `tutor-service.ts` 대규모 4분할: 방향은 맞지만 지금 하면 cursor/snapshot/prefetch 버그 수정과 섞여 회귀 위험이 커진다. Phase 2-3 이후 pure parser와 prompt builder부터 작게 추출한다.
- `react-window` 같은 채팅 virtualization dependency 추가: 긴 세션 렌더링 문제가 다시 측정되면 고려한다. 우선 snapshot 다이어트와 "이전 대화 접기"가 더 단순하다.
- Python bundle size pruning: Windows packaging baseline과 bundled runtime 검증을 먼저 끝낸다. 그 다음 실제 `.bundle` 구성과 크기를 측정하고 `uv sync --no-dev` 또는 dependency pruning을 적용한다. 현재 main dependency인 docling 자체가 무거울 수 있어, 측정 전에는 release packaging을 흔들지 않는다.
- `learner_signals`, `module_progress`, `autoAdvanceOnMastery` 삭제: 죽은 schema/settings인 것은 맞지만 삭제는 migration/UI churn이 있다. auto-advance를 실제 구현할지, UI에서 숨길지 제품 결정을 먼저 한다.

## 권장 구현 순서

1. Phase 1을 한 커밋으로 처리한다. 작은 회귀 테스트와 `bun run typecheck`를 필수로 통과시킨다.
2. Phase 1.5를 별도 커밋 또는 작은 커밋 묶음으로 처리한다. Windows build 목표가 있으므로 이 단계가 Phase 2 이후로 밀리면 안 된다.
3. Phase 2는 두 커밋으로 나눈다: sync/ordinal 정합성, cursor commit path 통합.
4. Phase 3은 artifacts cache와 snapshot diet를 먼저 하고, 이미지/prefetch 최적화는 별도 커밋으로 둔다.
5. Phase 4 이후는 사용자 체감 버그와 유지보수 개선을 작은 단위로 진행한다.

최소 release gate:

- `bun run typecheck`
- `bun test`
- `bun run smoke:python`
- `bun run test:python`는 Python/preppy 또는 packaging 경로를 건드린 경우 필수
- Windows release target 추가 후: Windows runner 또는 실제 Windows machine에서 build artifact, bundled Python, archive export, folder open smoke를 별도 통과시켜야 한다.
- 수동 smoke: 새 source import, material generate, start fresh, continue latest, "계속해줘" 반복, AI timeout 후 재시도, source view figure 표시
