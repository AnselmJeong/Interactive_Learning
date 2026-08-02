# Learnie Workspace Renovation Plan

## 0. 문서의 지위

이 문서는 Learnie를 `한 project = 여러 source` 구조에서 `한 project = 여러 책/논문 = 학습 단위` 구조로 옮기기 위한 제품·디자인·데이터·마이그레이션 구현 계약이다.

- 이번 단계의 산출물은 계획뿐이며 기존 코드는 변경하지 않는다.
- 구현은 아래 Phase 순서대로 진행하고, 각 Phase의 검증 gate를 통과한 뒤 다음 단계로 넘어간다.
- 기존 material, session, message, progress, annotation의 ID와 사용자 데이터를 보존하는 것이 최우선이다.
- 화면을 먼저 바꾸고 데이터를 나중에 맞추는 방식은 금지한다. 새 계층을 저장할 수 있는 기반부터 만든다.

---

## 1. Feature summary

Learnie의 project는 하나의 학습 주제를 담고, 그 안에 여러 책과 여러 논문을 함께 둘 수 있어야 한다. 책은 `Project → Book → Source`의 3단계 구조를 가지며, 논문은 사용자에게 `Project → Article`의 2단계 구조로 보인다.

사용자는 Library에서 project의 자료 전체를 조망하고, Learning Space에서 기존 학습 흐름을 유지하며, Highlights & Notes에서 자신이 남긴 학습 흔적을 모아 보고 내보내고, Progress에서 책·논문·project 전체의 실제 학습 진척을 이해한다.

### Primary user action

Library에서 지금 학습할 책 또는 논문을 고른 뒤, 이전 학습 위치를 이어가거나 해당 자료의 source를 선택해 학습을 시작하는 것.

### 성공 조건

1. 한 project에 서로 다른 책 여러 권과 논문 여러 편을 안전하게 가져올 수 있다.
2. 책의 chapter/source들이 어느 책에 속하는지 restart와 project transfer 이후에도 유지된다.
3. 논문은 UI에서 불필요한 하위 source 단계 없이 바로 학습 대상으로 취급된다.
4. 기존 학습 공간의 tutor/session/annotation 동작은 회귀하지 않는다.
5. Library, Highlights & Notes, Progress가 동일한 실제 저장 데이터를 서로 다른 관점으로 보여준다.
6. 준비 진도와 실제 학습 진도를 절대 하나의 수치로 섞지 않는다.
7. 기존 project에서 학습하던 책/논문을 renovation 전에 하나씩 portable bundle로 export하고, renovation 완료 후 원하는 project에 개별 import할 수 있다.
8. renovation 이후에도 project 전체 transfer와 별개로 Book/Article 단위 transfer를 계속 지원한다.
9. Book을 유지한 채 그 안의 source 하나만 안전하게 제거할 수 있다.

---

## 2. 현재 구조에서 확인된 사실과 문제

### 2.1 현재 데이터의 실제 의미

현재 `project_sources`의 source는 업로드한 원본 책 자체가 아니라, Preppy가 책에서 분리한 chapter Markdown 하나인 경우가 많다.

```text
현재 사용자 인식             현재 내부 저장
Project                      projects
└─ Book PDF                  (독립된 book row가 없음)
   ├─ Chapter A              project_sources row A
   ├─ Chapter B              project_sources row B
   └─ Chapter C              project_sources row C
```

원본 책의 흔적은 `original_file_path`의 `book.pdf#chapters/...` 표기와 `source_folders/.../folder_manifest.json`에 남지만, DB에서 질의 가능한 상위 Book 엔티티는 없다. 따라서 다음 기능은 현재 구조 위에 UI만 덧씌워서는 신뢰성 있게 만들 수 없다.

- 책별 제목·저자·출판년도·ISBN·표지·개요
- 책별 source 목록
- 책 단위 학습 진척도
- 책 단위 annotation 필터와 export
- 한 project 안의 여러 책을 안정적으로 구분하는 Library

### 2.2 재사용해야 하는 기존 기반

- `projects.description`은 Library hero의 project 설명 원천으로 재사용할 수 있다.
- `document_type`은 파일 형식이 아니라 학습 의미인 `book | article`을 이미 구분한다.
- `learning_materials ↔ material_sources`는 하나 이상의 source로 학습 material을 만드는 구조를 이미 지원한다.
- 실제 학습 위치는 session의 `current_chunk_id`, `covered_chunk_ids_json`에 저장된다.
- 준비 진도는 `learning_message_sets.completed_messages / total_messages`에 별도로 저장된다.
- highlight, note, lookup, question, image 등은 `material_annotations`의 공통 저장·locator·delete 흐름을 사용한다.
- project transfer가 DB row와 portable artifact를 이미 운반하므로 새 document row만 확장하면 된다.
- 현재 source/material/session/annotation의 stable ID와 portable artifact 경로는 기존 학습 상태를 Book/Article 단위 bundle로 옮기는 기반으로 재사용할 수 있다.

### 2.3 이번 공사에서 피해야 할 접근

- filename prefix만 런타임에 묶어 책처럼 보이게 하는 임시 grouping
- 기존 `project_sources`를 바로 삭제하거나 ID를 다시 발급하는 파괴적 migration
- 책별 진행률을 source별 percentage의 단순 평균으로 계산하는 방식
- 준비가 끝난 source를 학습이 끝난 source로 표시하는 방식
- Highlights & Notes를 기존 annotation과 별도 DB/파일에 중복 저장하는 방식
- Book/Article transfer를 읽기용 annotation export나 project 전체 transfer와 같은 이름/형식으로 취급하는 방식
- 여러 Book의 source를 참조하는 material을 임의로 잘라 Book 하나의 학습 기록처럼 export하는 방식
- 거대한 `App.tsx` 안에 네 workspace 화면을 모두 직접 추가하는 방식
- Google Books 조회 실패 때문에 원본 업로드 자체를 실패시키는 방식

---

## 3. 제품 용어와 목표 정보 구조

### 3.1 사용자 용어

| 용어 | 의미 | UI 노출 |
| --- | --- | --- |
| Project | 하나의 학습 주제/연구 주제 | project selector, hero |
| Book | 업로드한 책 원본 한 권 | Library card |
| Article | 업로드한 논문 원본 한 편 | Library item |
| Source | 책에서 선택해 가져온 chapter/section 학습 단위 | book 선택 시 우측 pane |
| Learning material | tutor가 사용하는 생성 산출물 | 일반 UI에서는 가급적 숨김 |
| Session | 특정 material에 대한 실제 학습 기록 | Learning Space와 최근 기록 |
| Annotation | highlight, note, lookup, question 등 저장된 학습 흔적의 총칭 | Highlights & Notes |
| Project Transfer | project 전체를 다른 설치로 옮기는 machine-readable bundle | project menu |
| Book/Article Transfer | 책 또는 논문 하나와 그 학습 상태를 원하는 project로 옮기는 machine-readable bundle | document menu, Library import |
| Annotation Export | 읽고 공유하기 위한 human-readable Markdown ZIP | Highlights & Notes |

`자료`, `문서`, `source`, `책`을 같은 의미로 섞어 쓰지 않는다. 버튼과 상태 문구도 이 용어집을 따른다.

### 3.2 사용자에게 보이는 계층

```text
Project
├─ Book A
│  ├─ Source A-1
│  ├─ Source A-2
│  └─ Source A-3
├─ Book B
│  ├─ Source B-1
│  └─ Source B-2
├─ Article C
└─ Article D
```

논문도 내부 처리상 단일 source/material 연결이 필요하지만, UI에서는 그 구현 세부를 노출하지 않는다. Article을 선택하면 곧바로 article preview 또는 기존 session으로 이동한다.

