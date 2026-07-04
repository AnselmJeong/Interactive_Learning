# Learnie 코드 감사 보고서 (fable_suggestion)

작성: 2026-07-04 · 대상 버전: 0.4.5
검토 범위: `src/bun/**` 전체, `src/views/main/**` 주요 컴포넌트, `src/shared/**`, `scripts/**`, `python/src/preppy/**`(CLI·EPUB 엔진 중심으로 다소 가볍게).

각 항목에 **증상 → 재현 시나리오 → 해결 전략** 순으로 정리했습니다.

---

## 1. Critical — 크래시 또는 데이터 손실로 이어지는 버그

### 1.1 heading 레벨 건너뜀 시 `headingPath`에 `null`이 들어가 튜터 턴·원문 뷰가 깨짐

- 위치: [source-service.ts:271-279](src/bun/source-service.ts:271) (`normalizeMarkdownChunks`)

```ts
headings.length = heading[1]!.length - 1;   // ← 배열을 "늘릴" 수도 있음
headings.push(heading[2]!.trim());
```

- 증상: 문서가 `#` 없이 `##`로 시작하거나, `#` 다음에 바로 `###`이 오면(레벨 건너뜀) `headings.length = 2`가 배열을 sparse하게 **확장**하여 `[..., <empty>, "제목"]`이 됩니다. `[...headings]` 스프레드 시 empty slot이 `undefined`가 되고, JSON 저장 시 `null`로 직렬화되어 `source_chunks.json`에 영구히 남습니다.
- 파급 효과 (둘 다 실제 발생 가능):
  1. 백엔드: [tutor-service.ts:59](src/bun/tutor-service.ts:59) `originalTermCandidates`가 `for (const field of [...chunk.headingPath, ...]) field.matchAll(...)`을 호출 → `null.matchAll` TypeError → 재시도·텍스트 복구 경로 모두에서 같은 예외 → 해당 chunk에서 **튜터 응답 생성이 영구 실패**.
  2. 프론트엔드: [App.tsx:110](src/views/main/App.tsx:110) `cleanHeadingParts`의 `parts.map(part => part.replace(...))`가 `null.replace`로 크래시 → 원문(Source) 뷰 렌더링 자체가 깨짐.
- 해결 전략:
  - 스택을 sparse하게 만들지 않도록 수정: `headings.splice(Math.min(headings.length, level - 1))` 후 push, 또는 `while (headings.length > level - 1) headings.pop();` 방식.
  - 방어 코드도 함께: chunk 로드 시(`loadChunks`) `headingPath.filter((p): p is string => typeof p === "string")`로 기존 오염 데이터를 정화. (이미 저장된 `source_chunks.json`에는 `null`이 남아 있을 수 있으므로 로드 시 정화가 반드시 필요합니다.)
  - 회귀 테스트: `## 로 시작하는 문서`, `# → ###` 점프 문서에 대한 chunk 생성 단위 테스트 추가.

### 1.2 프로젝트 루트가 비어 보이면 DB를 통째로 cascade 삭제 (외장 볼륨 사용자에게 특히 위험)

- 위치: [project-bundle-sync.ts:109-118](src/bun/project-bundle-sync.ts:109) (`purgeDbProjectsMissingFromRoot`), 호출부 [project-bundle-sync.ts:376-379](src/bun/project-bundle-sync.ts:376)
- 증상: `syncProjectRootToDb`는 루트 폴더에서 `project.json`이 안 보이는 프로젝트를 `DELETE FROM projects` 합니다. FK가 전부 `ON DELETE CASCADE`이므로 소스·자료·세션·메시지·주석이 **한 번에 삭제**됩니다.
- 재현 시나리오: 프로젝트 루트를 외장 디스크(예: `/Volumes/...`)로 지정한 상태에서 (a) 볼륨이 아직 마운트되기 전에 앱을 실행하거나, (b) 사용자가 루트 폴더를 잠시 이름 변경/이동한 경우 → `mkdir(rootPath)`가 빈 디렉토리를 만들고 → 유효 프로젝트 0개로 판정 → 전체 purge. 파일이 돌아와도 복구는 다음 sync 때 파일 기반으로 재구성되지만, (b)처럼 파일까지 함께 사라진 경우엔 영구 손실입니다.
- 해결 전략:
  - purge 전 안전 장치: 루트에 프로젝트 디렉토리가 **하나도 없으면**(=마운트 안 됨/빈 폴더 의심) purge를 건너뛰고 경고만 남기기.
  - 하드 삭제 대신 `projects.archived_at` 또는 별도 `missing_at` 플래그로 소프트 삭제하고, N일 유예 후 정리.
  - 루트 경로가 `/Volumes/` 하위일 때는 볼륨 마운트 여부를 먼저 확인.

