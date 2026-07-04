# Tutor Progress Prefetching Plan

## 1. 결론

기술적으로 가능하다. 지금 구조에서도 `계속해줘` / `다음 대목으로` / `진도로 돌아가기`는 이미 명시적인 backend RPC로 분리되어 있고, tutor runtime도 `continue_chunk`, `next_chunk`, `return_to_progress`, `user_message` 이벤트를 구분한다. 따라서 사용자가 현재 tutor 응답을 읽는 동안 다음 on-track 진행 턴을 LLM에 미리 요청해 두고, 사용자가 실제로 진행을 누르면 cached turn을 즉시 커밋하는 구조를 만들 수 있다.

다만 핵심은 "세션에 미리 assistant message를 써두는 것"이 아니다. 그렇게 하면 사용자가 detour 질문을 했을 때 대화 순서가 오염된다. 올바른 구조는 다음과 같다.

- 미래 진행 턴을 `prefetch candidate`로 별도 저장한다.
- candidate는 세션의 현재 cursor와 message fingerprint에 묶는다.
- 사용자가 진행을 요청하면 candidate가 아직 유효한지 검증한다.
- 유효하면 그때 DB transaction으로 cursor update + assistant message insert를 한다.
- 유효하지 않거나 아직 준비되지 않았으면 기존 live generation path로 fallback한다.

이렇게 하면 LLM prefetch는 사용자 조작을 block하지 않고, detour 중에도 기존 progress cache를 보존할 수 있다.

## 2. 현재 코드에서 붙을 위치

현재 관련 흐름:

- UI:
  - `src/views/main/App.tsx`
  - `advanceLearning("paragraph" | "chunk" | "module")`
  - `returnToProgress()`
  - `sendAnswer(text)`
  - 요청 중에는 `busy`와 `tutorThinking`을 켜서 composer와 버튼을 막는다.
- RPC:
  - `src/shared/rpc-types.ts`
  - `sessions.advance`
  - `sessions.returnToProgress`
  - `tutor.sendTurn`
- backend:
  - `src/bun/tutor-service.ts`
  - `advance(sessionId, mode)`
  - `returnToProgress(sessionId)`
  - `sendTurn(sessionId, userText)`
  - `createTutorTurn(sessionId, payload)`가 LLM 호출, sanitizer, `learning_messages` insert까지 한 번에 수행한다.
- state:
  - `learning_sessions.current_chunk_id`
  - `learning_sessions.covered_chunk_ids_json`
  - `learning_messages.blocks_json`
  - `learning_messages.state_update_json`

prefetch를 안전하게 넣으려면 `createTutorTurn()`의 역할을 쪼개야 한다.

현재:

```text
decide cursor -> call LLM -> sanitize -> insert assistant message -> return output
```

목표:

```text
plan future cursor -> call LLM -> sanitize -> store candidate
later: validate candidate -> update cursor -> insert assistant message -> return output
```

## 3. Product Rule

### 기본 동작

1. assistant가 on-track tutor turn을 보여준다.
2. backend는 즉시 "다음 major-route turn"을 background에서 준비한다.
3. 사용자는 현재 응답을 읽고, 질문을 누르거나 직접 질문하거나, 계속 진행을 누를 수 있다.
4. 사용자가 `계속해줘`를 누르면:
   - ready candidate가 있으면 즉시 보여준다.
   - 아직 생성 중이면 기존처럼 live generation으로 기다리거나, 짧게 더 기다린 뒤 fallback한다.
5. 사용자가 detour 질문을 하면:
   - detour 답변은 live로 생성한다.
   - 기존 progress candidate는 cursor가 바뀌지 않았으면 유지한다.
6. 사용자가 `진도로 돌아가기`를 누르면:
   - cursor-compatible progress candidate를 꺼내 쓴다.
   - 필요하면 deterministic bridge block을 앞에 붙여 "원래 흐름으로 돌아오면..."처럼 자연스럽게 연결한다.

### 하지 말아야 할 것

- detour 질문 답변을 미리 만들려고 하지 않는다. 질문 내용은 예측할 수 없다.
- 두세 단계 이상 미리 만들지 않는다. 한 단계 ahead가 비용과 정확도의 균형점이다.
- prefetch 중이라는 이유로 composer, source view, selection lookup, settings, session browser를 막지 않는다.
- unconsumed prefetch를 archive export에 포함하지 않는다. export 대상은 실제 대화에 커밋된 `learning_messages`뿐이다.