### 3.3 왼쪽 pane

Project selector 아래 Workspace navigation을 고정한다.

1. `라이브러리`
2. `학습 공간`
3. `하이라이트 · 노트`
4. `학습 진척도`

현재의 source 목록은 왼쪽 pane에서 제거한다. source는 project 전역 navigation이 아니라 선택한 Book의 하위 내용이므로 Library의 우측 contextual pane으로 이동한다.

---

## 4. Design direction

### 4.1 인상

`.impeccable.md`의 방향을 유지한다.

- **차분함**: 긴 학습을 방해하지 않는 warm light/dark surface
- **집중감**: dashboard보다 책과 편집물에 가까운 hierarchy
- **지원적 태도**: 진행을 재촉하기보다 현재 위치와 다음 행동을 분명히 제시

참고 이미지의 장점인 큰 읽기 영역, typography 중심의 계층, 얇은 divider, 넉넉한 여백, restrained accent를 유지한다. 모든 정보를 rounded card로 감싸지 않고, card가 실제 선택 단위일 때만 경계를 준다.

### 4.2 화면 골격

Desktop은 현재의 resizable three-pane shell을 유지한다.

```text
┌────────────────┬──────────────────────────────────────┬──────────────────┐
│ Project +      │ Active workspace view                │ Contextual pane  │
│ Workspace nav  │ Library / Learning / Annotations /   │ Book sources /   │
│                │ Progress                             │ filters / map    │
└────────────────┴──────────────────────────────────────┴──────────────────┘
```

- Library: 중앙은 hero와 document 목록, 우측은 선택한 Book의 source 목록 또는 Article 개요
- Learning Space: 현재 중앙 학습 UI와 inspector를 최대한 유지
- Highlights & Notes: 중앙은 annotation collection, 우측은 filter/export summary
- Progress: 중앙은 project·document progress와 activity, 우측은 course map

우측 pane은 항상 같은 내용을 보여주는 inspector가 아니라 현재 workspace에 맞는 contextual pane이다.

### 4.3 기억에 남아야 하는 한 가지

Library의 각 Book이 단순 파일 카드가 아니라 “읽고 있는 책의 상태”로 느껴져야 한다. 표지·서지정보·마지막 학습 위치·얇은 실제 학습 progress가 한 덩어리로 읽히되, 과도한 통계 dashboard가 되지 않게 한다.

---

## 5. Workspace별 상세 설계

## 5.1 Library

### A. Header

- 제목: `나의 라이브러리`
- 보조 정보: `책 N권 · 논문 M편 · 마지막 학습 <상대 시간>`
- 검색: 제목, 저자, ISBN, source 제목을 검색
- primary action: `자료 가져오기`
- 검색 결과는 document를 기준으로 반환하고, source가 일치한 경우 `일치한 source: ...`를 보조 표시한다.

### B. Project hero

Hero는 project 소개와 복귀 동작만 책임진다.

- project title
- `projects.description`
- 전체 실제 학습 진도
- 가장 최근 active session의 document/source와 마지막 학습 시각
- `학습 계속하기` 버튼
- hero background는 project 전용 이미지가 있으면 사용하고, 없으면 warm editorial fallback을 사용

Google Books의 특정 책 표지를 project hero에 자동 사용하지 않는다. 여러 책 중 하나가 project 전체를 대표한다는 잘못된 인상을 줄 수 있기 때문이다.

Project description과 hero image 편집은 hero의 보조 action에서 연다. description이 없을 때는 빈 문장을 만들지 말고 `프로젝트 소개 추가` action을 보여준다.

### C. Document 목록

기본 section 제목은 `학습 중인 자료`로 한다. 책만 있을 때는 `학습 중인 책`으로 자연스럽게 좁혀도 된다.

Book card 필수 정보:

- cover thumbnail 또는 typographic fallback cover
- title, subtitle
- author/editor
- publication year
- 실제 학습 상태: `시작 전`, `학습 중`, `완료`
- 실제 학습 percent와 마지막 학습 시각
- `source N개`
- 준비 상태는 필요할 때만 별도 작은 label로 표시 (`준비 중`, `학습 준비 완료`)

Article item 필수 정보:

- title
- authors, year, journal/DOI가 있으면 표시
- 실제 학습 상태와 percent
- `논문` type label
- 하위 source count는 표시하지 않음

Book card click:

1. 선택 상태를 즉시 표시한다.
2. 우측 pane을 해당 Book의 source 목록으로 바꾼다.
3. 중앙 목록의 scroll 위치는 유지한다.
4. double click이나 card 내부의 `학습 계속하기`는 최근 source/session으로 바로 이동할 수 있다.

Article click:

1. 우측 pane에 article 개요와 마지막 session을 표시한다.
2. `학습 시작` 또는 `학습 계속하기`가 primary action이다.
3. 사용자에게 내부 단일 source row를 노출하지 않는다.

### D. Library 우측 pane — Book sources

Header:

- cover, title, author/year
- `source N개`
- book 실제 학습 진도
- close/back action

Source row:

- 원래 chapter 순서
- source title
- 실제 상태
- `현재 13/104 대목` 또는 `완료`
- note/highlight count
- 준비 상태는 별도 secondary metadata
- click 시 기존 material preview/session 흐름으로 이동

행 hover에만 rename/delete를 숨겨 기능을 감추지 않는다. 보조 actions는 persistent kebab menu로 제공하고, keyboard focus에서도 동일하게 접근할 수 있게 한다.

### E. Book 안의 Source 제거

Project 전체 삭제, Book/Article 삭제, Book 안의 Source 제거는 서로 다른 범위의 action이다.

- Source row의 persistent kebab menu에 `Source 제거`를 둔다.
- Article은 UI상 terminal document이므로 내부 source 제거를 노출하지 않고 `논문 삭제`만 제공한다.
- Source 제거 전 impact preview에 다음 count를 보여준다.
  - 제거할 source 1개
  - 이 source만 참조하여 함께 삭제될 learning material 수
  - 영향을 받는 session, message, annotation, prepared message 수
  - 여러 source를 참조하여 자동 삭제할 수 없는 shared material 수
- destructive button은 `Source와 학습 기록 삭제`처럼 결과를 구체적으로 쓴다.
- source를 제거해도 Book row와 서지정보는 유지한다. 마지막 source를 제거한 Book은 empty Book이 되고 `Source 다시 가져오기`를 제공한다.
- 삭제 후 남은 source의 `source_ordinal`은 원래 상대 순서를 유지하도록 재정렬한다.
- active learning session의 source를 제거하면 안전한 Library route로 이동하고 stale active IDs를 모두 비운다.

Shared material 규칙:

- 삭제 대상 source만 참조하는 material은 연결된 session/annotation과 함께 transaction 안에서 삭제한다.
- 다른 source도 함께 참조하는 material은 자동으로 부분 수정하지 않는다. 생성된 course와 session 의미가 달라지기 때문이다.
- shared material이 있으면 기본 동작은 source 제거를 block하고, 영향 material을 먼저 삭제하거나 Book/Project transfer를 사용하도록 안내한다.
- 향후 명시적인 `material 재생성` 기능이 생기기 전까지 shared material을 조용히 재작성하지 않는다.

파일 정리:

- DB transaction이 성공하기 전에 source files를 영구 삭제하지 않는다.
- source directory는 project-local quarantine으로 먼저 이동하고 DB commit 후 정리한다.
- 실패 시 원위치 복구한다.
- 실제 복구 가능한 grace period를 구현하지 않는 release에서는 undo를 거짓으로 제공하지 않고, count가 있는 명시적 confirmation을 사용한다.

### F. Library states