### 1.3 타이핑 진행 명령 실패 시 chunk가 조용히 건너뛰어짐 (커서 선행 이동 + 실패 롤백 누락)

- 위치: [tutor-service.ts:943-959](src/bun/tutor-service.ts:943) (`createTutorTurn`의 heuristic "satisfied" 경로), [tutor-service.ts:628-634](src/bun/tutor-service.ts:628) (`sendTurn` catch)
- 증상: 사용자가 "이어서 들려주세요" 같은 문장을 입력 → heuristic이 satisfied로 분류 → `persistCursor`로 **커서를 먼저 다음 chunk로 이동** → 재귀 `createTutorTurn`에서 AI 호출이 실패(타임아웃 등) → `sendTurn`의 catch는 사용자 메시지만 삭제하고 커서는 되돌리지 않음. 사용자가 같은 문장을 재전송하면 커서가 **또 한 칸 전진**하여 chunk 하나를 배우지 못한 채 건너뜁니다. `advance()`의 chunk/module 경로도 동일하게 커서 persist 후 AI를 호출합니다([tutor-service.ts:683-685](src/bun/tutor-service.ts:683)).
- 해결 전략: 프리페치 소비 경로가 이미 쓰는 패턴(`generatePlannedProgressTurn` → 성공 시 `commitPlannedTutorTurn`으로 커서+메시지를 한 트랜잭션 커밋)을 일반 진행 경로에도 적용. 즉 **"AI 턴 생성 성공 후에만 커서를 이동"**하도록 순서를 뒤집으면 됩니다. 이미 인프라(`planDefaultContinue`/`progressPlan`)가 있으므로 리팩토링 비용이 낮습니다.

### 1.4 `sessions.list` 호출마다 전체 프로젝트 루트를 디스크→DB 재동기화 (성능 병목 + 메시지 삭제/재삽입 위험)

- 위치: [tutor-service.ts:547-549](src/bun/tutor-service.ts:547) (`listSessions` → `syncProjectRootToDb`), [project-bundle-sync.ts:305-350](src/bun/project-bundle-sync.ts:305) (`importSessions`)
- 증상 1 (성능): UI는 매 턴 후 `refreshSessions`를 호출하고, 그때마다 루트의 **모든 프로젝트**의 manifest/소스(파일 해시 재계산!)/자료/주석/세션 JSON을 다시 읽습니다. `importSessions`는 `existing.updated_at > snapshot.updatedAt`일 때만 skip하므로, 평상시처럼 두 값이 **같으면** 세션의 모든 메시지를 `DELETE` 후 재삽입합니다. 세션이 길어질수록 매 턴이 눈에 띄게 느려집니다.
- 증상 2 (정합성): `insertMessage`는 `learning_sessions.updated_at`을 갱신하지 않으므로, 턴 생성 도중(사용자 메시지는 DB에 있으나 snapshot에는 아직 없는 창) 다른 경로에서 sync가 돌면 방금 넣은 사용자 메시지가 삭제됩니다. 현재 UI는 busy 플래그로 대부분 직렬화되어 있어 드물지만, 구조적으로 열려 있는 race입니다.
- 해결 전략:
  - sync 시점 축소: 앱 시작, 프로젝트 루트 변경, 프로젝트 열기 시에만 `syncProjectRootToDb` 실행. `listSessions`에서는 제거.
  - `importSessions`에서 `>=` 비교로 바꿔 timestamp가 같으면 skip (재삽입 자체를 없앰).
  - 메시지 insert 시 `learning_sessions.updated_at`도 bump하여 "DB가 더 최신" 상태를 보장.
  - `importSessions`의 delete+reinsert를 트랜잭션으로 감싸기 (중간 크래시 시 메시지 유실 방지).

### 1.5 'generating' 상태로 죽은 material이 영구히 재사용됨

