# Learning Levels Implementation Plan

## Goal

새 프로젝트를 만들 때 학습자가 원하는 학습 강도/깊이를 선택하게 한다.

- `medium`을 기본값으로 둔다. 사용자가 아무것도 선택하지 않으면 현재 튜터 prompt의 기본 동작이 유지되어야 한다.
- `hard`는 진지한 학술적 학습, 전문 용어, 논쟁, 엄밀성을 더 허용한다.
- `casual`은 부담 없는 교양 독서, 큰 그림, 비유, 짧고 가벼운 흐름을 선호한다.
- 이 값은 "책 자체의 난이도"가 아니라 "사용자가 이 프로젝트에서 들이고 싶은 목표 관여도"다. 어려운 책도 casual하게 훑을 수 있고, 쉬운 책도 hard하게 파고들 수 있다.

## Non-Negotiable Invariants

레벨은 현재 tutor contract를 절대 덮어쓰면 안 된다.

- learner의 실제 질문에 답한다.
- 채점하지 않는다.
- 한 source chunk씩 진행한다.
- source를 primary anchor로 삼되, 필요하면 broader knowledge를 쓴다.
- JSON schema, block schema, language instruction, sourceRef/id enum은 유지한다.
- prepared learning messages, prefetch, live tutor turn은 같은 prompt policy를 공유한다.

즉, level은 깊이, register, 용어, pace, visual/block 선호만 조정한다.

## Product Shape

프로젝트 생성 모달에 `학습 강도` segmented control을 추가한다.

- `Casual - 즐기며 읽기`
  - 큰 그림, 쉬운 비유, 짧은 설명.
- `Medium - 균형 잡힌 학습`
  - 현재 기본값. 전문성은 살리되 일반 성인 학습자가 따라올 수 있게 설명.
- `Hard - 진지하게 공부하기`
  - 전문 용어, 이론적 긴장, 반론, 학술적 맥락까지 더 깊게.

권장 MVP:

- 새 프로젝트 생성 시에만 선택한다.
- 기존 프로젝트는 모두 `medium`으로 backfill한다.
- project edit UI는 이번 범위에서 제외한다. 나중에 추가할 경우 prepared messages/prefetch/session future를 stale 처리해야 한다.

## Data Model

### Shared Type

새 shared module을 둔다.

```ts
// src/shared/learning-levels.ts
export const LEARNING_LEVELS = ["casual", "medium", "hard"] as const;
export type LearningLevel = (typeof LEARNING_LEVELS)[number];

export function normalizeLearningLevel(value: unknown): LearningLevel {
  return value === "casual" || value === "hard" || value === "medium" ? value : "medium";
}
```

이 모듈에 UI label/description과 tutor prompt profile helper를 같이 둘지, prompt helper만 `src/bun`에 둘지는 구현 중 선택한다. 단, renderer와 bun 양쪽에서 type/labels가 필요하므로 type과 label metadata는 shared에 두는 편이 낫다.

### SQLite

`src/bun/project-db.ts`

- `projects` create table에 컬럼 추가:

```sql
learning_level TEXT NOT NULL DEFAULT 'medium'
  CHECK (learning_level IN ('casual', 'medium', 'hard'))
```

- 기존 DB migration:

```ts
if (!projectColumns.includes("learning_level")) {
  db.exec("ALTER TABLE projects ADD COLUMN learning_level TEXT NOT NULL DEFAULT 'medium';");
}
```

SQLite의 기존 `ALTER TABLE ADD COLUMN` 제약 호환성을 생각하면 migration에서는 CHECK 없이 추가하고, 읽기/쓰기 계층에서 normalize한다. 새 DB create table에는 CHECK를 넣어도 된다.

### Project Types

`src/shared/rpc-types.ts`

- `ProjectSummary`에 추가:

```ts
learningLevel: LearningLevel;
```

- `projects.create` params 확장:

```ts
"projects.create": {
  params: { title: string; description?: string; learningLevel?: LearningLevel };
  response: ProjectSummary;
}
```

### Project Service

`src/bun/project-service.ts`

- `ProjectRow`에 `learning_level`.
- `toProject(row)`에서 `normalizeLearningLevel(row.learning_level)`.
- `create(input)`에서 `normalizeLearningLevel(input.learningLevel)` 후 insert.
- `list/open/exportArchive/root sync`가 모두 이 값을 보존해야 한다.

### Project Bundle Manifest

`src/bun/project-bundle-sync.ts`

- `ProjectBundleManifest`에 `learningLevel?: LearningLevel`.
- `projectManifestFromSummary()`가 `learningLevel`을 기록.
- `importProject()`가 manifest의 `learningLevel`을 normalize해서 DB에 upsert.
- `recoverProjectManifestIfPossible()`는 `learningLevel: "medium"`을 쓴다.
- schema version은 `2`로 올리는 것이 깔끔하다. Import는 v1 manifest에서도 missing value를 `medium`으로 처리한다.

## UI Plan

