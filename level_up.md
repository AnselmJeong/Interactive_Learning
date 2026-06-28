# Level Up Plan: 시험관이 아니라 원문을 대신 읽혀 주는 강의자

## 0. 진단

현재 문제는 Claude/GPT가 아니어서 생긴 문제만은 아니다. 더 근본적으로는 제품 목적이 잘못 잡혀 있다. 지금 화면의 튜터는 "원문을 읽은 사용자가 내용을 제대로 이해했는지 확인하는 시험관"처럼 행동한다. 사용자가 조금 빗나간 답을 하면 원문에 더 붙으라고 말하고, 같은 질문을 다시 던지며, 통과할 때까지 정답에 가깝게 고쳐 말하게 만든다.

하지만 이 앱의 목적은 독해 시험이 아니다.

**목적은 사용자가 원문을 직접 읽지 않아도, 원문을 읽은 만큼의 학습 효과를 거두게 하는 것이다.**

따라서 튜터는 사용자의 지식을 검문하는 사람이 아니라, 원문을 대신 읽고, 구조화하고, 중요한 대목을 보여 주고, 흥미로운 질문으로 이해를 열어 주는 강의자여야 한다. 질문은 평가 도구가 아니라 주의를 깨우는 장치다. 오답은 실패가 아니라 아직 읽지 않은 독자가 자연스럽게 가질 수 있는 출발점이다.

스크린샷에서 보이는 잘못된 패턴:

- 사용자가 원문을 이미 읽었다고 가정한다.
- "원문을 바탕으로 말해 보라"는 요구가 반복된다.
- 사용자의 답을 수업 재료로 확장하지 않고, 원문 근접성만 채점한다.
- 오답이 나오면 더 잘 설명하기보다 다시 맞혀 보라고 한다.
- 선택지가 학습 경로가 아니라 시험 답안 후보처럼 보인다.

이 방향이면 아무리 시각 자료와 bullet을 추가해도 여전히 "예쁜 퀴즈 앱"에 머문다.

핵심 병목은 세 가지다.

1. **산출물 스키마가 너무 얇다.** 현재 런타임 계약은 사실상 `message`, `diagram`, `choices`, `progress` 중심이다. 그래서 모델이 표, 비교 카드, bullet, 짧은 원문 인용, 사고 실험, 오개념 퀴즈, diagram sequence를 넣고 싶어도 공식적으로 넣을 자리가 없다.
2. **컴파일러가 교수 재료를 저작하지 않는다.** `src/bun/course-artifact-service.ts`의 MVP 생성은 chunk 첫 문장과 heading을 바탕으로 concept/module을 만든다. 이것은 “수업 골격”은 만들지만, “읽고 싶어지는 장면”이나 “아하 포인트”를 만들지는 못한다.
3. **도해가 런타임 옆 패널에 붙는 보조물로 머문다.** Claude 예시인 `example/timaeus-course.jsx`는 손으로 만든 diagram registry가 풍부했고, 튜터 발화 중간에 도해가 자연스럽게 끼어들었다. 현재 앱은 `VisualRenderer`가 단순 flow/contrast/grid/formula 정도만 지원하고, 대부분 모듈당 하나의 정적인 시각 보조물이다.
4. **상태 기계가 mastery/checkpoint 중심이다.** `checkpoint_passed`, `masterySignals`, `misconceptionSignals`, `advanceModule` 같은 언어가 런타임을 시험 흐름으로 밀어 넣는다. 이 구조에서는 모델이 자연스럽게 교사보다 채점자가 된다.

따라서 모델을 바꾸기보다 먼저 **Lesson IR을 "정답 확인용 수업 계획"에서 "원문 대체 학습 경험"으로 확장**해야 한다.

## 1. 제품 목적 재정의

새 제품 원칙:

```text
The learner has not read the source.
The system's job is to make them feel as if a good teacher read it with them.
```

좋은 세션은 사용자가 원문을 읽은 뒤 시험을 보는 느낌이 아니라, 훌륭한 강의를 듣고 나서 원문을 이해하게 된 느낌이어야 한다.

### 기존 모드: 독해 확인형

```text
질문 -> 사용자 답변 -> 정오 판단 -> 원문에 더 붙이라고 요구 -> 재질문
```