- 위치: [course-artifact-service.ts:277-279](src/bun/course-artifact-service.ts:277) (`generate`의 dedupe)
- 증상: 자료 생성 도중 앱이 종료되면 `learning_materials.status = 'generating'` 행이 남습니다. 이후 같은 소스로 `materials.generate`를 호출하면 dedupe가 이 stuck 행을 그대로 반환하고, `getArtifacts`는 경로가 비어 있어 "Material artifacts are incomplete"를 영원히 던집니다. 사용자는 해당 소스로 다시는 학습을 시작할 수 없습니다.
- 해결 전략: (a) 앱 시작 시 `UPDATE learning_materials SET status='failed' WHERE status='generating'` 일괄 정리, (b) dedupe 시 'generating'이면서 `updated_at`이 오래된(예: 10분 이상) 행은 failed로 강등 후 새로 생성. 현재 생성은 결정론적(deterministic-mvp)이라 몇 초면 끝나므로 (a)만으로 충분합니다.

---

## 2. High — 기능 오동작·설정 관련 버그

### 2.2 `settings.update`의 얕은 병합 — 부분 `providers` 패치가 다른 provider 설정을 초기화할 수 있음

- 위치: [settings-service.ts:45](src/bun/settings-service.ts:45) (`{ ...current, ...patch }`)
- 증상: `patch.providers`가 일부 provider만 담고 있으면 `normalizeSettings`가 나머지 provider를 `DEFAULT_PROVIDERS`(선택 모델 공백)와 병합하여 **다른 provider의 선택 모델이 사라질 수 있습니다**. 현재 SettingsModal이 항상 전체 객체를 보내는지에 의존하는 취약한 계약입니다.
- 해결 전략: `providers`는 provider 단위 deep-merge(`{...current.providers[id], ...patch.providers?.[id]}`)로 처리.

### 2.3 프리페치 동시성: `markPrefetchesStale`가 실행 중인 작업의 슬롯을 지워 중복 AI 호출 유발

- 위치: [tutor-service.ts:1420-1426](src/bun/tutor-service.ts:1420), [tutor-service.ts:1397-1411](src/bun/tutor-service.ts:1397)
- 증상: `activePrefetches`는 sessionId 기준인데, stale 처리 시 즉시 `delete(sessionId)`하므로 이전 프리페치의 AI 호출이 아직 진행 중인 상태에서 새 프리페치가 시작될 수 있습니다(같은 세션에 동시 2개 호출 = 토큰 낭비). 게다가 이전 작업의 `finally`가 sessionId를 지워버려 **새 작업의 슬롯 표시까지 제거** → 3중 호출도 가능.
- 해결 전략: `activePrefetches`를 `Map<sessionId, prefetchId>`로 바꾸고, `finally`에서는 자기 prefetchId가 여전히 등록된 경우에만 삭제. stale 처리 시에는 슬롯을 지우지 않고 두었다가 작업 종료 시 정리.

### 2.4 세션이 없을 때 다른 세션의 프리페치 상태를 수신함

- 위치: [App.tsx:579-582](src/views/main/App.tsx:579)

```ts
setPrefetchStatus((current) => (session?.id && detail.sessionId !== session.id ? current : detail));
```

- 증상: `session`이 null이면 어떤 세션의 이벤트든 수용합니다. 백그라운드 프리페치가 끝난 다른 세션의 "ready" 상태가, 이후 새로 연 세션의 "계속해줘" 버튼에 잘못 표시될 수 있습니다.
- 해결 전략: `if (!session?.id || detail.sessionId !== session.id) return current;`

### 2.5 오류 분류가 부정확: HTTP 4xx(잘못된 API 키 등)도 "시간 초과 또는 연결 오류"로 안내됨

- 위치: [tutor-service.ts:501-514](src/bun/tutor-service.ts:501) (`isProviderConnectionError`가 `"ai provider http"` 전부 매치)
- 증상: 401/403/429 같은 명백한 설정·쿼터 문제도 "잠시 후 다시 시도해 주세요"로 표시되어 사용자가 원인을 알 수 없습니다.
- 해결 전략: HTTP 상태 코드를 에러 객체에 구조화(`{ kind: "http", status }`)해서 4xx는 "API 키/모델 설정 확인", 5xx·타임아웃은 "재시도" 메시지로 분기.

### 2.6 macOS 전용 하드코딩