| 상태 | 사용자에게 보여줄 것 |
| --- | --- |
| project 없음 | project 생성/가져오기 action |
| 빈 Library | 자료를 가져오면 책별 source와 학습 상태가 정리된다는 설명 + `첫 자료 가져오기` |
| metadata 조회 중 | card 골격은 먼저 보여주고 서지정보 영역만 skeleton |
| metadata 없음 | filename 기반 제목 + `서지정보 직접 입력`; 업로드는 성공 상태 유지 |
| import 처리 중 | 파일 복사, 책 분석, source 준비 단계를 문구와 progress로 구분 |
| import 일부 실패 | 성공한 document와 실패한 document를 분리하여 보고하고 재시도 제공 |
| 검색 결과 없음 | 현재 query와 해제 action 표시 |
| source 없음 | Book은 남기고 `가져온 source가 없습니다` + source 재선택 action |

## 5.2 Learning Space

현재 학습 공간은 구조와 동작을 가능한 한 유지한다.

보존 대상:

- 준비 진도와 실제 학습 진도의 분리
- 원문 보기 / 학습 공간 전환
- tutor conversation과 `이어 학습`
- selection toolbar, side chat, annotation locator/delete
- source/figure rendering과 existing session resume
- focus management와 Korean/English keyboard shortcut behavior

필요한 변경만 한다.

- topbar breadcrumb: `Project / Book / Source` 또는 `Project / Article`
- Library/Progress에서 선택한 document/source/session을 동일한 학습 route로 연결
- 여러 Book을 오갈 때 source/session state가 섞이지 않도록 route state를 ID 기반으로 명시
- article은 기존 topic-only preview를 유지하고 하위 source breadcrumb를 숨김

## 5.3 Highlights & Notes

기존 `material_annotations`를 읽는 새로운 collection view다. 복제 저장소를 만들지 않는다.

### 기본 화면

- heading: `하이라이트 · 노트`
- project 내 annotation 총 수와 최근 저장 시각
- tab/filter: `전체`, `하이라이트`, `노트`, `질문`, `찾아보기`, `이미지`
- document filter: 전체, 특정 Book, 특정 Article
- Book을 고른 경우 source filter 추가
- search: selected text, note/question body, source title
- sort: 최신순 기본, source 순서, 오래된순

Annotation row/card:

- kind, selected text
- note/answer preview는 Markdown 구조를 유지
- Book/Article · Source · locator
- session/date
- `원문에서 보기` 또는 `학습 기록에서 보기`
- edit 가능한 note, delete + undo

### 일괄 export

`내보내기`는 현재 filter 범위를 명확히 보여주는 action이다.

권장 v1 산출물:

```text
<project-title>-annotations-YYYYMMDD-HHmm.zip
├─ annotations.md
└─ assets/
   └─ 실제 참조된 이미지만
```

`annotations.md` grouping:

```text
Project
└─ Book 또는 Article
   └─ Source (Book일 때만)
      └─ Annotation items in source order
```

- export 대상 count를 버튼 또는 확인 sheet에 표시한다.
- selected text, note/question thread, source locator, 생성 시각을 포함한다.
- 내부 UUID, absolute path, API 설정, 준비 메시지는 포함하지 않는다.
- machine restoration은 범위에 따라 Project Transfer 또는 Book/Article Transfer가 담당한다. annotation export와 혼합하지 않는다.
- 0개 filter 결과에서는 export action을 disabled 처리하고 이유를 설명한다.

## 5.4 Book/Article Transfer

Book/Article Transfer는 읽기용 export가 아니라 **한 document와 그 학습 상태를 복원하는 machine-readable 이동 형식**이다.

세 export의 책임을 고정한다.

| 기능 | 범위 | 목적 | import 가능 |
| --- | --- | --- | --- |
| Project Transfer | project 전체 | 다른 컴퓨터/설치에서 project 전체 계속 사용 | 예 |
| Book/Article Transfer | document 1개 + 연결된 학습 상태 | 원하는 project에 책/논문 하나씩 옮김 | 예 |
| Annotation Export | 현재 filter의 annotation | 읽기, 공유, 보관 | 아니오 |

### A. Renovation 전 기존 자료 export

이 기능은 renovation이 모두 끝난 뒤가 아니라, **첫 번째로 배포 가능한 호환 단계**에서 제공해야 한다. 사용자가 현재 학습 중인 자료를 먼저 안전하게 꺼내 둘 수 있어야 하기 때문이다.

기존 DB에는 Book row가 없으므로 legacy exporter가 다음 근거로 책/논문 후보를 만든다.

1. `folder_manifest.json`의 original Book path와 source order
2. `original_file_path`의 `#` 앞 원본 path
3. `document_type = article`인 single source
4. 판별할 수 없는 source는 안전하게 1 source = 1 Book 후보

UI flow:

```text
Project menu 또는 migration 도구
→ 기존 자료를 책/논문 후보별로 preview
→ 포함 source와 학습 기록 count 확인
→ 각 후보를 개별 .learnie-document.zip으로 export
→ export 결과 manifest/checksum 검증
```

Batch convenience로 `모든 자료 개별 내보내기`를 제공할 수 있지만, 결과는 project bundle 하나가 아니라 document별 독립 bundle N개여야 한다.

### B. Renovation 후 상시 export

Library의 Book/Article menu에 `다른 project로 내보내기`를 둔다.

- 한 번에 document 하나를 export한다.
- export는 원본 파일, selected sources, generated material, sessions, visible/prepared messages, progress, learner signals, annotations, metadata, cover를 포함한다.
- project description, 다른 document, project-level settings, API keys는 포함하지 않는다.
- export 중에도 source/session state는 변경하지 않는다.
- 완료 후 파일 경로, source/session/annotation count, checksum 검증 결과를 보여준다.

권장 filename:

```text
<document-title>-learnie-document-YYYYMMDD-HHmm.zip
```

### C. Renovation 후 개별 import

Library의 `자료 가져오기` menu에 `Learnie 책·논문 가져오기`를 둔다.

1. `.learnie-document.zip` 선택
2. archive path traversal, size limits, manifest schema, checksums, FK graph를 read-only preview에서 검증
3. destination 선택
   - 현재 project에 추가
   - 다른 기존 project 선택
   - 새 project 생성
4. title/type/source/session/annotation count와 충돌 여부 확인
5. transaction + staging directory로 import
6. 성공 후 destination project의 해당 document를 Library에서 선택

Document는 destination project의 learning level과 provider settings를 자동으로 덮어쓰지 않는다. 기존 prepared messages는 원래 generation context와 함께 보존하되, destination의 현재 model/settings와 호환되지 않으면 `stale`로 표시하고 재생성을 제안한다.

### D. Bundle 포함 범위

```text
document-transfer.json
state.json
document/
├─ metadata.json
├─ cover.*
├─ sources/<source-id>/...
└─ materials/<material-id>/...
```

Logical state:

- selected `project_documents` row 1개
- 그 document의 `project_sources`
- 해당 source 집합에 완전히 포함되는 `learning_materials`와 `material_sources`
- 위 material의 message sets, prepared messages, sessions, messages
- session/module progress, learner signals, annotations
- document transfer lineage/history

### E. Cross-document material 정책

한 material이 둘 이상의 document source를 함께 참조하면 Book 하나로 정확하게 나눌 수 없다.

- exporter는 이를 반드시 탐지하고 preview에 `교차 자료 material`로 표시한다.
- session/message/annotation을 임의 분할하거나 source subset으로 course를 변조하지 않는다.
- 기본은 document transfer를 block하고 project 전체 transfer를 권장한다.
- 원본 source와 document metadata만 export하는 별도 선택지는 제공할 수 있지만, `학습 기록 제외`를 명시하고 기본값으로 삼지 않는다.

### F. Identity와 중복 import