이 모드는 다음 경우에만 적합하다.

- 시험 대비
- 이미 읽은 텍스트의 comprehension check
- 플래시카드식 복습

현재 앱의 기본 목표에는 맞지 않는다.

### 목표 모드: 안내 강의형

```text
흥미로운 문제 제기
-> 원문 핵심을 대신 읽어 줌
-> 구조/맥락/용어를 설명
-> 표/도해/예시로 압축
-> 사용자가 자기 생각을 얹게 함
-> 답변을 재료로 삼아 다음 대목으로 연결
```

여기서 질문은 "맞혀 보라"가 아니라 "이제 당신 생각으로 이 구조를 만져 보라"에 가깝다.

## 2. 좋은 출력의 기준

좋은 출력은 단순히 더 길거나 화려한 설명이 아니다. 사용자가 한 턴을 읽었을 때 다음 중 하나가 있어야 한다.

- "이상하네, 왜 그렇지?"라는 긴장
- 원문을 대신 읽은 효과를 주는 짧은 핵심 발췌/의역
- 개념 사이의 관계를 한눈에 보여주는 표나 도해
- 배경을 몰라도 따라갈 수 있게 해 주는 맥락
- 스스로 연결해 보고 싶게 만드는 작은 사고 실험
- "정답 후보"가 아니라 학습 경로로 작동하는 선택지

이를 위해 한 module은 다음 리듬을 가져야 한다.

```text
hook -> guided reading -> explanation -> visual/table -> reflection -> synthesis -> bridge
```

현재는 `question -> answer check -> correction -> same question`에 치우쳐 있고, 이 때문에 모델이 시험관처럼 보인다.

## 3. Lesson IR 확장: test turn이 아니라 lecture blocks

기존 turn output을 유지하되, `message`를 legacy fallback으로 두고 새 필드 `blocks`를 추가한다.

```jsonc
{
  "blocks": [
    {
      "type": "hook",
      "body": "철학적으로는 별로 중요하지 않은 책이 왜 천 년을 지배했을까요?"
    },
    {
      "type": "source_quote",
      "quote": "철학으로서는 중요하지 않지만, 역사적 영향력이 막대했다.",
      "source_ref": "chunk-001-influence"
    },
    {
      "type": "guided_reading",
      "body": "러셀의 출발점은 평가가 아니라 역설입니다. 대단한 철학적 저작은 아닌데, 중세에는 플라톤을 대표하는 창구가 되었다는 것이죠."
    },
    {
      "type": "bullets",
      "title": "영향력을 만든 세 가지 조건",
      "items": [
        "중세 서방에 알려진 거의 유일한 플라톤 텍스트였다.",
        "창조, 시간, 질서, 수학을 한 장면에 묶었다.",
        "기독교 사유가 빌려 쓰기 좋은 우주론적 어휘를 제공했다."
      ]
    },
    {
      "type": "reflection",
      "body": "이제 질문은 '이 책이 옳았나?'가 아니라 '왜 이 우주론이 오래 쓰이기 좋았나?'로 바뀝니다."
    }
  ],
  "diagram": "visual-influence-paradox",
  "choices": ["이제 창조론 쪽으로 이어서 설명해 주세요.", "왜 기독교가 빌려 쓰기 좋았는지 궁금해요.", "이 역설을 표로 정리해 주세요."],
  "source_refs": ["chunk-001-influence"],
  "state_update": {}
}
```

지원할 block type은 MVP에서 과하게 늘리지 말고 아래 정도로 시작한다.

| Type | 용도 | 렌더링 |
| --- | --- | --- |
| `hook` | 긴장/역설/놀라움으로 열기 | 큰 첫 문장, accent line |
| `guided_reading` | 원문 핵심을 대신 읽어 주기 | quote + paraphrase |
| `paragraph` | 일반 설명 | MarkdownContent |
| `bullets` | 2-5개 핵심 정리 | compact list |
| `compare_table` | 개념 대조 | 2-4열 table |
| `source_quote` | 짧은 근거 제시 | source chip + quote |
| `reflection` | 사용자의 생각을 열기 | open prompt |
| `misconception` | 읽지 않은 사람이 자연스럽게 가질 오해 설명 | gentle correction card |
| `bridge` | 다음 module 연결 | muted transition |