## 4. Prefetch Candidate 종류

v1에서는 하나만 primary로 둔다.

```ts
type TutorPrefetchKind = "default_continue";
```

`default_continue`는 UI의 `계속해줘`와 typed progression intent가 쓰는 major route다. 현재 `advance("paragraph")`가 하는 판단을 그대로 따른다.

- 현재 chunk 설명이 충분하지 않으면 `continue_chunk`
- 충분하면 current chunk를 covered로 만들고 next chunk로 이동해 `next_chunk` 또는 `start_module`
- 마지막 chunk면 finish prompt

v2에서 선택적으로 늘릴 수 있다.

```ts
type TutorPrefetchKind =
  | "default_continue"
  | "next_chunk"
  | "next_module"
  | "return_to_progress";
```

하지만 처음부터 여러 종류를 만들면 LLM 비용과 stale candidate가 늘어난다. 우선 `default_continue`만 구현하고, detour return도 같은 candidate를 재사용하는 쪽이 낫다.

## 5. DB Schema

새 table:

```sql
CREATE TABLE IF NOT EXISTS tutor_prefetches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES learning_materials(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('default_continue')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'generating', 'ready', 'consumed', 'stale', 'failed', 'cancelled')),

  base_message_count INTEGER NOT NULL,
  base_last_message_id TEXT,
  base_current_chunk_id TEXT,
  base_covered_chunk_ids_json TEXT NOT NULL,
  base_session_fingerprint TEXT NOT NULL,

  target_event TEXT NOT NULL,
  target_module_id TEXT,
  target_chunk_id TEXT,
  cursor_after_json TEXT NOT NULL,

  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  settings_fingerprint TEXT NOT NULL,
  material_fingerprint TEXT NOT NULL,
  prompt_version TEXT NOT NULL,

  output_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tutor_prefetches_session_kind_status
  ON tutor_prefetches(session_id, kind, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tutor_prefetches_unique_ready_base
  ON tutor_prefetches(session_id, kind, base_session_fingerprint)
  WHERE status IN ('queued', 'generating', 'ready');
```

`output_json`에는 sanitized `TutorTurnOutput`을 저장한다. raw model response는 저장하지 않는다. 운영상 debugging이 필요하면 별도 diagnostics table에 compact redacted excerpt만 저장한다.

## 6. Fingerprint 규칙

candidate는 다음 값이 같을 때만 consume 가능하다.

- `session_id`
- `kind`
- `current_chunk_id`
- `covered_chunk_ids_json`
- material artifact fingerprint
- provider/model/settings fingerprint
- prompt version

message count는 detour 때문에 달라질 수 있다. 그러므로 message count만으로 invalidation하면 detour 후 cache를 못 쓴다. 대신 다음처럼 나눈다.

### Strict validity

일반 `계속해줘` consume:

- `base_message_count`가 현재 message count와 같거나
- 추가된 message들이 모두 detour turn이고 cursor가 그대로인 경우 허용한다.

### Route validity

`진도로 돌아가기` consume:

- cursor가 그대로면 허용한다.
- message count가 증가했더라도 추가 turn들이 `turnMode = digress` 또는 `conversationMode = detour`이면 허용한다.
- consume 시 `stateUpdate.conversationMode`를 `returning`으로 바꾸거나 bridge block을 prepend한다.

이렇게 해야 "detour 중에는 캐시를 버리지 않고, 돌아올 때 꺼내 쓰는" 요구가 충족된다.

## 7. Backend Refactor

### 7.1 Progress plan을 pure function으로 분리

추가할 내부 타입:

```ts
type PlannedProgressTurn = {
  kind: "default_continue";
  targetEvent: "continue_chunk" | "next_chunk" | "start_module" | "finish_prompt";
  moduleId: string;
  currentChunkId: string | null;
  targetChunkId: string | null;
  coveredChunkIdsAfter: string[];
  completedModuleIdsAfter: string[];
  cursorAfter: {
    currentModuleId: string | null;
    currentChunkId: string | null;
    coveredChunkIds: string[];
    completedModuleIds: string[];
  };
};
```

