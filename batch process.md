# Batch Learning Messages Plan

## 1. Corrected Goal

용어를 정리한다. 이번 기능은 `learning_materials` artifact를 미리 만드는 기능이 아니다. 이미 material은 source import 이후 `course_plan.json`, `source_chunks.json`, `lecture_plan.json` 같은 artifact로 만들어진다.

사용자가 원하는 것은 실제 학습 중 화면에 나타나는 tutor 답변, 즉 `learning_messages`의 assistant message들을 한꺼번에 끝까지 미리 생성하는 버튼이다.

중요한 UX 원칙:

- message 생성은 미리 끝까지 한다.
- learner에게 보여주는 것은 지금처럼 단계적으로 한다.
- 즉, "미리 다 보여주기"가 아니라 "미리 만들어두고, `계속해줘` 때 기다림 없이 다음 message를 reveal하기"다.

목표:

- 사용자가 source/material을 선택한다.
- `전체 메시지 미리 만들기` 버튼을 누른다.
- 앱이 현재 major route 기준으로 끝까지 assistant `learning_messages`를 미리 생성한다.
- 사용자가 이후 `계속해줘`를 누르면 LLM을 기다리지 않고 준비된 다음 message가 즉시 나타난다.
- 중간에 질문을 하면 기존 interactive flow는 유지된다.

## 2. Product Rule

핵심은 "미래 메시지를 생성하되, session 진행 상태를 미래로 밀어버리지 않는 것"이다.

따라서 v1은 다음 정책으로 간다.

- batch job은 실제 `learning_messages` row를 만든다.
- 단, 새 row는 처음부터 learner에게 보이는 committed message가 아니라 `prepared` message로 저장한다.
- `계속해줘`를 누를 때 다음 `prepared` assistant message를 `visible`로 reveal하고, 그때 session cursor를 해당 message의 planned cursor로 업데이트한다.
- 모든 prepared message를 한 화면에 즉시 보여주지 않는다. 그렇게 하면 transcript가 너무 길어지고, learner가 중간 질문을 넣을 공간이 사라진다.
- source 전체를 읽기 전용으로 한 번에 훑는 "전체 보기"는 나중에 별도 view로 만들 수 있지만, 기본 chat flow는 단계적으로 reveal한다.

이렇게 하면 "모든 learning message를 미리 만든다"는 요구를 만족하면서도 기존 interactive semantics를 보존할 수 있다.

## 3. Why Not Just Insert Visible Messages

`learning_messages`에 전체 assistant messages를 visible 상태로 바로 넣고 `learning_sessions.current_chunk_id`도 끝으로 업데이트하면 구현은 단순해 보인다. 하지만 실제 제품 동작은 망가진다.

- progress bar가 즉시 100%가 된다.
- 사용자가 아직 읽지 않은 내용을 이미 완료한 것으로 취급한다.
- 중간 질문을 넣으면 질문이 transcript 끝에 붙어서 맥락상 어색해진다.
- `계속해줘`, `다음 대목으로`, `진도로 돌아가기` 버튼의 의미가 사라진다.
- session export/history가 "사용자가 실제로 진행한 기록"과 "미리 만들어진 미래"를 구분할 수 없어진다.

그래서 actual table은 `learning_messages`를 쓰되, delivery state를 추가해야 한다.

## 4. Data Model

`learning_messages`에 prepared/visible 상태와 계획 cursor를 저장한다.

추가 column 후보:

```sql
ALTER TABLE learning_messages
  ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'visible'
  CHECK (delivery_state IN ('visible', 'prepared', 'discarded'));

ALTER TABLE learning_messages
  ADD COLUMN batch_run_id TEXT;

ALTER TABLE learning_messages
  ADD COLUMN cursor_before_json TEXT;

ALTER TABLE learning_messages
  ADD COLUMN cursor_after_json TEXT;
```

새 batch run table:

```sql
CREATE TABLE IF NOT EXISTS learning_message_batch_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES learning_materials(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'generating', 'ready', 'partial', 'failed', 'cancelled', 'stale')),
  route_kind TEXT NOT NULL CHECK (route_kind IN ('default_continue')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  settings_fingerprint TEXT NOT NULL,
  material_fingerprint TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  total_steps INTEGER NOT NULL DEFAULT 0,
  completed_steps INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_learning_message_batch_runs_session_status
  ON learning_message_batch_runs(session_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_learning_messages_prepared_batch
  ON learning_messages(session_id, delivery_state, ordinal ASC);
```

왜 run이 material이 아니라 session에 붙는가:

- `learning_messages`는 session transcript의 일부다.
- prepared message ordinal은 해당 session의 visible/detour history와 함께 관리해야 한다.
- 사용자가 active session 중간에서 batch를 시작하면 "남은 메시지"만 만들 수 있어야 한다.
- session이 삭제되면 prepared messages도 같이 삭제되어야 한다.

## 5. Session Snapshot Changes

현재 snapshot/context reconstruct path는 `learning_messages`를 모두 읽는 전제일 가능성이 높다. 이제 learner-facing snapshot은 기본적으로 `delivery_state = 'visible'`만 포함해야 한다.

필요한 query 정책:

- normal `snapshot(sessionId)`: visible messages만 반환.
- internal planning snapshot: visible messages + 필요 시 prepared metadata를 별도로 조회.
- export/history: 기본은 visible messages만 포함.
- developer diagnostics: prepared count/status를 별도 표시.

prepared messages를 normal `messages` 배열에 섞으면 UI가 미래 메시지를 이미 읽은 것처럼 보여주므로 금지한다.

## 6. Cursor Semantics

batch generation 중에는 session cursor를 움직이지 않는다.

각 prepared assistant message row에는 다음 metadata가 들어간다.

```ts
type PreparedMessageCursor = {
  cursorBefore: {
    currentModuleId: string | null;
    currentChunkId: string | null;
    coveredChunkIds: string[];
    completedModuleIds: string[];
  };
  cursorAfter: {
    currentModuleId: string | null;
    currentChunkId: string | null;
    coveredChunkIds: string[];
    completedModuleIds: string[];
  };
  targetEvent: "start_module" | "continue_chunk" | "next_chunk" | "finish_prompt";
};
```

`계속해줘` reveal 조건:

- session is active
- next prepared message exists
- current session cursor exactly matches `cursorBefore`
- provider/model/settings/material/prompt fingerprint still matches latest batch run

reveal transaction:

1. current session row를 다시 읽는다.
2. next prepared message의 `cursor_before_json`과 현재 cursor를 비교한다.
3. message를 `delivery_state = 'visible'`로 update한다.
4. session cursor를 `cursor_after_json`으로 update한다.
5. batch status/progress를 필요하면 update한다.
6. snapshot/context를 반환한다.

이 transaction이 없으면 "미리 만든 메시지는 보이는데 progress는 그대로" 또는 반대로 "progress는 끝났는데 메시지는 안 보임" 같은 상태 불일치가 생긴다.

## 7. Backend Generation Flow

새 service 후보:

```ts
class LearningMessageBatchService {
  start(sessionId: string): Promise<LearningMessageBatchStatus>;
  cancel(sessionId: string): Promise<LearningMessageBatchStatus>;
  status(sessionId: string): Promise<LearningMessageBatchStatus>;
  revealNext(sessionId: string, options?: { returning?: boolean }): Promise<TutorTurnOutput | null>;
}
```

기본 흐름:

1. active session을 준비한다.
   - material만 선택된 상태에서 버튼을 누르면 먼저 new session을 만든다.
   - 이미 active session이 있으면 그 session의 현재 cursor부터 남은 route를 만든다.
2. 기존 stale prepared messages를 discard한다.
3. batch run row를 `generating`으로 만든다.
4. 현재 visible session snapshot을 기준으로 virtual session을 만든다.
5. `planDefaultContinue(virtualSession, artifacts)`를 반복한다.
6. `generatePlannedProgressTurn(virtualSession, artifacts, plan)`으로 assistant output을 생성한다.
7. output을 `learning_messages`에 `delivery_state = 'prepared'`로 insert한다.
8. virtual session cursor는 `plan.cursorAfter`로 이동한다.
9. `finish_prompt`까지 만들면 run을 `ready`로 mark한다.