이 변경의 핵심은 GLM이 반드시 미려한 산문을 쓰지 않아도, **구조 자체가 다양한 화면 리듬을 만든다**는 점이다.

## 4. 컴파일 단계에 "원문 대체 강의 저작" 패스를 추가

기존 `concept_map -> course_plan -> tutor_policy` 사이에 `lecture_plan.json`을 추가한다. 이름도 `engagement_plan`보다 `lecture_plan`이 낫다. 목표가 흥미 장식이 아니라 원문을 대신 가르치는 것이기 때문이다.

```jsonc
{
  "module_id": "module-04-time",
  "intrigue": {
    "tension": "영원은 아주 긴 시간이 아니라 시간 바깥의 '있다'라는 역설",
    "why_reader_should_care": "시간을 측정 도구가 아니라 존재론적 모사품으로 보게 만든다",
    "surprise_line": "플라톤에게 시계는 시간을 재는 장치가 아니라 영원을 흉내 내는 우주의 구조에 가깝다."
  },
  "guided_reading": {
    "source_spark": "신은 '영원의 움직이는 이미지'를 만들었고, 이것이 시간이다.",
    "plain_paraphrase": "피조 세계는 영원을 그대로 가질 수 없으니, 운동과 수를 통해 영원을 흉내 내는 방식으로 시간 속에 존재한다.",
    "context_before": "플라톤은 세계를 영원한 원형의 복사본으로 본다.",
    "context_after": "그래서 시간과 하늘, 수와 철학의 관계가 이어진다."
  },
  "teaching_moves": [
    {
      "type": "guided_reflection",
      "prompt": "영원을 '아주 긴 시간'으로 생각하면 왜 플라톤의 말이 이상해지는지 살펴본다."
    },
    {
      "type": "contrast",
      "prompt": "영원과 '아주 오래 지속됨'은 어떻게 다른가?"
    },
    {
      "type": "rephrase",
      "prompt": "'영원의 움직이는 이미지'를 초등학생에게 설명하듯 한 문장으로 바꿔 보라."
    }
  ],
  "recommended_blocks": ["hook", "guided_reading", "compare_table", "diagram", "reflection"],
  "visual_opportunities": [
    {
      "kind": "contrast",
      "id": "visual-time-eternity",
      "placement": "after_first_explanation"
    }
  ]
}
```

이 패스는 강한 모델 또는 더 느린 다중 패스로 돌려도 된다. 런타임 비용이 아니라 발행 전 비용이기 때문이다.

### Engagement Plan 생성 지침

각 module마다 반드시 아래를 만들게 한다.

- **tension**: 독자가 궁금해할 역설/충돌
- **stakes**: 이걸 이해하면 이후 무엇이 보이는가
- **source spark**: 25단어 이하의 원문 근거 또는 paraphrase
- **guided reading**: 원문을 읽지 않은 사람에게 핵심 문장을 대신 풀어 주는 3-5문장
- **best analogy**: 단 하나의 비유. 없으면 null
- **interaction move**: prediction / compare / classify / rank / rephrase / personal connection 중 하나
- **visual opportunity**: table, diagram, timeline, map 중 최소 하나를 검토
- **likely confusion**: 처음 듣는 사람이 자연스럽게 헷갈릴 지점
- **teacher repair**: 오답 지적이 아니라 설명을 다시 조직하는 방법

이렇게 하면 모델이 매번 "설명하고 질문하기"만 반복하지 않는다.

## 5. Visual IR을 Claude 예시 수준으로 끌어올리기

`example/timaeus-course.jsx`의 장점은 모델이 SVG를 자유롭게 생성했다는 점이 아니라, 실제로는 **도해 컴포넌트가 수업 내용과 강하게 결합되어 있었다**는 점이다. 범용 앱에서는 arbitrary JSX를 만들면 안 되므로, Visual IR을 더 풍부하게 한다.

현재 VisualSpec:

```ts
flow | formula | contrast | layers | grid
```

추가할 VisualSpec:

```ts
timeline
axis
cycle
concept_map
process
matrix
annotated_table
geometry
quote_map
```