- [project-service.ts:332](src/bun/project-service.ts:332) `/usr/bin/zip`, [index.ts:151](src/bun/index.ts:151) `spawn("open")`, [paths.ts:15](src/bun/paths.ts:15) `Library/Application Support` 폴백, preppy 런타임 경로의 `bin/python3.12`.
- 현재 macOS 전용 배포라면 문제없지만, `electrobun.config`가 다른 플랫폼을 겨냥하게 되는 순간 전부 깨집니다. 최소한 한 곳(`platform-utils.ts`)으로 모아 두는 것을 권장합니다.

---

## 3. Medium — 엣지 케이스·일관성 문제

1. **`ordinal` 무결성 보장이 없음** — `learning_messages`에 `UNIQUE(session_id, ordinal)`이 없고, ordinal은 "현재 메시지 수"로 계산합니다. race가 생기면 중복 ordinal이 조용히 들어가고 정렬이 불안정해집니다. 유니크 인덱스를 추가하고 `MAX(ordinal)+1`로 계산하세요. ([project-db.ts:88-104](src/bun/project-db.ts:88))
2. **`importSources`가 `updated_at`을 `created_at`으로 덮어씀** — sync가 돌 때마다 소스 수정 시각 정보가 소실됩니다. ([project-bundle-sync.ts:213-215](src/bun/project-bundle-sync.ts:213))
3. **원문 하이라이트/노트가 localStorage에만 저장됨** — 정식 annotation은 프로젝트 번들로 동기화되는데, `SourceMark`(표시/노트)는 `localStorage`에만 있어 기기 이동·재설치 시 소실됩니다. annotation-store에 `note`/`highlight` kind가 이미 정의되어 있으므로 통합을 권장합니다. ([ImmersiveSourceView.tsx:102-120](src/views/main/components/ImmersiveSourceView.tsx:102))
4. **material 생성 시점의 chunk id와 현재 소스 chunk의 드리프트** — `getArtifacts`는 coursePlan(생성 시점 스냅샷)과 sourceChunks(현재 파일에서 재파싱)를 섞어 씁니다. 소스 재임포트나 청킹 로직 변경 시 module의 `sourceChunkIds`가 어떤 chunk와도 매칭되지 않아 `ownerModuleOf`가 조용히 `modules[0]`로 폴백합니다. 생성 시 저장해 둔 `source_chunks.json`(이미 쓰고 있음!)을 읽도록 바꾸면 드리프트가 사라집니다. ([course-artifact-service.ts:442](src/bun/course-artifact-service.ts:442))
5. **`theme` 설정 이원화** — `AppSettings.theme`("system" 포함)이 존재하지만 UI는 localStorage 키만 사용하고 시스템 테마 추적이 없습니다. 한쪽으로 통일하세요. ([App.tsx:48-52](src/views/main/App.tsx:48))
6. **죽은 스키마/설정** — `learner_signals`, `module_progress` 테이블과 `autoAdvanceOnMastery` 설정은 어디에서도 쓰이지 않습니다. 제거하거나 구현 계획을 명시하세요.
7. **`PROGRESSION_CHOICES`·`normalizeChoiceText`·`TERM_RENDERING_RULE` 중복 정의** — tutor-service.ts와 App.tsx(및 annotation-service.ts)에 동일 상수가 복제되어 있어 한쪽만 수정되면 진행 명령 인식이 어긋납니다. `src/shared/`로 이동하세요.
8. **타이핑 진행 heuristic의 오분류 여지** — 40자 이하·물음표 없음·"이어서/넘어가" 포함이면 무조건 진행 처리됩니다([tutor-service.ts:607](src/bun/tutor-service.ts:607)). "그 얘기로 넘어가기 전에 하나만요" 같은 문장이 진행으로 오인될 수 있습니다. 명시적 명령 문구 목록 매칭을 우선하고 heuristic은 보조로만 쓰는 것을 권장합니다.
9. **Wikipedia lookup이 영어 위키 고정** — 한국어 학습 앱인데 `WIKIPEDIA_LANG = "en"` 고정이라 한국어 용어 선택 시 검색 실패가 잦을 것입니다. ko → en 폴백 체인을 권장합니다. ([annotation-service.ts:66](src/bun/annotation-service.ts:66))
10. **preppy `--json` 모드의 stdout 오염 가능성** — 오류 메시지·rich 출력이 stdout으로 나갑니다(비-TTY라 스피너는 억제되지만 `console.print`는 나감). `preppy-service.ts`가 stdout 전체를 JSON.parse하므로, 사람이 읽는 메시지는 stderr로 보내는 편이 안전합니다. ([cli.py:98](python/src/preppy/cli.py:98), [preppy-service.ts:102](src/bun/preppy-service.ts:102))