새 helper:

```ts
private planDefaultContinue(session: SessionSnapshot, artifacts: MaterialArtifacts): PlannedProgressTurn
```

이 helper는 현재 `advance(sessionId, "paragraph")` 안에 들어 있는 cursor 결정 로직을 그대로 옮긴다. DB write와 LLM call은 하지 않는다.

### 7.2 LLM generation을 "draft"로 분리

현재 `createTutorTurn()`은 message insert까지 한다. 다음처럼 분리한다.

```ts
private async generateTutorTurnDraft(
  session: SessionSnapshot,
  artifacts: MaterialArtifacts,
  plan: PlannedProgressTurn,
  options?: { returning?: boolean }
): Promise<TutorTurnOutput>
```

내부에서는 기존 `aiTutorOutput -> aiTutorTextRepairOutput -> sanitizeOutput` pipeline을 재사용한다. 단, `insertMessage()`와 `persistCursor()`는 호출하지 않는다.

### 7.3 Commit을 transaction으로 만든다

```ts
private commitTutorTurn(
  sessionId: string,
  plan: PlannedProgressTurn,
  output: TutorTurnOutput
): void
```

transaction 안에서:

1. 현재 session cursor를 다시 읽는다.
2. plan이 여전히 cursor-compatible인지 확인한다.
3. `learning_sessions` cursor를 `plan.cursorAfter`로 update한다.
4. `learning_messages`에 assistant turn을 현재 마지막 ordinal로 insert한다.
5. prefetch row를 `consumed`로 mark한다.

검증 실패 시 candidate를 `stale`로 mark하고 live path로 fallback한다.

## 8. Prefetch Service

`TutorService` 내부 또는 별도 `TutorPrefetchService`로 만든다. 별도 service가 낫다.

역할:

- ready candidate 조회
- background generation scheduling
- in-memory 중복 job 방지
- stale/expired cleanup
- consume transaction orchestration

예시 API:

```ts
class TutorPrefetchService {
  scheduleDefaultContinue(sessionId: string, reason: "assistant_turn" | "session_loaded"): void;
  tryConsumeDefaultContinue(sessionId: string, options?: { returning?: boolean }): Promise<TutorTurnOutput | null>;
  markSessionChanged(sessionId: string): void;
  listStatus(sessionId: string): TutorPrefetchStatus;
}
```

중요: `scheduleDefaultContinue()`는 절대 await하지 않는다.

```ts
void this.prefetch.scheduleDefaultContinue(sessionId, "assistant_turn");
```

LLM 요청은 network I/O라 Bun event loop를 CPU-bound로 막지 않는다. 다만 같은 provider에 동시 요청이 몰릴 수 있으므로 per-session 1 job, app-wide 2 job 정도의 limit을 둔다.

## 9. Scheduling 시점

prefetch를 시작할 조건:

- session status가 `active`
- source chunks가 아직 모두 covered되지 않음
- AI provider/model/API key가 설정되어 있음
- 현재 session cursor에 대해 ready/generating candidate가 없음
- 마지막 assistant turn이 정상적으로 커밋됨

시작할 위치:

- `start()`에서 첫 turn 생성 후
- `advance()`에서 live turn 생성 후
- `returnToProgress()`에서 live turn 생성 후
- `sendTurn()`에서 learner intent가 detour가 아닌 정상 teaching turn으로 끝난 경우
- `load()` 후에는 candidate가 없을 때만 낮은 priority로 시작

detour 답변 후에는 새 progress prefetch를 만들지 않아도 된다. cursor가 그대로라면 기존 candidate를 유지한다. 만약 기존 candidate가 없으면 detour 뒤에도 background로 만들 수 있지만, 우선순위는 낮게 둔다.

## 10. Consumption Flow

### `sessions.advance({ mode: "paragraph" })`

1. `tryConsumeDefaultContinue(sessionId)` 호출
2. ready + valid면 즉시 commit 후 `{ session, context, output }` 반환
3. 없으면 기존 live `advance()` 흐름 실행
4. live generation이 끝나면 다음 candidate schedule

### typed `계속해줘`

`sendTurn()`에서 `classifyIntent(userText)`가 `satisfied`이면 현재처럼 user message를 먼저 insert하지 말고, progression command로 route한다.