예시:

```jsonc
{
  "id": "visual-time-eternity",
  "type": "axis",
  "title": "영원은 긴 시간이 아니다",
  "left": { "label": "시간", "caption": "있었다 / 있을 것이다" },
  "right": { "label": "영원", "caption": "있다" },
  "markers": [
    { "label": "오래 지속됨", "position": 0.35 },
    { "label": "변화 없는 현재성", "position": 0.92 }
  ]
}
```

```jsonc
{
  "id": "visual-solids",
  "type": "geometry",
  "title": "두 삼각형에서 정다면체로",
  "shapes": [
    { "kind": "right_triangle", "label": "45-45-90" },
    { "kind": "right_triangle", "label": "30-60-90" },
    { "kind": "solid_set", "items": ["정사면체", "정육면체", "정팔면체", "정이십면체", "정십이면체"] }
  ],
  "caption": "플라톤에게 물질의 더 깊은 원소는 흙/물/불/공기가 아니라 수학적 형상이다."
}
```

중요한 규칙:

- 모델은 SVG/React 코드를 쓰지 않는다.
- 모델은 VisualSpec JSON만 쓴다.
- 렌더러가 deterministic SVG/HTML로 그린다.
- Tier 3 custom SVG는 캐시된 에셋으로만 허용한다.

이 방식이면 Claude 예시의 생동감을 어느 정도 되살리면서도 안전한 앱 구조를 유지할 수 있다.

## 6. 표와 bullet은 "허용"이 아니라 "계획"되어야 한다

모델에게 "적절히 bullet/table을 써라"라고만 하면 약한 모델은 잘 못 한다. 컴파일러가 module별로 어떤 표현 형식이 맞는지 먼저 정해야 한다.

표가 필요한 경우:

- 두 개념을 비교할 때: 영원 vs 시간, 무에서 창조 vs 재배열
- 여러 입장을 구분할 때: 러셀이 진지하게 보는 것 vs 장식으로 보는 것
- 개념/근거/오해를 한눈에 보여줄 때

bullet이 필요한 경우:

- 3단계 이하의 논리 전개
- "왜 중요한가" 목록
- 오해 교정 목록
- 세션 말미 recap

diagram이 필요한 경우:

- 관계, 순서, 대칭, 원인, 층위, 분류가 핵심일 때

문단만 써도 되는 경우:

- 사용자의 답변에 정서적/지적 피드백을 줄 때
- bridge나 짧은 설명

이를 `presentation_plan`으로 저장한다.

```jsonc
{
  "module_id": "module-02-creation",
  "default_turn_shape": ["hook", "guided_reading", "compare_table", "reflection"],
  "recap_shape": ["bullets", "bridge"],
  "avoid": ["long_paragraph_only"]
}
```

## 7. 런타임 프롬프트는 "채점"을 금지해야 한다

현재 prompt는 "5-9문장", "한 질문", "source-grounded" 같은 규칙은 좋지만, 결과적으로 긴 문단을 유도한다. 더 큰 문제는 `checkpoint_passed`, `masterySignals`, `misconceptionSignals`가 튜터를 채점자로 만든다는 점이다.

새 런타임 원칙:

```text
Assume the learner has not read the source.
Do not ask them to reproduce source details before you have taught those details.
Never say "you need to stick closer to the source" as a primary response.
If the learner is wrong, treat it as a useful intuition, then teach the missing source structure.
Ask questions to invite reflection, not to test recall.
```

화면 구성 규칙:

```text
Return 2-4 content blocks.
Do not return only paragraphs unless the user asked a narrow factual question.
For a new module, use hook + guided_reading before any reflective question.
If the current concept is comparative, include compare_table.
If the learner seems uncertain, include source_quote + plain paraphrase, not another test question.
Keep each block short.
```

그리고 sanitizer가 강제해야 한다.

- `blocks`가 비어 있으면 `message`를 paragraph block으로 변환
- 새 module 시작인데 `hook/guided_reading`이 없으면 fallback guided reading 추가
- `compare_table` row/column 수 제한
- `source_quote`는 허용된 source chunk에서만
- visual id는 현재 material의 visual registry에 있는 것만
- assistant message에 "원문에 더 붙여야 합니다", "다시 말해 보세요"가 반복되면 critic warning