- bundle은 `originDocumentId`, `originProjectId`, `exportId`, `parentExportId`, `documentStateHash`를 가진다.
- destination import는 새 local document ID를 발급할 수 있으며 모든 포함 FK를 하나의 ID mapping table로 remap한다.
- 같은 export를 같은 project에 다시 가져오면 duplicate를 만들지 않고 `no_changes`로 분류한다.
- 같은 lineage의 더 최신 bundle은 preview에서 fast-forward 가능 여부를 보여준다.
- destination에서 수정된 상태와 bundle이 갈라졌으면 자동 merge하지 않고 `diverged`로 block한다.
- 동일 ISBN만으로 같은 document라고 판단하지 않는다. ISBN은 서지 식별자이지 Learnie 학습 상태 lineage가 아니다.

## 5.5 Progress

Progress는 “준비가 얼마나 되었나”가 아니라 “실제로 어디까지 배웠나”를 답해야 한다.

### 중앙 영역

- project title과 `학습의 궤적`
- project 전체 실제 학습 percent
- 설명: 현재 Book/Article, Source, chunk 위치
- 최근 학습 기록 timeline
- document별 progress list
- `학습 계속하기`

최근 학습 기록은 다음 event를 우선 사용한다.

- session 시작/재개
- source/module 완료
- 실제 chunk coverage 증가
- highlight/note/question 저장

준비 작업, metadata fetch, background message generation은 학습 기록 timeline에 넣지 않는다.

### 우측 Course map

- 전체 project map을 무리하게 한 트리에 펼치지 않는다.
- 상단에서 Book/Article을 선택하고 해당 document의 source/module map을 보여준다.
- 완료 = green, current = amber, not started = neutral
- color만으로 상태를 전달하지 않고 label/icon/text를 병행한다.

### Progress 계산 계약

가장 작은 신뢰 단위는 chunk다.

```text
Source learned = unique covered chunks / total source chunks
Book learned   = Σ covered chunks of its sources / Σ total chunks of its sources
Article learned = unique covered chunks / total article chunks
Project learned = Σ covered chunks of all documents / Σ total chunks of all documents
```

규칙:

- source percentage의 단순 평균을 사용하지 않는다. source 크기가 다르기 때문이다.
- 여러 session이 같은 source를 학습했다면 `covered_chunk_id`의 합집합을 사용한다.
- `current_chunk_id`는 화면상의 현재 위치지만, 학습 완료 count에는 실제로 reveal/covered된 시점에만 포함한다.
- 삭제/재생성으로 더 이상 존재하지 않는 orphan chunk ID는 denominator와 numerator에서 제외하고 진단 log에 기록한다.
- annotation 수는 engagement 지표일 뿐 progress percentage에 더하지 않는다.
- preparation percentage는 필요하면 document row에 별도 표기하되 learned percentage와 합치지 않는다.

---

## 6. Target data model

### 6.1 새 상위 엔티티: `project_documents`

책과 논문의 공통 원본/서지 정보를 저장한다.

```sql
CREATE TABLE project_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('book', 'article')),
  title TEXT NOT NULL,
  subtitle TEXT,
  description TEXT,
  authors_json TEXT NOT NULL DEFAULT '[]',
  publisher TEXT,
  published_date TEXT,
  isbn_10 TEXT,
  isbn_13 TEXT,
  journal TEXT,
  doi TEXT,
  language TEXT,
  provider TEXT,
  provider_volume_id TEXT,
  metadata_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (metadata_status IN ('pending', 'found', 'not_found', 'manual', 'failed')),
  metadata_fetched_at INTEGER,
  original_file_name TEXT NOT NULL,
  original_file_path TEXT,
  content_hash TEXT,
  cover_image_path TEXT,
  imported_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

보충 결정:

- `authors_json`은 문자열 하나가 아니라 순서가 있는 배열이다.
- `published_date`는 Google Books가 연도만 돌려줄 수 있으므로 강제로 full date로 변환하지 않는다.
- `description`은 provider synopsis 또는 사용자가 편집한 개요다. provider HTML은 sanitize 후 plain/limited rich text로 저장한다.
- cover는 remote URL만 저장하지 않고 project-local cache 파일을 기본으로 한다.
- 사용자가 수정한 필드는 이후 metadata refresh가 자동으로 덮어쓰지 않도록 field provenance 또는 `metadata_overrides_json`을 둔다.
- raw provider response가 필요하면 최소 필드만 별도 JSON artifact로 저장하고 DB의 canonical fields와 분리한다.

### 6.2 `project_sources` 확장

```sql
ALTER TABLE project_sources ADD COLUMN document_id TEXT
  REFERENCES project_documents(id) ON DELETE CASCADE;
ALTER TABLE project_sources ADD COLUMN source_ordinal INTEGER;
ALTER TABLE project_sources ADD COLUMN source_kind TEXT;
```

- 새 import부터 `document_id`는 필수다.
- migration 호환 기간에만 nullable로 두고 backfill 검증 뒤 애플리케이션 invariant로 강제한다.
- Book source는 실제 chapter/section 순서를 `source_ordinal`에 보존한다.
- Article은 내부적으로 정확히 하나의 source와 연결한다. UI와 public view model에서는 펼치지 않는다.
- 기존 `document_type` column은 즉시 삭제하지 않는다. 구버전 transfer/bundle과 rollback을 위해 한 release 이상 mirror 유지 후 제거 여부를 별도 결정한다.

### 6.3 선택적 project hero fields

`projects`에 다음을 additive migration으로 추가한다.

```text
hero_image_path TEXT NULL
hero_focal_point_json TEXT NULL
```

description은 기존 column을 재사용한다.

### 6.4 Document transfer lineage

중복 import, fast-forward, divergence를 timestamp나 ISBN 추측으로 처리하지 않도록 별도 lineage를 저장한다.

```sql
CREATE TABLE document_transfer_history (
  export_id TEXT PRIMARY KEY,
  local_document_id TEXT REFERENCES project_documents(id) ON DELETE SET NULL,
  origin_document_id TEXT NOT NULL,
  origin_project_id TEXT NOT NULL,
  parent_export_id TEXT,
  device_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('export', 'import')),
  document_state_hash TEXT NOT NULL,
  transferred_at INTEGER NOT NULL,
  applied_at INTEGER
);
```

Project Transfer가 이미 가진 lineage 개념을 document 범위로 축소해 재사용하되, 두 history를 같은 table/identity로 섞지 않는다.

### 6.5 관계

```text
projects
└─ project_documents
   ├─ project_sources
   │  └─ material_sources ─ learning_materials
   │                         ├─ learning_sessions
   │                         │  ├─ learning_messages
   │                         │  └─ progress tables
   │                         └─ material_annotations
   └─ bibliographic metadata / cached cover
```

기존 source/material/session/annotation ID는 그대로 유지하므로 새 계층을 추가해도 locator와 학습 기록이 끊기지 않는다.

---

## 7. ISBN 및 Google Books metadata pipeline

### 7.1 ISBN 추출

업로드 filename에서 다음 순서로 처리한다.

1. Unicode normalize 후 확장자를 제거한다.
2. `ISBN`, 공백, hyphen을 허용하여 ISBN-10/ISBN-13 candidate를 찾는다.
3. 숫자와 ISBN-10의 마지막 `X`만 남겨 canonical form으로 만든다.
4. ISBN-10/13 checksum을 로컬에서 검증한다.
5. 여러 candidate가 있으면 유효한 ISBN-13을 우선하고, import review에서 사용자가 바꿀 수 있게 한다.
6. 유효 candidate가 없으면 API를 호출하지 않고 manual metadata path로 간다.

잘못된 10/13자리 숫자를 ISBN으로 오인하지 않도록 regex만으로 끝내지 않는다.

### 7.2 조회 계약

Google Books Volumes API의 ISBN search를 사용한다.

```http
GET https://www.googleapis.com/books/v1/volumes
  ?q=isbn:<canonical-isbn>
  &maxResults=5
  &projection=lite
  &fields=totalItems,items(id,volumeInfo(...필요 필드...))