권장:

- exact progression phrase면 user message를 저장하지 않는다.
- 자연어로 "이제 넘어가자"처럼 쓴 경우는 user message 저장 여부를 product decision으로 둔다.
- 어쨌든 candidate consume path를 먼저 시도한다.

### `sessions.returnToProgress`

1. `tryConsumeDefaultContinue(sessionId, { returning: true })`
2. valid candidate가 있으면:
   - output 앞에 짧은 deterministic bridge block을 prepend한다.
   - `stateUpdate.conversationMode = "returning"`으로 보정한다.
   - commit한다.
3. 없으면 기존 live `returnToProgress()` 실행

bridge 예:

```ts
{
  type: "bridge",
  body: "좋아요. 방금 곁가지는 여기서 잠시 접고, 원래 흐름의 다음 대목으로 돌아가겠습니다."
}
```

## 11. UI Plan

UI는 prefetch 때문에 busy 상태가 되면 안 된다.

### 상태 표시

필수는 아니지만 있으면 좋다.

- 아주 작은 status pill:
  - `다음 응답 준비 중`
  - `다음 응답 준비됨`
- 이 표시는 버튼 disabled에 영향을 주지 않는다.
- 실패는 조용히 무시한다. 사용자가 진행을 누르면 live generation으로 가면 된다.

### RPC / message 추가

선택:

```ts
"sessions.prefetchStatus": {
  params: { sessionId: string };
  response: TutorPrefetchStatus;
}
```

또는 webview message:

```ts
"tutor.prefetchStarted": { sessionId: string; kind: "default_continue" }
"tutor.prefetchReady": { sessionId: string; kind: "default_continue" }
"tutor.prefetchStale": { sessionId: string; kind: "default_continue" }
```

v1은 UI 표시 없이 backend-only로 시작해도 된다. 사용자가 체감하는 가치는 `계속해줘`가 빠르게 열리는 것이다.

## 12. Non-blocking 보장

반드시 지킬 구현 규칙:

- renderer에서 prefetch RPC를 직접 기다리지 않는다.
- `busy` / `tutorThinking`은 learner가 명시적으로 요청한 turn에만 켠다.
- backend scheduler는 `void promise.catch(...)` 형태로 시작하고 실패를 status/log로만 남긴다.
- app-wide concurrency limit을 둔다.
- provider timeout은 기존 tutor timeout보다 짧게 둔다. 예: live 120s라면 prefetch 60-90s.
- candidate 생성이 늦어도 user action은 live path로 진행한다.

## 13. Invalidation Rules

candidate를 stale 처리하는 경우:

- session cursor가 바뀜
- covered chunk set이 바뀜
- selected provider/model/tutor language가 바뀜
- material artifact가 regenerate됨
- prompt version이 바뀜
- session이 completed/archived 됨
- expires_at 지남

candidate를 유지해도 되는 경우:

- 사용자가 detour question을 보냄
- detour assistant answer가 추가됨
- annotation/source lookup을 함
- source view를 열거나 selection lookup을 함
- settings modal을 열었지만 AI routing을 바꾸지 않음

## 14. Cost / Quality 정책

prefetch는 latency를 줄이는 대신 token 비용이 늘어난다. 그래서 v1 정책은 보수적으로 잡는다.

- 한 세션당 ready candidate 1개만 유지
- consumed되기 전에는 다음 prefetch를 만들지 않음
- 실패 시 즉시 재시도하지 않음
- 동일 fingerprint 실패는 일정 시간 backoff
- API key가 없거나 provider가 불안정하면 prefetch disable
- user setting으로 `다음 응답 미리 준비` toggle을 둘 수 있음

기본값은 on이 좋아 보인다. 이 앱의 핵심 UX가 "계속해줘로 조금씩 전진하는 guided learning"이기 때문이다. 단, provider 비용이 있는 사용자를 위해 Settings > Preferences에 toggle은 있어야 한다.

## 15. QA Checklist