중요: `generatePlannedProgressTurn`과 prompt/sanitizer는 live `계속해줘` path와 공유해야 한다. batch 전용 prompt를 따로 만들면 같은 source에서 품질과 톤이 갈라진다.

## 8. Start Session Interaction

material만 선택되어 있고 session이 없을 때 `전체 메시지 미리 만들기`를 누르면:

1. 새 active session row를 만든다.
2. 첫 `start_module` assistant message는 visible로 즉시 만들지 선택해야 한다.

권장 v1:

- 첫 message는 visible로 생성한다.
- 나머지 message는 prepared로 생성한다.

이유:

- 사용자가 batch를 시작한 뒤 바로 읽을 첫 화면이 있어야 한다.
- 첫 assistant message까지 prepared로만 두면 chat 화면이 비어 있고, 별도 "첫 메시지 보기" 액션이 필요해진다.
- 첫 message 생성은 anyway 필요하므로 UX상 바로 보여주는 편이 자연스럽다.

이미 active session이 있을 때는:

- 현재 visible cursor 이후의 남은 route만 prepared로 만든다.
- 기존 visible history는 건드리지 않는다.
- 기존 prepared messages가 있으면 같은 fingerprint/cursor인지 확인하고, 다르면 discard 후 재생성한다.

## 9. Continue Button Flow

`sessions.advance({ mode: "paragraph" })` 우선순위:

1. 현재 one-step `tutor_prefetches` ready candidate consume.
2. 없으면 next prepared `learning_messages` reveal.
3. 없으면 live generation.
4. live generation이 끝나면 기존 one-step prefetch는 계속 schedule한다.

왜 one-step prefetch가 먼저인가:

- one-step prefetch는 현재 session 맥락에서 가장 최근에 만들어진 next turn이다.
- batch prepared messages는 더 오래된 virtual route일 수 있다.
- 둘 다 cursor-compatible이면 더 최신 candidate를 쓰는 게 낫다.

`sessions.returnToProgress`:

- next prepared message가 cursor-compatible하면 deterministic bridge block을 prepend하거나 별도 visible bridge message를 먼저 넣는다.
- 그 뒤 prepared assistant message를 reveal한다.
- detour 후 cursor가 그대로라면 prepared messages는 계속 유효하다.

`다음 대목으로` / `다음 모듈로`:

- prepared messages는 `default_continue` route 기준이다.
- explicit skip 버튼을 누르면 남아 있는 prepared messages는 `discarded` 또는 `stale`로 처리한다.
- 이후 다시 `전체 메시지 미리 만들기`를 누르면 새 cursor부터 생성한다.

## 10. Detour and Ordinal Handling

prepared messages가 이미 `learning_messages`에 들어가 있으면 ordinal 문제가 생긴다.

예:

1. visible assistant ordinal 3까지 읽음.
2. prepared assistant ordinal 4-20이 이미 존재.
3. 사용자가 질문을 입력함.
4. user message와 detour assistant는 ordinal 4-5로 들어가야 자연스럽다.

따라서 detour insert 전에 prepared messages ordinal을 뒤로 밀어야 한다.

필요 helper:

```ts
shiftPreparedMessages(sessionId, fromOrdinal, by)
```

정책:

- user/free-form turn을 insert하기 전, current visible max ordinal 이후의 prepared rows를 `+2` shift한다.
- user message와 live detour assistant를 visible로 insert한다.
- prepared rows는 그 뒤 ordinal로 남긴다.
- cursor가 unchanged면 이후 `진도로 돌아가기` 또는 `계속해줘`에서 reveal 가능하다.

이 처리를 하지 않으면 DB unique ordinal index와 transcript order가 깨진다.

## 11. UI Plan

버튼 위치:

- `course-strip-actions` 안에서 `Start` 근처.
- active material이 있으면 표시한다.
- session이 없으면 버튼이 session을 만들고 첫 message를 보여준 뒤 나머지를 prepared로 만든다.
- session이 있으면 현재 session의 남은 messages를 prepared로 만든다.