```

가져올 canonical fields:

- `title`, `subtitle`
- `authors[]`
- `publisher`, `publishedDate`
- `description`
- `industryIdentifiers[]`
- `imageLinks`
- `language`
- provider volume `id`

결과 선택:

- 첫 번째 결과를 맹목적으로 쓰지 않는다.
- `industryIdentifiers`에 요청 ISBN과 canonical exact match가 있는 결과를 우선한다.
- 동일 ISBN의 판본이 여러 개면 language, filename hint, title similarity를 보조 점수로 쓰고 import review에서 변경 가능하게 한다.
- exact match가 없으면 `not_found`로 처리하고 사용자에게 후보를 강요하지 않는다.

### 7.3 실패·offline 정책

Metadata는 enhancement이며 import의 필수 조건이 아니다.

- API key 없음: `서지정보를 자동 조회하지 못했습니다. 직접 입력하거나 나중에 다시 시도할 수 있습니다.`
- offline/timeout: exponential backoff를 짧게 적용한 뒤 `failed`; 원본 분석은 계속
- 429: `Retry-After`를 존중하고 background retry 가능 상태로 둠
- 5xx: 제한된 횟수만 retry
- no match: `not_found`, manual edit 제공
- cover fetch 실패: typographic fallback cover 사용

API key와 raw provider error는 UI/log/export에 노출하지 않는다. 동일 ISBN은 local metadata cache를 사용하고 수동 refresh action을 제공한다.

### 7.4 Import UX 순서

```text
파일 선택
→ Book / Article 선택
→ ISBN 추출 + metadata lookup과 Preppy 분석을 병렬 수행
→ document별 review (서지정보 + 선택 source)
→ commit
→ Library에 즉시 표시
→ material/message 준비는 background
```

여러 PDF를 선택한 경우 한 거대한 source list가 아니라 document별 batch review를 제공한다. Book마다 ISBN과 source 선택 상태를 독립적으로 확인할 수 있어야 한다.

---

## 8. Backend/service/RPC plan

### 8.1 서비스 책임

새 서비스:

- `DocumentService`: document CRUD, source membership, ordering, aggregate summary
- `BookMetadataService`: ISBN parse/checksum, Google Books lookup, cover cache, refresh
- `ProgressService`: source/document/project progress snapshot과 recent activity query
- `AnnotationExportService`: filter된 annotation의 readable export
- `DocumentTransferService`: legacy/current document bundle export, preview, import, ID remap, lineage validation

기존 서비스 조정:

- `SourceService`: chapter extraction과 source persistence는 유지하되 반드시 document context 안에서 실행
- `CourseArtifactService`: 기존 source set 기반 generation을 유지; Book 기본 학습은 source 하나 또는 선택 source 집합으로 명시
- `ProjectTransferService` / `ProjectBundleSync`: documents와 cached cover 포함
- `DeletionService`: project/document/source별 영향 preview, shared-material guard, transactional cascade와 file quarantine

### 8.2 View models

DB row를 UI에서 직접 조립하지 말고 아래 summary를 backend에서 제공한다.

```ts
type DocumentSummary = {
  id: string;
  projectId: string;
  documentType: "book" | "article";
  title: string;
  subtitle: string | null;
  authors: string[];
  publisher: string | null;
  publishedDate: string | null;
  isbn10: string | null;
  isbn13: string | null;
  coverUrl: string | null; // local asset server URL
  metadataStatus: "pending" | "found" | "not_found" | "manual" | "failed";
  sourceCount: number;
  learning: ProgressSummary;
  preparation: PreparationSummary;
  annotationCount: number;
  lastStudiedAt: number | null;
};

type ProgressSummary = {
  status: "not_started" | "in_progress" | "completed";
  coveredChunks: number;
  totalChunks: number;
  percent: number;
  currentSourceId: string | null;
  activeSessionId: string | null;
};
```

### 8.3 RPC surface

권장 신규/변경 RPC:

```text
documents.list({ projectId })
documents.get({ projectId, documentId })
documents.updateMetadata({ projectId, documentId, patch })
documents.refreshMetadata({ projectId, documentId })
documents.listSources({ projectId, documentId })
documents.delete({ projectId, documentId })
documents.previewSourceRemoval({ projectId, documentId, sourceId })
documents.removeSource({ projectId, documentId, sourceId, impactToken })

documents.prepareImport({ projectId, paths, documentType })
documents.commitPreparedImport({ projectId, importId, selections })
documents.cancelPreparedImport({ projectId, importId })

documents.exportTransfer({ projectId, documentId, destinationFolder? })
documents.exportLegacyTransfers({ projectId, destinationFolder? })
documents.prepareTransferImport({ path, destinationProjectId? })
documents.commitTransferImport({ importId, destinationProjectId?, createProject? })
documents.cancelTransferImport({ importId })

progress.getProjectSnapshot({ projectId })
progress.getDocumentSnapshot({ projectId, documentId })

annotations.listProject({ projectId, filters, cursor })
annotations.exportReadable({ projectId, filters, destinationFolder? })
```

기존 `sources.*` RPC는 한 compatibility release 동안 wrapper로 유지하고 새 UI는 `documents.*`를 사용한다.

Transfer preview/response에는 최소한 다음을 포함한다.

```ts
type DocumentTransferCounts = {
  sources: number;
  materials: number;
  sessions: number;
  messages: number;
  preparedMessages: number;
  annotations: number;
  assets: number;
  crossDocumentMaterials: number;
};

type DocumentTransferClassification =
  | "create_document"
  | "no_changes"
  | "fast_forward"
  | "diverged"
  | "cross_document_blocked"
  | "invalid";
```

`previewSourceRemoval`은 계산된 영향 대상을 hash한 짧은 `impactToken`을 반환한다. `removeSource`는 같은 token을 요구하여, preview 후 새로운 session/annotation이 생겼다면 오래된 count로 삭제하지 않고 다시 확인하게 한다.

### 8.4 Query/performance

- document list에서 row마다 별도 progress/annotation query를 실행하지 않는다.
- project 단위 aggregate query 또는 bounded batch query를 사용한다.
- annotation collection은 pagination/cursor를 지원한다.
- source title/annotation search에는 필요한 index를 추가한다.
- cover는 network URL을 매 render마다 읽지 않고 local asset server/cache를 사용한다.

---

## 9. Frontend architecture plan

현재 `App.tsx`가 project/source/import/learning/annotation state를 광범위하게 소유한다. 이번 기능을 그대로 추가하면 변경 위험이 너무 커지므로 기능별 경계를 먼저 만든다.

권장 구조:

```text
src/views/main/
├─ App.tsx                         # shell + top-level routing only
├─ workspace/
│  ├─ workspace-route.ts
│  ├─ LibraryView.tsx
│  ├─ LearningSpaceView.tsx
│  ├─ AnnotationLibraryView.tsx
│  └─ ProgressView.tsx
├─ library/
│  ├─ ProjectHero.tsx
│  ├─ DocumentList.tsx
│  ├─ BookCard.tsx
│  ├─ ArticleRow.tsx
│  ├─ BookSourceInspector.tsx
│  └─ DocumentImportFlow.tsx
├─ annotations/
│  ├─ AnnotationFilters.tsx
│  ├─ AnnotationCollection.tsx
│  └─ AnnotationExportAction.tsx
└─ progress/
   ├─ ProjectProgressSummary.tsx
   ├─ LearningActivityTimeline.tsx
   └─ DocumentCourseMap.tsx