- 새 session 시작 후 첫 assistant turn이 보이는 동안 prefetch job이 생성되는지 확인.
- prefetch 중에도 composer 입력, source view 전환, selection lookup이 되는지 확인.
- prefetch ready 상태에서 `계속해줘`를 눌렀을 때 spinner가 거의 보이지 않고 다음 turn이 표시되는지 확인.
- prefetch가 아직 generating일 때 `계속해줘`를 누르면 기존 live path로 정상 진행되는지 확인.
- detour 질문을 한 뒤 `진도로 돌아가기`를 누르면 기존 progress candidate가 consume되는지 확인.
- detour 중 추가된 messages 때문에 candidate가 잘못 stale 처리되지 않는지 확인.
- source cursor가 바뀐 뒤 오래된 candidate가 consume되지 않는지 확인.
- provider/model/tutorLanguage 변경 후 이전 candidate가 discard되는지 확인.
- material regenerate 후 이전 candidate가 discard되는지 확인.
- app restart 후 ready candidate를 사용할지, 또는 TTL 만료/stale 처리할지 확인.
- completed session에서는 prefetch가 생성되지 않는지 확인.
- archive export에 unconsumed candidate가 포함되지 않는지 확인.

## 16. Implementation Order

### Phase 1: Refactor without behavior change

1. `advance("paragraph")` cursor decision을 `planDefaultContinue()`로 분리한다.
2. `createTutorTurn()`에서 LLM draft generation과 DB commit을 분리한다.
3. 기존 tests/typecheck를 통과시켜 behavior가 유지되는지 확인한다.

### Phase 2: DB and service

1. `tutor_prefetches` table과 migration을 추가한다.
2. `TutorPrefetchService`를 추가한다.
3. ready/stale/failed 상태 전이를 구현한다.
4. per-session duplicate job guard를 구현한다.

### Phase 3: Background scheduling

1. assistant turn commit 후 `scheduleDefaultContinue()`를 fire-and-forget으로 호출한다.
2. provider settings fingerprint와 material fingerprint를 계산한다.
3. prefetch timeout/backoff를 둔다.

### Phase 4: Consumption

1. `sessions.advance(mode: "paragraph")` 앞에 candidate consume을 붙인다.
2. typed progression phrase도 consume path를 타게 한다.
3. `sessions.returnToProgress`에서 returning bridge 보정을 붙인다.
4. consume 실패 시 live generation fallback을 보장한다.

### Phase 5: UI polish

1. backend-only로 먼저 검증한다.
2. 필요하면 small status pill을 추가한다.
3. Settings에 `다음 응답 미리 준비` toggle을 추가한다.

### Phase 6: Tests / smoke

1. fake provider로 slow generation을 만들고 prefetch ready consume이 빠른지 측정한다.
2. detour 후 return consume 시나리오를 smoke test로 만든다.
3. stale candidate safety tests를 추가한다.

## 17. Main Risks

- `createTutorTurn()`이 현재 persistence까지 갖고 있어 refactor를 대충 하면 duplicate message나 cursor skip이 생길 수 있다.
- detour 후 cache reuse는 message history가 달라진 상태에서 generated output을 쓰는 것이다. 그래서 output은 "route lesson fragment"로 다루고, returning bridge는 deterministic하게 붙이는 편이 안전하다.
- provider 비용이 증가한다. 한 단계 ahead + toggle + backoff가 필요하다.
- 모델이 prefetch로 만든 답변이 실제 클릭 시점의 UX와 어긋날 수 있다. cursor fingerprint와 material/settings fingerprint 검증을 강하게 해야 한다.
- cache가 준비되지 않았을 때 UX가 더 나빠지면 안 된다. prefetch miss는 기존 behavior와 같아야 한다.

## 18. Product Decision

이 기능은 넣는 편이 맞다. 이 앱의 학습 방식은 user가 한 응답을 공부한 뒤 `계속해줘`로 조금씩 앞으로 가는 구조이고, major route는 source chunk cursor에 의해 거의 결정되어 있다. LLM latency를 사용자가 읽는 시간 뒤로 숨기는 것은 제품적으로 자연스럽다.

권장 v1 scope:

- one-step `default_continue`만 prefetch
- backend-only status로 먼저 구현
- ready candidate consume으로 `계속해줘`와 `진도로 돌아가기` latency를 줄임
- prefetch miss/stale/failure는 조용히 live path fallback

이 정도면 UX 이득이 크고, 세션 모델을 위험하게 흔들지 않는다.