상태 label:

- idle: `전체 메시지 미리 만들기`
- generating: `메시지 생성 중 7/32`
- partial: `일부 메시지 준비됨 7/32`
- ready: `전체 메시지 준비됨`
- failed: `메시지 생성 실패`
- cancelled: `생성 중지됨`

controls:

- generating 중에는 같은 버튼을 `중지`로 바꾼다.
- ready 상태에서는 `다시 만들기`가 필요하지만, v1은 confirmation dialog를 둔다.
- 버튼 때문에 source view/chat/settings/session browser를 막지 않는다.

visual behavior:

- prepared message count를 progress bar 옆에 작게 표시할 수 있다.
- chat log에는 visible messages만 나온다.
- `계속해줘` 버튼은 prepared next가 있으면 spinner 없이 즉시 reveal한다.

## 12. RPC/API

새 shared type:

```ts
type LearningMessageBatchStatus = {
  sessionId: string | null;
  materialId: string;
  runId: string | null;
  status: "idle" | "queued" | "generating" | "partial" | "ready" | "failed" | "cancelled" | "stale";
  preparedCount: number;
  visiblePreparedRemaining: number;
  completedSteps: number;
  totalSteps: number;
  updatedAt: number | null;
  error?: string | null;
};
```

새 RPC:

```ts
"sessions.batchMessagesStart": {
  params: { materialId: string; sessionId?: string; force?: boolean };
  response: { session: SessionSnapshot; context: TutorContext; batch: LearningMessageBatchStatus };
};

"sessions.batchMessagesCancel": {
  params: { sessionId: string };
  response: LearningMessageBatchStatus;
};

"sessions.batchMessagesStatus": {
  params: { materialId: string; sessionId?: string };
  response: LearningMessageBatchStatus;
};
```

webview push:

```ts
"sessions.batchMessagesStatus": LearningMessageBatchStatus;
```

## 13. Cancellation and Recovery

Cancellation:

- active generation loop은 cancellation token을 확인한다.
- provider call을 abort할 수 있으면 abort한다.
- 이미 insert된 prepared messages는 남길지 버릴지 결정해야 한다.

권장 v1:

- cancel 시 이미 만들어진 prepared messages는 유지하고 run을 `partial`로 둔다.
- 버튼 label은 `일부 메시지 준비됨`으로 둔다.
- 사용자는 prepared prefix를 즉시 읽을 수 있다.

Crash recovery:

- 앱 시작 시 `generating` run은 `partial`로 복구한다.
- prepared messages는 그대로 둔다.
- next run 시작 시 stale/fingerprint mismatch prepared rows를 discard한다.

## 14. Settings and Cost

이 기능은 비용이 클 수 있으므로 자동 실행하면 안 된다.

v1 정책:

- global auto-batch setting은 만들지 않는다.
- 사용자가 명시적으로 버튼을 누른 경우에만 실행한다.
- 기존 `Prepare next response` toggle은 one-step prefetch용으로 유지한다.
- provider/model/API key가 없으면 버튼은 disabled 또는 tooltip으로 이유를 표시한다.

나중에 추가할 수 있는 설정:

- max batch messages per run
- max token budget per batch
- batch generation during idle only
- include/exclude finish prompt

하지만 v1에서는 knobs를 늘리지 않는다.

## 15. Implementation Phases

### Phase 1: Schema and snapshot filtering

- `learning_messages.delivery_state`, `batch_run_id`, `cursor_before_json`, `cursor_after_json` migration 추가.
- normal snapshot/context가 visible messages만 반환하도록 수정.
- prepared rows가 있어도 UI에 보이지 않는지 테스트.

### Phase 2: Batch status and button

- `LearningMessageBatchStatus` type 추가.
- batch run table 추가.
- `sessions.batchMessagesStatus/start/cancel` RPC skeleton 추가.
- course strip에 `전체 메시지 미리 만들기` button 추가.
- 실제 generation 없이 status lifecycle 테스트.