상태 필드도 이름을 바꿔야 한다.

| 기존 | 문제 | 대체 |
| --- | --- | --- |
| `checkpointPassed` | 시험 통과 느낌 | `readyToContinue` |
| `masterySignals` | 정답 키워드 채점 | `understandingSignals` |
| `misconceptionSignals` | 오답 감지 | `confusionSignals` |
| `remediate` | 교정/치료 느낌 | `clarify` |
| `advanceModule` | 통과 후 이동 | `nextSuggestedStep` |

## 8. UI 개선 방향

현재 `MarkdownContent`는 table, list, image, KaTeX를 이미 처리할 수 있다. 즉 첫 단계는 UI 대공사가 아니라 **assistant bubble 내부의 block renderer** 추가다.

추가 컴포넌트:

```text
TutorBlockRenderer
  HookBlock
  GuidedReadingBlock
  SourceQuoteBlock
  BulletBlock
  CompareTableBlock
  ReflectionBlock
  MisconceptionBlock
  BridgeBlock
```

화면 배치:

- assistant bubble 안에서 block들을 세로로 렌더링
- diagram은 해당 턴의 block 사이에 inline으로 들어갈 수 있게 `visual_placement` 지원
- 우측 inspector는 여전히 source/module context 담당
- module 시작 턴에는 작은 "이번 대목에서 읽을 것" header를 표시
- choices 영역의 라벨은 "답변 보기"보다 "다음으로 탐색" 또는 "이어가기"가 낫다. 현재 라벨은 시험 답안 후보처럼 보인다.

디자인 톤:

- 지금 앱의 light theme는 나쁘지 않지만 다소 업무 도구 같다.
- 학습 세션 화면만은 `test-learning-system/index.html`처럼 더 몰입적인 밀도와 리듬을 줘도 된다.
- 단, 전체 앱을 마케팅 페이지처럼 만들 필요는 없다. project/source/material 관리는 utilitarian하게 유지하고, tutor surface만 풍부하게 한다.

## 9. 품질 평가 기준

생성물이 좋아졌는지 자동으로 평가하려면 각 module/turn에 다음 점수를 붙인다.

| Metric | 기준 |
| --- | --- |
| `variety_score` | paragraph-only turn 비율이 낮은가 |
| `grounding_score` | claim/source_ref 매칭이 있는가 |
| `visual_fit_score` | visual이 실제 설명 대상과 맞는가 |
| `guided_reading_score` | 원문을 읽지 않은 사람도 따라갈 수 있게 핵심을 대신 읽어 주는가 |
| `interaction_score` | 사용자를 시험하지 않고 생각하게 만드는 move가 있는가 |
| `density_score` | 너무 길지 않고 정보 밀도가 있는가 |
| `progression_score` | hook -> guided reading -> explanation -> reflection -> bridge 흐름이 있는가 |
| `non_exam_score` | 채점/다그침/정답 재요구 패턴이 없는가 |

발행 전 critic은 아래를 reject해야 한다.

- 3개 턴 연속 문단만 있는 module
- source 없이 사실 주장만 늘어놓는 block
- visual/table이 있는데 설명과 맞지 않는 경우
- choices가 "네/아니오" 수준으로만 반복되는 경우
- module마다 같은 질문 패턴만 반복되는 경우
- 원문을 가르치기 전에 원문 내용을 맞혀 보라고 요구하는 경우
- 사용자 답변에 대해 "아직은 원문 쪽으로 더 붙어야 합니다" 같은 채점 문구를 반복하는 경우
- 같은 질문을 정답이 나올 때까지 반복하는 경우

## 10. 구현 순서

### Step 0: 제품 모드 전환

- tutor policy에서 기본 모드를 `comprehension_test`가 아니라 `guided_lecture`로 정의
- `checkpointPassed`, `masterySignals`, `misconceptionSignals` 중심의 상태명을 학습 흐름 중심으로 변경
- prompt에서 "Assume the learner has not read the source"를 최상위 불변식으로 둠
- 선택지 라벨과 문구를 시험 답안 후보에서 탐색 경로로 변경