---

## 4. 성능·효율 개선 (앱 반응성에 직접 효과)

### 4.1 `getArtifacts` 결과 캐싱 — 가장 효과 큰 단일 개선

- 현재 매 턴/스냅샷/프리페치/annotation마다 manifest·conceptMap·coursePlan·lecturePlan·visuals·sourceIndex JSON을 디스크에서 재파싱하고, **모든 소스의 chunk 파일을 다시 읽습니다**. 긴 책이면 턴마다 수 MB 파싱입니다.
- 전략: `CourseArtifactService`에 `Map<materialId, {artifacts, loadedAt}>` 캐시를 두고 `learning_materials.updated_at` 변경 시 무효화. 프리페치와 본 턴이 같은 artifacts를 공유하게 되어 CPU·GC 부담이 크게 줄어듭니다.

### 4.2 `snapshot()` 남용 제거

- `sendTurn` 한 번에 `snapshot()`(전 메시지 로드+blocks JSON 파싱)이 4~6회 호출됩니다(ordinal 계산, 재귀 턴, 커밋 검증 등). 세션이 길어질수록 턴 지연이 선형 증가합니다.
- 전략: (a) ordinal은 `SELECT COALESCE(MAX(ordinal)+1, 0)`으로, (b) 커서 검증은 messages 없이 세션 행만 읽는 `snapshotHeader()`로, (c) AI 히스토리는 `LIMIT 8` 쿼리로 마지막 8개만 로드.

### 4.3 `listSessions`의 N+1 카운트 쿼리

- 세션마다 `COUNT(*)`를 따로 실행합니다. `LEFT JOIN ... GROUP BY` 한 방으로 대체. ([tutor-service.ts:788-790](src/bun/tutor-service.ts:788)) — 1.4의 sync 제거와 함께 하면 세션 목록 갱신이 사실상 무료가 됩니다.

### 4.4 그림 자산 전송 최적화