### Phase 3: Shared generation path

- `TutorService`의 progress planner/draft generator를 batch service에서 재사용 가능하게 정리.
- live `계속해줘`, one-step prefetch, return-to-progress tests가 그대로 통과해야 한다.
- 이 phase에서는 learner-visible behavior를 바꾸지 않는다.

### Phase 4: Prepared message generation

- active session 현재 cursor부터 virtual route를 끝까지 돈다.
- assistant output을 `delivery_state = 'prepared'`로 insert한다.
- 첫 session 생성 케이스에서는 첫 assistant message를 visible로 만들고 나머지를 prepared로 만든다.
- partial/failure/cancel recovery 구현.

### Phase 5: Reveal path

- `sessions.advance("paragraph")`에서 one-step prefetch miss 후 prepared message reveal.
- reveal transaction에서 message state와 session cursor를 함께 update.
- `sessions.returnToProgress` bridge/reveal 처리.
- explicit skip actions가 prepared future를 discard하도록 처리.

### Phase 6: Detour ordinal safety

- free-form user turn 전에 prepared future ordinals shift.
- user/detour assistant visible insert 후 prepared route 유지.
- cursor mismatch/fingerprint mismatch 시 prepared rows discard.

### Phase 7: QA and polish

- long source에서 generation progress 확인.
- cancel 후 partial prepared messages reveal 확인.
- restart 후 partial recovery 확인.
- detour 후 `진도로 돌아가기` 확인.
- session export가 visible messages만 포함하는지 확인.

## 16. Tests

Unit tests:

- prepared messages are hidden from normal snapshot.
- reveal next prepared message updates `delivery_state` and session cursor in one transaction.
- cursor mismatch refuses reveal.
- model/settings/material fingerprint mismatch refuses reveal.
- explicit skip discards prepared future.
- detour insert shifts prepared ordinals without duplicate ordinal failure.
- partial run remains consumable.

Integration tests:

- material selected, no session: batch start creates session, first visible message, remaining prepared messages.
- active session: batch start creates prepared messages from current cursor only.
- repeated `계속해줘`: prepared messages reveal without provider wait.
- detour question inserted between prepared messages keeps transcript order correct.
- restart after interrupted batch marks run partial and preserves prepared rows.

Manual smoke:

- 새 source import -> material generate -> `전체 메시지 미리 만들기`.
- 생성 중에도 Source/Chat 전환과 Settings 사용 가능.
- 생성 중 중지.
- 준비 완료 후 `계속해줘` 반복.
- 중간 질문 후 `진도로 돌아가기`.
- `다음 모듈로` 누른 뒤 old prepared rows가 더 이상 reveal되지 않는지 확인.

## 17. Risks

- Schema complexity: `learning_messages`가 visible transcript와 prepared future를 같이 담게 되므로 snapshot query discipline이 중요하다.
- Ordinal bugs: detour insertion 시 prepared rows를 shift하지 않으면 transcript order가 깨진다.
- Cost: 긴 source는 많은 LLM calls를 한 번에 발생시킨다.
- Stale output: settings/model/source artifacts가 바뀌면 prepared messages를 폐기해야 한다.
- UI surprise: 모든 메시지를 이미 만들었지만 한꺼번에 보이지 않는다는 점은 status로 충분히 표현해야 한다.

## 18. Recommended v1

가장 안전한 v1은 다음이다.

- explicit `전체 메시지 미리 만들기` button.
- session-bound prepared `learning_messages`.
- 첫 message는 visible, 이후는 prepared.
- `계속해줘`는 prepared next message를 즉시 reveal.
- one-step prefetch가 있으면 그것을 우선 사용.
- detour 시 prepared ordinals shift.
- snapshot/export는 visible messages만 사용.
- partial batch도 prefix reveal 가능.
- failure/stale/miss는 기존 live generation으로 fallback.

이 설계가 사용자가 말한 "모든 learning message를 한꺼번에 미리 만들어두는 버튼"에 가장 직접적으로 맞고, 동시에 기존 interactive learning의 대화 가능성을 잃지 않는다.