```

### State ownership

- `activeProjectId`: shell
- `workspaceRoute`: shell, project별 마지막 route를 local preference로 복원 가능
- `selectedDocumentId`: Library/Progress route state
- `selectedSourceId`, `activeMaterialId`, `activeSessionId`: Learning route state
- import modal state: import flow component
- annotation filters: URL-like serializable local state

navigation payload는 object reference가 아니라 stable ID로 전달한다. project를 바꿀 때 하위 selection을 검증하고, 없는 ID는 안전한 empty/default state로 되돌린다.

---

## 10. Migration strategy

## 10.1 원칙

- additive → backfill → dual read 검증 → new write → compatibility 제거 순서
- source/material/session/annotation ID 재발급 금지
- migration 시작 전에 SQLite backup 생성
- 전체 backfill을 하나의 transaction 안에서 수행
- startup migration은 idempotent해야 함
- migration 결과 count와 orphan을 log하고, 실패하면 구 DB로 계속 쓰지 말고 안전하게 startup을 중단

## 10.2 Legacy grouping algorithm

기존 source를 document로 묶는 우선순위:

1. `source_folders/*/folder_manifest.json`의 `originalPath`와 `sourceOrder`
2. `original_file_path`에서 `#` 앞의 원본 path
3. 동일한 원본 path가 없으면 source 하나당 document 하나

추가 규칙:

- `document_type = article`인 기존 source는 각각 Article document 하나로 만든다.
- Book source는 같은 original Book path를 공유할 때 한 Book document로 묶는다.
- source order는 folder manifest의 `sourceOrder`, 그다음 chapter manifest index, 마지막으로 현재 natural filename order를 사용한다.
- title은 ISBN metadata가 있으면 metadata title, 없으면 원본 filename title을 사용한다.
- grouping이 모호한 경우 source를 잃지 않도록 각각 독립 Book document로 만들고 migration warning을 남긴다.

## 10.3 Pre-renovation document export bridge

사용자의 기존 학습 자료를 renovation 완료 전에 먼저 꺼낼 수 있도록 아래 기능을 독립적인 작은 release로 선행한다.

1. read-only legacy grouping preview
2. 후보별 source/material/session/annotation count와 cross-document material 검사
3. 새 `learnie-document-transfer` schema로 document별 bundle 생성
4. archive를 다시 읽어 checksum, manifest, state graph를 self-validate
5. 모든 후보를 개별 bundle로 batch export하는 convenience action

이 단계는 DB에 `project_documents`를 영구 backfill하지 않아도 동작해야 한다. exporter가 export 시점에 synthetic `originDocumentId`를 결정론적으로 만들고 manifest에 source grouping evidence를 기록한다. 이후 renovated importer가 이를 정상 Document로 materialize한다.

단, 같은 legacy project를 다시 export했을 때 동일한 자료가 전혀 다른 lineage가 되지 않도록 synthetic origin ID는 `projectId + normalized original path + ordered source IDs`의 stable hash로 만든다. 파일 내용이나 제목만으로 identity를 만들지 않는다.

## 10.4 DB migration 단계

1. DB backup과 migration marker 생성
2. `project_documents` 및 indexes 생성
3. `project_sources`에 nullable `document_id`, `source_ordinal`, `source_kind` 추가
4. legacy source grouping과 document row 생성
5. 모든 source의 `document_id` backfill
6. invariant 검증
7. project bundle manifest에 document 정보 기록
8. 새 import는 document-first write로 전환
9. old/new read parity test 후 UI를 documents API로 전환

검증 invariant:

```text
모든 project_source는 존재하는 project_document를 가리킨다.
source.project_id == document.project_id 이다.
모든 article document는 내부 source를 정확히 하나 가진다.
기존 material_sources 수와 ID 집합이 migration 전후 동일하다.
기존 session/message/annotation 수와 ID 집합이 동일하다.
```

## 10.5 Project transfer와 bundle compatibility

- transfer schema version을 올리고 `project_documents` table과 cached cover를 포함한다.
- counts에 `documents`를 추가한다.
- preview 단계에서 documents/source foreign key와 필수 column을 실제 commit 전에 검증한다.
- old transfer bundle은 source grouping algorithm으로 import 가능하게 한다.
- 새 bundle을 구버전 앱이 잘못 읽지 않도록 `minimumReaderSchemaVersion`을 정확히 올린다.
- restart recovery용 project bundle에도 documents metadata를 기록한다.

## 10.6 Book/Article transfer compatibility

- format은 `learnie-document-transfer`, 별도 schema version을 사용한다.
- renovated app은 pre-renovation bridge가 만든 bundle과 current document bundle을 모두 읽는다.
- import preview는 destination project ID를 archive의 origin project ID로 덮어쓰지 않는다.
- state import는 포함된 모든 row의 project/document/source/material/session 관계를 destination과 새 ID mapping에 맞춰 remap한다.
- absolute path는 거부하거나 staged local path로 다시 쓴다.
- archive entry count, per-file size, total extracted size, compression ratio 제한을 둔다.
- import 실패 시 DB transaction과 staged files를 함께 rollback한다.
- import 성공 후 project bundle snapshot을 즉시 갱신하여 restart recovery에서도 새 document가 사라지지 않게 한다.

---

## 11. Interaction, responsive, accessibility

### Interaction states

모든 Book card, source row, filter, export action은 default/hover/focus/active/disabled/loading/error/success 상태를 갖는다.

- click과 keyboard `Enter`/`Space` 동작 일치
- list/grid navigation은 tab order를 예측 가능하게 유지
- focus ring 제거 금지
- icon-only 보조 action에는 구체적인 `aria-label`과 tooltip 제공
- import/export/delete 진행 중에는 대상 범위만 busy 처리
- 실제 복구 가능한 delete는 즉시 UI에서 숨기고 undo하는 현재 pattern을 재사용한다. Source/Book처럼 cascade와 파일 삭제를 포함하면 영향 count와 구체적인 confirmation을 먼저 보여주고, 실제 grace-period/quarantine 복원이 있을 때만 undo를 제공한다.

### Responsive adaptation

이 앱은 desktop 우선이지만 창이 좁아질 수 있다.

- 넓은 창: 3-pane
- 중간 폭: left pane 유지, contextual right pane은 overlay/drawer
- 좁은 폭: left nav drawer, 중앙 단일 pane, detail은 back navigation
- Library card는 container query로 cover+metadata row와 compact layout을 전환
- hover에만 의존하는 action 금지
- coarse pointer에서는 최소 44px hit target 확보
- 긴 책 제목, 다수 저자, 한글/영문 혼합, 30% 이상 늘어난 번역 문자열을 견딘다.

### Accessibility acceptance

- progressbar에 `aria-valuemin/max/now/valuetext`
- 상태 색상 외 text/icon 병행
- modal/dialog focus trap과 restore
- skeleton에 잘못된 완료 announcement를 하지 않음
- live region은 import 단계 변화와 export 완료처럼 필요한 알림에만 사용
- reduced motion에서는 selection/transition animation 축소

---

## 12. Implementation phases and gates

## Phase 0 — Characterization and safety net

목표: 현행 동작을 테스트로 고정한다.

- legacy Book PDF import가 chapter source 여러 개를 만드는 fixture
- Article PDF가 single source로 저장되는 fixture
- source → material → session → annotation 관계 snapshot
- 실제 progress와 preparation progress characterization
- project transfer round-trip fixture
- current `App.tsx` navigation/focus/selection regression tests

Gate:

- 현재 test/typecheck 통과
- migration 전 fixture DB와 expected ID/count snapshot 확보

## Phase 0.5 — 기존 학습 자료의 Book/Article별 export bridge

목표: 대공사 전에 현재 학습 자료를 document별 portable bundle로 안전하게 보관할 수 있게 한다.

- legacy grouping preview
- cross-document material detector
- document transfer manifest/state/file writer
- document별 export와 `모든 자료 개별 내보내기`
- export archive self-validation

Gate:

- 기존 Book과 Article fixture가 각각 독립 bundle로 생성됨
- source/material/session/message/progress/annotation count가 원본과 일치함
- 교차 document material은 조용히 잘리지 않고 export가 block됨
- 생성된 모든 bundle이 checksum/state graph validation을 통과함

## Phase 1 — Add document data model

- schema와 migration 구현
- `DocumentService`, `DocumentSummary`
- legacy grouping/backfill
- bundle/transfer schema 확장
- document transfer lineage table과 renovated import reader
- UI는 아직 기존 source 목록 유지

Gate:

- legacy DB migration 후 source/material/session/annotation ID와 count 동일
- restart와 transfer round-trip 후 document grouping 동일
- Phase 0.5 bundle을 새 DB의 지정 project에 import한 뒤 학습 session/annotation을 다시 열 수 있음
- rollback backup 생성과 실패 복구 검증

## Phase 2 — Document-first import + metadata

- prepared import를 document batch 중심으로 변경
- ISBN parser/checksum unit tests
- Google Books client, exact ISBN matcher, cache, timeout/retry
- metadata review/manual edit
- cover local cache와 fallback cover
- Book/Article 모두 새 document row를 먼저 생성하고 source 연결
- current Book/Article의 상시 document transfer export/import와 destination project picker

Gate:

- API success/no match/offline/429/invalid ISBN 테스트
- 같은 ISBN 재조회 cache 테스트
- multiple Book batch에서 partial failure와 cancel cleanup 검증
- Book 기본/Article opt-in 기존 contract 유지

## Phase 3 — Workspace shell and Library

- Workspace nav와 route state
- 현재 source sidebar 제거, Library view 도입
- project hero
- Book/Article list
- Book source right pane
- Source 제거 impact preview, shared-material block, transactional removal
- Article direct-open behavior
- Library search와 empty/loading/error states

Gate:

- project 전환 시 selection 누수 없음
- Book → Source → Learning → Library 복귀 시 위치 보존
- Article에서 source 계층이 노출되지 않음
- Source 하나 제거 시 다른 Book/source/session이 영향받지 않으며 마지막 source 제거 후 Book shell은 유지됨
- keyboard/focus/resizable pane 회귀 없음

## Phase 4 — Learning Space integration

- 기존 학습 UI를 `LearningSpaceView` 경계로 이동
- breadcrumb와 document/source context 연결
- Library/Progress deep link
- current source/session resume logic 통합

Gate:

- 기존 Book 학습, Article topic-only preview, source view, selection annotation, side chat 모두 회귀 없음
- preparation/learning bars 의미와 ARIA 유지
- packaged app restart 후 같은 학습 위치 복원

## Phase 5 — Highlights & Notes + export

- project-level annotation query/filter/pagination
- collection view와 locator deep link
- note edit/delete undo
- readable batch export + referenced assets

Gate:

- 모든 annotation kind가 누락 없이 나타남
- material/session scope가 올바른 위치로 이동
- Markdown note/question thread 구조 보존
- filter count와 export count 동일
- export에 secrets/absolute paths/internal IDs가 없음

## Phase 6 — Progress

- `ProgressService`와 union-based chunk coverage
- project/document/source snapshot
- recent learning activity
- document selector + course map

Gate:

- 크기가 다른 source에서 weighted result가 정확함
- 여러 session의 covered chunk 중복 제거
- 준비 100%, 학습 0% 케이스가 명확히 분리
- orphan chunk와 deleted source를 안전하게 처리

## Phase 7 — Polish, performance, release

- large project 성능 측정 (예: 책 50권, source 1,000개, annotation 10,000개)
- dark/light, narrow window, Korean/English typography QA
- screen reader/keyboard/reduced-motion QA
- transfer/import/export real artifact smoke test
- user-facing migration note와 release version update

Gate:

- no N+1 document list query
- Library first meaningful content가 local data에서 즉시 보임
- 전체 test/typecheck/python test/build smoke 통과
- stable packaged app을 기존 사용자 DB 복사본에서 실행 검증

---

## 13. Test matrix

### Data/migration

- legacy single-book project
- legacy multi-book project
- legacy Book + Article mixed project
- direct Markdown/TXT source
- 같은 제목이지만 다른 ISBN인 책
- ISBN은 같지만 edition이 다른 파일
- source가 0개인 prepared/cancelled Book
- missing folder manifest, missing original path
- interrupted migration and retry

### Metadata

- valid ISBN-10 / ISBN-13 / lowercase `x`
- hyphen/space/`ISBN_13` filename variants
- checksum invalid
- no result, multiple result, exact identifier mismatch
- missing author/year/cover/description
- HTML description sanitization
- offline, timeout, 429, 5xx
- manual edits surviving refresh/restart/transfer

### UI

- empty project, one Book, many Books, Article-only, mixed Library
- very long Korean/English title and many authors
- Library search matching only a child source
- right pane open/closed/resized
- mouse, keyboard, coarse pointer behavior
- light/dark and reduced motion

### Learning and progress

- never-started, active, completed, archived sessions
- multiple sessions on one source
- one session spanning multiple selected sources
- source regenerated with changed chunk set
- preparation complete while learning not started
- annotation created in source and chat surfaces

### Export/transfer

- all annotations export
- filtered Book/source/kind export
- image annotations/assets
- export destination collision
- pre-renovation legacy Book별 transfer export
- pre-renovation Article별 transfer export
- `모든 자료 개별 내보내기`가 N개의 독립 bundle을 생성
- legacy document bundle → renovated app → 현재 project에 import
- 같은 bundle → 새 project에 import
- duplicate/no_changes, fast-forward, diverged classification
- local ID collision을 포함한 full FK remap
- cross-document material export block
- corrupted checksum, path traversal, zip bomb limits
- old transfer → new app
- new transfer → same/new computer
- transfer preview schema mismatch detection

### Deletion

- Book의 중간 source 제거 후 order와 progress 재계산
- 마지막 source 제거 후 empty Book 유지
- source-only material/session/annotation cascade count와 실제 count 일치
- shared material이 있는 source 제거 block
- preview 뒤 새 annotation이 생겼을 때 stale `impactToken` 거부
- file quarantine 실패와 DB rollback
- active source 제거 후 Library safe route
- Article에는 child source 제거 action이 노출되지 않음

---

## 14. Risks and mitigations

| Risk | 영향 | 완화 |
| --- | --- | --- |
| legacy source를 잘못된 Book으로 묶음 | Library/진척도 왜곡 | folder manifest 우선, 보수적 one-source fallback, migration report |
| App.tsx 동시 대규모 변경 | 학습 흐름 회귀 | shell/view boundary를 단계적으로 추출, characterization tests |
| Google Books metadata 오매칭 | 잘못된 제목/저자 표시 | checksum + exact industry identifier, import review, manual override |
| remote cover 의존 | offline/URL 만료 | project-local cache + typographic fallback |
| progress double count | 과장된 학습률 | chunk ID set union, weighted aggregation, fixture test |
| document cascade delete | 사용자 기록 손실 | 영향 preview, undo/staged deletion, transaction |
| source 제거가 shared material을 손상 | 다른 source의 session/course 의미 훼손 | shared-material detector로 기본 block, 자동 부분 재작성 금지 |
| document transfer가 학습 상태 일부를 누락 | renovation 후 복원 불완전 | 관계 closure count, checksum, export self-validation, import round-trip fixture |
| destination import의 ID 충돌 | 다른 project 데이터 오염 | full ID remap table, lineage 기반 중복 판정, transaction |
| transfer schema drift | preview 성공 후 commit 실패 | preview에서 real table/column/FK validation, minimum reader version |
| annotation collection 성능 | 큰 project에서 UI 지연 | indexed query, pagination, backend summary |

### Rollback

- Phase 1 migration 전 DB backup을 자동 생성한다.
- 새 column/table은 additive이므로 이전 source/material/session row는 보존한다.
- compatibility release 동안 기존 `sources.list`와 `document_type`을 유지한다.
- 새 UI가 불안정할 경우 feature flag로 기존 source sidebar를 임시 복원할 수 있게 하되, 새 document writes를 되돌리지는 않는다.

---

## 15. Acceptance criteria

### 계층과 import

1. 한 project에 책 여러 권과 논문 여러 편을 가져올 수 있다.
2. 새로 import한 Book은 source를 1개 이상 가지며 순서가 보존된다. 사용자가 모든 source를 제거한 뒤에는 서지정보를 가진 empty Book으로 남을 수 있다.
3. Article은 UI에서 terminal document이며 내부 source는 노출되지 않는다.
4. 기존 project를 열면 source 손실 없이 Book/Article document가 생성된다.
5. restart와 project transfer 후 grouping, metadata, cover, order가 유지된다.

### Library

6. hero가 project 설명, 실제 전체 진도, continue target을 보여준다.
7. Book card가 제목, 저자, 출판년도, 실제 progress를 보여준다.
8. Book click 시 우측에 해당 Book source만 나타난다.
9. Google Books 실패/무결과에서도 import가 성공하고 manual edit가 가능하다.
10. 검색은 document와 child source를 찾는다.

### Book/Article Transfer와 제거

11. renovation 전 기존 자료를 Book/Article 후보별 독립 bundle로 export할 수 있다.
12. `모든 자료 개별 내보내기` 결과는 document 수와 같은 수의 독립 bundle이다.
13. legacy bundle을 renovation 후 사용자가 고른 기존 project 또는 새 project에 import할 수 있다.
14. document transfer 후 material, session, message, progress, annotation과 source locator가 복원된다.
15. renovation 이후에도 모든 Book/Article에서 상시 개별 transfer export를 사용할 수 있다.
16. 동일 bundle 재import, fast-forward, divergence를 lineage로 구분한다.
17. cross-document material은 임의 분할되지 않고 안전하게 block된다.
18. Book 안의 source 하나를 제거할 수 있고 삭제 전 영향 count가 실제 cascade와 일치한다.
19. shared material을 손상할 source 제거는 block되며, 마지막 source 제거 후에도 empty Book은 유지된다.

### Learning

20. 기존 Book/Article learning preview와 tutor/session 흐름이 유지된다.
21. 준비 진도와 실제 학습 진도가 별도 수치와 별도 visual로 남는다.
22. Library/Progress에서 연 source/session으로 정확히 이동한다.

### Highlights & Notes

23. 기존 모든 annotation이 collection view에 표시된다.
24. Book/Article/source/kind/search filter가 조합 가능하다.
25. locator, note edit, delete/undo가 기존 저장 흐름을 재사용한다.
26. 현재 filter 전체를 readable ZIP으로 내보낼 수 있다.

### Progress

27. progress는 실제 covered chunks의 weighted aggregate다.
28. 여러 session의 중복 chunk가 한 번만 계산된다.
29. recent activity는 학습 행동만 보여주고 background 준비 작업을 섞지 않는다.

### 품질

30. keyboard만으로 네 workspace와 주요 action을 사용할 수 있다.
31. 좁은 창에서도 주요 기능이 사라지지 않는다.
32. migration, typecheck, unit/integration, document/project transfer round-trip, packaged smoke test가 모두 통과한다.

---

## 16. Open questions와 권장 기본값

구현을 시작하기 전에 최종 확인할 항목이다. 답이 없으면 아래 권장값으로 진행한다.

1. **Library에서 Article도 함께 보일지**

   권장: 함께 표시하되 `Book / Article` filter를 제공한다. 그렇지 않으면 Article로 들어갈 일관된 진입점이 없다.

2. **Book card click과 학습 시작의 관계**

   권장: single click은 우측 source pane, 명시적 `계속 학습` action은 session open. 탐색과 실행을 분리한다.

3. **Book 여러 source를 하나의 통합 course로 학습할지**

   권장: v1은 현재처럼 source 단위 material/session을 기본으로 유지한다. Book-wide course는 별도 product decision으로 미룬다. 계층 migration과 tutor semantics를 동시에 바꾸면 위험이 커진다.

4. **Hero image 생성/선택 방식**

   권장: user-selected local image + editorial fallback부터 시작한다. 특정 Book cover 자동 채택이나 AI 자동 생성은 v1 범위에서 제외한다.

5. **Annotation export format**

   권장: v1은 readable Markdown ZIP. machine portability는 범위에 따라 Project Transfer 또는 Book/Article Transfer가 담당한다.

6. **Google Books API key 위치**

   권장: Settings의 provider credential 영역에 저장하고 export/transfer에는 포함하지 않는다. key가 없어도 manual metadata로 정상 작동한다.

7. **Book/Article Transfer import의 기본 destination**

   권장: 현재 열려 있는 project를 기본 선택하되 commit 전에 project 이름을 명시적으로 보여준다. `새 project로 가져오기`도 같은 preview에서 고를 수 있게 한다.

8. **교차 document material 처리**

   권장: 학습 상태를 임의 분할하지 않고 document transfer를 block한다. source-only export를 별도 선택지로 둘 수 있지만 기본값은 아니다.

---

## 17. 예상 주요 변경 파일

Backend/data:

- `src/bun/project-db.ts`
- `src/bun/source-service.ts`
- `src/bun/course-artifact-service.ts`
- `src/bun/project-transfer-service.ts`
- `src/bun/project-bundle-sync.ts`
- `src/bun/deletion-service.ts`
- 신규 document/metadata/progress/annotation-export/document-transfer services

Shared contracts:

- `src/shared/rpc-types.ts`
- `src/shared/artifact-types.ts`
- `src/shared/project-transfer-types.ts`
- 신규 document/progress/document-transfer types

Frontend:

- `src/views/main/App.tsx`
- `src/views/main/styles/app.css`
- `src/views/main/components/SourceImportModal.tsx`
- `src/views/main/components/SourceDocumentTypeModal.tsx`
- 신규 workspace/library/annotations/progress components

Tests:

- `src/bun/project-db.test.ts`
- `src/bun/source-service.test.ts`
- `src/bun/project-transfer-service.test.ts`
- `src/bun/project-bundle-sync.test.ts`
- 신규 document-transfer/deletion impact tests
- annotation/session export tests
- 신규 metadata/progress/component interaction tests

---

## 18. 구현 시 참고할 design references

- `impeccable/reference/spatial-design.md`: Library의 card/list 균형, three-pane rhythm, container query
- `impeccable/reference/interaction-design.md`: card/source selection, focus, loading/error/success, overlay
- `impeccable/reference/responsive-design.md`: contextual pane의 drawer 전환과 pointer별 target
- `impeccable/reference/ux-writing.md`: import 실패, metadata 미발견, empty/export 상태 문구

이 계획은 데이터 계층과 사용자 계층을 먼저 일치시키고, 그 위에 네 workspace를 단계적으로 올리는 순서를 고정한다. 가장 중요한 첫 구현 단위는 Library 화면이 아니라 **Phase 0의 현행 데이터 characterization과 Phase 0.5의 기존 Book/Article별 export bridge**다. 기존 자료를 안전하게 꺼낸 뒤 Phase 1의 `project_documents` migration으로 이동한다.