### Step 1: 타입 확장

- `src/shared/tutor-types.ts`에 `TutorContentBlock` union 추가
- `TutorTurnOutput`에 `blocks?: TutorContentBlock[]` 추가
- 기존 `message`는 backward-compatible fallback으로 유지

### Step 2: 렌더러 추가

- `src/views/main/components/TutorBlockRenderer.tsx` 추가
- `App.tsx`에서 assistant message 표시 시 `message.blocks`가 있으면 block renderer 사용
- 아직 DB에 blocks 저장 필드가 없으므로 `learning_messages`에 `blocks_json` 추가 migration 필요

### Step 3: VisualSpec 확장

- `artifact-types.ts`의 `VisualSpec` union 확장
- `VisualRenderer.tsx`에 `timeline`, `axis`, `matrix`, `geometry`, `annotated_table`부터 추가
- 기존 flow/contrast/grid/formula는 그대로 유지

### Step 4: artifact generation 개선

- `CourseArtifactService.generate()`의 deterministic placeholder를 유지하되, 별도 `lecture_plan.json`과 `presentation_plan.json` 생성 경로 추가
- 처음에는 AI call이 실패하면 deterministic fallback을 쓰게 한다
- GLM-5.2가 약할 경우에도 JSON schema와 retry/critic으로 보정한다

### Step 5: tutor prompt 변경

- `TutorService.aiTutorOutput()`에서 block-based output schema 요구
- "문단만 반환하지 말라"보다 먼저 "채점하지 말라, 먼저 가르쳐라"를 규칙화
- current module의 `presentation_plan`을 prompt에 포함
- sanitizer에서 block type, 길이, source refs, visual refs 검증

### Step 6: critic 추가

- material 생성 직후 `critic_report.json` 생성
- module별 guided_reading/visual/source/interaction/non_exam 점수 기록
- 낮은 점수 module은 regeneration 후보로 표시

## 11. 가장 먼저 만들 MVP

한 번에 다 하지 말고, 다음 작은 절단면이 좋다.

1. `TutorService` prompt에서 "원문을 읽지 않은 학습자에게 먼저 가르친다"를 최상위 규칙으로 바꿈
2. "아직은 원문 쪽으로..."류의 fallback 문구 제거
3. `checkpointPassed/masterySignals`를 당장 제거하지 못하더라도 visible tutor 발화에는 채점 언어가 나오지 않게 sanitizer/critic 추가
4. `TutorTurnOutput.blocks` 추가
5. `hook`, `guided_reading`, `paragraph`, `bullets`, `compare_table`, `source_quote`, `reflection` 7종 렌더링
6. 기존 `course_artifacts.json`의 Timaeus 자료를 손으로 한 번 guided lecture 스타일로 샘플링
7. GLM-5.2 prompt가 이 schema를 안정적으로 따르는지 test-learning-system에서 먼저 검증
8. 그 뒤 Electrobun 앱에 이전

이 MVP만으로도 현재의 밋밋함은 크게 줄어든다. 이유는 간단하다. 모델이 더 똑똑해지지 않아도, 화면에 나타나는 재료가 문단-문단-문단에서 벗어나 **증거, 표, 질문, 도해, 선택지의 리듬**을 갖기 때문이다.

## 12. 결론

다음 발전 단계의 방향은 "더 좋은 모델을 찾기"도 아니고, 단순히 "더 화려한 UI"도 아니다. 먼저 제품 목적을 바꿔야 한다.

```text
Before: 원문을 읽은 사용자의 이해도를 검사한다.
After: 원문을 읽지 않은 사용자가 원문을 읽은 만큼 배우게 한다.
```

그 다음에 **강의 재료의 저작 단위**를 바꾼다.

기존 설계의 근거성, compile-time/runtime 분리, deterministic rendering 원칙은 유지한다. 다만 IR을 다음 수준으로 올린다.

```text
source-grounded claims
-> pedagogical beats
-> lecture/presentation plan
-> content blocks + visual specs
-> guided lecture runtime
```

이렇게 해야 `test-learning-system/index.html`의 구조적 안정성과 `example/timaeus-course.jsx`의 시각적/서사적 생동감을 함께 가져갈 수 있다.