`src/views/main/components/NewProjectModal.tsx`

- state 추가:

```ts
const [learningLevel, setLearningLevel] = useState<LearningLevel>("medium");
```

- `projects.create` 호출에 포함:

```ts
request("projects.create", { title, learningLevel })
```

- project가 이미 생성된 뒤에는 level control을 disabled 처리한다. 현재 modal은 project name confirm 시 backend project를 즉시 만들기 때문이다.
- control 위치는 프로젝트 이름 아래, source section 위.
- segmented control은 3개 옵션이 항상 보이게 한다. 추가 설정 knob는 만들지 않는다.

`src/views/main/styles/app.css`

- `.np-level-control`, `.np-level-option` 정도의 클래스 추가.
- 모바일에서도 세 옵션 텍스트가 찌그러지지 않도록 `grid-template-columns: repeat(3, minmax(0, 1fr))`와 짧은 label/description을 사용한다.

선택적으로 active project header나 dropdown에 작은 level badge를 붙일 수 있지만, MVP 필수는 아니다.

## Prompt Injection Plan

현재 learning messages 생성 경로:

- live tutor turn
- default continue prefetch
- batch prepared learning messages

모두 `TutorService.generatePlannedProgressTurn()` -> `generateTutorTurnDraft()` -> `aiTutorOutput()`의 같은 prompt를 공유한다. 따라서 이 한 경로에 level profile을 넣으면 세 경로가 같이 맞춰진다. JSON 실패 후 repair 경로인 `aiTutorTextRepairOutput()`에도 같은 profile을 넣어야 한다.

### Level Lookup

`TutorService`는 `SessionSnapshot.projectId`를 알고 있으므로 project id로 level을 조회한다.

권장 helper:

```ts
private projectLearningLevel(projectId: string): LearningLevel {
  const row = getDb()
    .query<{ learning_level: string | null }, [string]>("SELECT learning_level FROM projects WHERE id = ?")
    .get(projectId);
  return normalizeLearningLevel(row?.learning_level);
}
```

`aiTutorOutput()`와 `aiTutorTextRepairOutput()` 시작부에서:

```ts
const learningLevel = this.projectLearningLevel(session.projectId);
const levelInstruction = tutorLevelInstruction(learningLevel);
```

### Prompt Placement

System prompt 안에서 invariant와 term/language rule 뒤, format contract 앞에 넣는다.

```text
LEARNER LEVEL PROFILE
${levelInstruction}

This profile governs depth, register, vocabulary, pace, question style, and visual style ONLY.
It never overrides the invariants: answer the learner, do not grade, teach one source chunk at a time, stay grounded, and return the required JSON schema.
If this profile conflicts with a fixed style line, the profile wins on depth/length/register; the invariants win over everything.
```

`medium`은 현재 prompt를 보존하는 기본값이다. 따라서 medium profile은 과하게 새 방향을 주입하지 말고 "balanced default"로만 설명한다.

### Profiles

Hard:

```text
LEARNER LEVEL - HARD (rigorous; the learner wants to study this seriously)
- Assume a motivated, capable learner willing to do real cognitive work; assume undergraduate-level background when the field makes that useful.
- Use technical and original-language terms freely; define a term once, then use it without re-explaining every time.
- Preserve nuance, tension, and scholarly disagreement. Name positions, thinkers, and contested points when genuinely useful.
- Draw on secondary literature and adjacent theory when it illuminates the source; distinguish source-grounded claims from broader background.
- When precision and accessibility conflict, choose precision, then give a compact restatement if needed.
- Ask probing reflection questions: reconstruct an argument, weigh an objection, or identify a hidden premise.
- Prefer density to superficial brevity, but stay structured. Depth is not length for its own sake.
```

Medium:

```text
LEARNER LEVEL - MEDIUM (balanced; default)
- Assume an intelligent adult with no specialist background.
- Introduce technical terms, but gloss each in plain words on first mention; keep original terms visible when useful.
- Convey main nuances and one or two central debates without chasing every scholarly qualification.
- Use outside knowledge for intuition, examples, and context, then return to the source.
- Balance rigor and accessibility. When they conflict, give the accurate version and then a plain restatement.
- Ask reflective questions that invite connection and interpretation, never recall.
- Keep the current concise guided-lecture style: clear beats dense.
```

Casual:

```text
LEARNER LEVEL - CASUAL (relaxed; the learner is reading for pleasure)
- Assume a curious reader who wants the ideas, not the apparatus; assume no prior background.
- Minimize jargon. When a technical term is unavoidable, translate it into everyday language immediately and move on.
- Go for the big picture and memorable core. It is fine to simplify and drop fine distinctions; say so briefly when simplification matters.
- Lean on vivid analogy, story, and real-world hooks; treat the source as a light anchor, not a syllabus.
- Favor warmth and momentum over precision, without inventing facts or dodging questions.
- Keep questions light, low-stakes, and easy to answer.
- Keep turns short and breezy. Prefer plain-sentence, bullets, bridge, and reflection blocks over dense tables unless a table genuinely clarifies.
```