- `SourceFigureCard`가 마운트될 때마다 RPC로 파일을 읽어 base64 데이터 URL을 통째로 받아옵니다(이미 `figure.assetUrl` file:// URL을 초기값으로 쓰면서도 무조건 재요청). 근거 보기를 열 때마다 큰 이미지가 반복 전송됩니다. ([SourceFigureCard.tsx:30-50](src/views/main/components/SourceFigureCard.tsx:30))
- 전략: file:// 로드를 기본으로 하고 `onError`시에만 RPC 폴백, 또는 프론트에서 `Map<figureId, dataUrl>` 캐시. 백엔드도 `explainFigure`에서 이미지 크기 상한(리사이즈)을 두면 vision 비용이 줄어듭니다.

### 4.5 `chunkModuleMap` 반복 생성

- `ownerModuleOf` 호출마다 O(chunks×modules) 맵을 새로 만듭니다. 4.1의 artifacts 캐시에 함께 붙여 memoize하세요. ([tutor-service.ts:1134-1148](src/bun/tutor-service.ts:1134))

### 4.6 Python 번들 크기

- `prepare-python-runtime.ts`가 `.venv`의 site-packages를 통째로 복사합니다. venv에 torch, pytest, faker 등이 보이는데 `uv sync --frozen`은 dev 그룹까지 설치하므로 배포 번들에 테스트 의존성까지 들어갈 가능성이 큽니다.
- 전략: `uv sync --frozen --no-dev`로 분리하고, docling이 실제 요구하는 최소 구성(CPU-only torch 등)을 확인해 프루닝. 앱 용량과 첫 실행 시간이 크게 줄어듭니다.

### 4.7 프리페치 대기 정책

- `PREFETCH_CONSUME_WAIT_MS = 100초`: 프리페치가 느릴 때 "계속해줘" 클릭이 최악의 경우 100초 대기 후 다시 120초짜리 새 요청을 시작합니다(합계 3분 이상). 대기 상한을 provider 타임아웃과 연동(예: 생성 시작 시각 기준 잔여 시간만 대기)하거나, 일정 시간 초과 시 기존 작업을 stale 처리하고 즉시 새 요청을 시작하는 편이 체감 지연이 낮습니다.

### 4.8 긴 세션의 채팅 렌더링

- `ChatLog`는 memo되어 있지만 메시지 배열 자체가 매 턴 새로 생성되어 전체 리스트가 리렌더됩니다. KaTeX 파싱이 비싼 편이므로, 세션이 100+ 메시지로 길어지면 가상화(react-window)나 "이전 대화 접기"를 고려하세요.

---

## 5. 아키텍처·유지보수 제안

1. **진행(cursor) 변경을 단일 커밋 경로로 통일** — 현재 커서 이동이 `persistCursor`(선행), `commitPlannedTutorTurn`(트랜잭션), `importSessions`(sync) 세 갈래로 흩어져 있습니다. 1.3에서 제안한 대로 "plan → generate → commit" 파이프라인 하나로 통일하면 chunk 건너뜀·중복 ordinal 같은 상태 버그 클래스가 사라집니다.
2. **RPC 타입 안전성 회복** — `App.tsx`의 `request(method, params)`는 `unknown` 캐스팅 투성이입니다. `AppRPC` 타입이 이미 있으므로 `request<"sessions.advance">(...)` 형태의 typed wrapper를 만들면 rename/스키마 변경 시 컴파일러가 잡아줍니다.
3. **거대 파일 분리** — `tutor-service.ts`(2,286줄)는 (a) 텍스트 파싱/블록 정제 유틸, (b) 프리페치 서브시스템, (c) 프롬프트 빌더, (d) 세션 상태 머신의 4개 모듈로 나누면 테스트 가능성이 크게 올라갑니다. 특히 `parseNumberedFlowBlocks`/`parseInlineBulletBlocks`류 파서는 순수 함수라 단위 테스트 대상 1순위인데 현재 테스트가 전혀 없습니다.
4. **TypeScript 테스트 부재** — Python엔 pytest가 있지만 TS는 0개입니다. `bun test`로 최소한 (a) 청킹(`normalizeMarkdownChunks` — 1.1 회귀 포함), (b) 블록 sanitize, (c) intent 분류, (d) 프리페치 fingerprint 검증만 커버해도 이 보고서의 버그 절반은 CI에서 걸립니다.
5. **프롬프트 버전 관리** — 시스템 프롬프트를 코드 문자열 리터럴로 인라인하지 말고 `prompts/` 리소스로 분리 + `PREFETCH_PROMPT_VERSION`을 프롬프트 해시에서 파생시키면, 프롬프트를 수정하고 버전 문자열 갱신을 잊어 stale 프리페치가 소비되는 사고를 막을 수 있습니다.
6. **로그 전략** — 백엔드 오류가 `console.*`로만 남습니다. 데스크톱 앱 특성상 사용자가 로그를 못 보므로, `dataPath("logs/")`에 rotating 파일 로그를 남기고 About 창에 "로그 폴더 열기"를 추가하면 지원이 쉬워집니다.

---

## 6. 우선순위 요약

| 순위 | 항목 | 성격 | 예상 작업량 |
|---|---|---|---|
| 1 | 1.1 headingPath null 오염 | 크래시 | 소 (수 줄 + 로드 시 정화) |
| 2 | 1.4 listSessions 전체 sync 제거 | 성능+정합성 | 소~중 |
| 3 | 1.3 커서 선행 이동 롤백 | 학습 내용 누락 | 중 |
| 4 | 1.2 루트 purge 안전장치 | 데이터 손실 | 소 |
| 5 | 1.5 stuck 'generating' 정리 | 기능 잠김 | 소 |
| 6 | 2.1/2.2 설정 병합·Ollama URL | 기능 오동작 | 소 |
| 7 | 4.1/4.2 artifacts 캐시·snapshot 다이어트 | 체감 성능 | 중 |
| 8 | 2.3 프리페치 동시성 | 비용 낭비 | 소 |
| 9 | 4.4 그림 자산 캐싱 | 체감 성능 | 소 |
| 10 | 5.4 TS 테스트 도입 | 재발 방지 | 중 |

*Python 파이프라인(preppy)은 CLI와 EPUB 엔진 중심으로 검토했으며 구조적으로 견고했습니다(테스트 존재). PDF(docling) 엔진과 split/plan 모듈은 이번 검토에서 깊이 다루지 못했으므로 별도 패스를 권장합니다.*