## Cache And Prepared Message Correctness

Prompt changes must invalidate generated future text.

`src/bun/tutor-service.ts`

- Bump:

```ts
const PREFETCH_PROMPT_VERSION = "tutor-default-continue-v3-learning-level";
const MESSAGE_BATCH_PROMPT_VERSION = PREFETCH_PROMPT_VERSION;
```

- Include project learning level in `learningRuntimeFingerprint()` or in a new prompt/runtime fingerprint object:

```ts
const learningLevel = this.projectLearningLevelForArtifactsOrSession(...);
const settingsFingerprint = stableHash({
  provider,
  model,
  baseUrl: settings.providers[provider].baseUrl,
  tutorLanguage: settings.tutorLanguage,
  learningLevel,
});
```

Because current `learningRuntimeFingerprint(artifacts, ...)` does not receive a session/project id, implementation needs a small signature change. Prefer:

```ts
private async learningRuntimeFingerprint(session: SessionSnapshot, artifacts: MaterialArtifacts, options: ...)
```

Then update callers:

- `prefetchRuntimeFingerprint(session, artifacts)`
- `batchRuntimeFingerprint(session, artifacts)`
- `batchRevealFingerprint(session, artifacts)`

Batch runs already start from a session, so this is feasible. This prevents a `medium` prepared future from being consumed after a project becomes `hard` in a future edit flow.

MVP has no edit flow, but this fingerprint still matters because the prompt version changes and because future project-level edits should not require cache architecture changes.

## Material Generation Scope

Do not fork deterministic material artifacts by learning level in MVP.

Reason:

- Current `CourseArtifactService` creates neutral deterministic artifacts (`course_plan`, `lecture_plan`, `presentation_plan`) from chunks, not level-specific AI prose.
- The requested behavior is prompt injection for tutor messages, not separate curricula.
- Keeping material generation neutral avoids duplicating material for the same source set.

If later material generation becomes AI-driven and level-specific, add `learningLevel` to the material generation key or material manifest and regenerate course/lecture plans per level.

## Implementation Phases

### Phase 1 - Shared Type And Persistence

- Add `src/shared/learning-levels.ts`.
- Add `learningLevel` to `ProjectSummary`.
- Extend `projects.create` RPC params.
- Add `projects.learning_level` create-table column and migration.
- Update `ProjectService` row mapping, create/list/open/delete/export paths.
- Update project bundle manifest write/import/recovery.

Expected tests:

- Default project creation returns `learningLevel: "medium"`.
- Explicit `hard`/`casual` is persisted and returned by list/open.
- Unknown/missing DB or manifest values normalize to `medium`.

### Phase 2 - New Project UI

- Add segmented level control to `NewProjectModal`.
- Send selected level to `projects.create`.
- Disable control after project creation.
- Add focused CSS for dense, non-card UI.

Expected checks:

- Default selected option is `Medium`.
- Create without touching control sends/stores medium.
- Hard/Casual selection survives modal creation and appears in returned `ProjectSummary`.

### Phase 3 - Tutor Prompt Profile

- Add `tutorLevelInstruction(level)` helper.
- Read project level in `TutorService`.
- Inject profile into both structured JSON and text repair prompts.
- Keep medium close to existing behavior.
- Do not change `buildFinishPromptTurn()` in MVP.

Expected tests:

- `tutorLevelInstruction("hard")` includes rigor/technical/nuance rules and the invariant guard.
- `tutorLevelInstruction("casual")` includes big-picture/jargon-light/short-breezy rules and the invariant guard.
- `medium` is the fallback for invalid values.

### Phase 4 - Runtime Fingerprints

- Bump prompt version.
- Include learning level in runtime fingerprint.
- Thread session/project id through prefetch/batch runtime fingerprint helpers.
- Ensure `existingPreparedTurn()` and prefetch consumption still reject stale rows through existing prompt/fingerprint checks.

Expected tests:

- Fingerprint changes between `medium` and `hard`.
- Prepared/batch rows generated under old prompt version are not consumed as current.

### Phase 5 - Validation

Run:

```bash
bun run typecheck
bun test
```

Manual smoke:

1. Create project with default level.
2. Import a source and generate material.
3. Start a session; confirm tutor still behaves like current medium.
4. Create a second project with Hard; same source should produce more rigorous tutor wording without breaking JSON blocks.
5. Create a third project with Casual; same source should produce lighter explanations without dodging direct questions.
6. Trigger prepared messages/prefetch; confirm no stale medium text appears in hard/casual projects.

## Acceptance Criteria

- Existing projects and imported v1 project bundles behave as `medium`.
- New project creation visibly supports Casual/Medium/Hard.
- The selected level is persisted in SQLite and project bundle `project.json`.
- The selected level reaches all tutor generation paths: live, prefetch, batch prepared messages, and repair.
- Level does not change schema validity, source grounding, chunk progression, or no-grading behavior.
- Medium remains recognizably the current default behavior.
