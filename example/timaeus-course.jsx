import React, { useState, useRef, useEffect } from "react";

/* ────────────────────────────────────────────────────────────────────────
   티마이오스: 세계의 탄생 — 인터랙티브 강의
   러셀 《서양철학사》 '플라톤의 우주생성론' 절을 원천 텍스트로 삼아,
   안의 튜터(claude-sonnet-4-6)가 학습자의 답에 반응하며 소크라테스식으로
   끌고 간다. 적절한 대목에서 천체 도해를 직접 띄운다.
   ──────────────────────────────────────────────────────────────────────── */

const SOURCE = `# 플라톤의 우주생성론 (러셀, 서양철학사)

- 《티마이오스》에 서술. 키케로가 라틴어로 옮겼고, 중세 서방이 알던 유일한 플라톤 저작.
- 신플라톤주의·중세를 통틀어 플라톤의 어떤 저작보다 큰 영향. 철학적으로는 중요하지 않으나 역사적 영향이 막대 → 이 역설이 핵심.
- 주요 화자는 피타고라스 천문학자 티마이오스. 수(數)가 세계의 설명 원리.

핵심 논지:
- 불변=지성/이성으로 파악, 변화=의견으로 파악. 세계는 감각 가능하므로 영원할 수 없고 창조되었다.
- 신은 선하기에 영원한 원형(pattern)을 따라 세계를 만들었다. "모든 것이 가능한 한 선하고 나쁜 것은 없기를 바랐다."
- 무(無)에서의 창조가 아니라, 무질서하게 움직이던 기존 재료에 질서를 부여(재배열). 유대-기독교 신과 다른 점.
- 신은 지성을 영혼에, 영혼을 육체에 넣어, 세계를 영혼·지성을 지닌 하나의 살아있는 피조물로 만듦.
- 세계는 오직 하나. 영원한 원본의 복사본이라 최대한 닮게 설계됨.
- 세계는 구체(球體): 닮음이 닮지 않음보다 아름답고, 구만이 모든 방향에서 동일. 원운동이 가장 완전하므로 회전. 유일한 운동이라 발·손 불필요. 자족적.
- 네 원소(불·공기·물·흙)는 연속 비례: 불:공기 = 공기:물 = 물:흙. 모든 원소를 다 써서 완전 → 노화·질병 없음, 우정의 정신, 신 외엔 해체 불가.
- 신은 영혼을 먼저, 육체를 나중에. 영혼은 불가분-불변 + 가분-가변이 섞인 제3의 중간 본질.
- 시간의 기원: 신이 복사본을 원본에 더 닮게 하려 했으나 원본은 영원하고 피조물에 그 속성을 온전히 줄 수 없어, "영원의 움직이는 이미지"를 만듦 = 시간. 영원은 '있다(is)'일 뿐 '있었다/있을 것이다'가 아님. 시간엔 '있었다/있을 것이다'가 옳음.
- 시간과 하늘은 동시에 생김. 태양은 동물들이 산수를 배우게 하려고. 낮밤·월·년의 목격 → 수의 지식 → 시간 개념 → 철학. 시각이 준 가장 큰 선물.
- 세계 외 네 종류 동물: 신들(주로 불, 항성=신적·영원한 동물), 새, 물고기, 육지 동물. 창조주는 신들을 파괴할 수 있으나 안 함. 가멸적 부분은 신들에게 맡김. (신 관련 구절은 문자 그대로가 아닌 상상력의 소산일 가능성.)
- 별마다 영혼 하나. 영혼은 감각·사랑·두려움·분노를 지님. 극복하면 의롭게, 아니면 불의하게. 잘 산 자는 자기 별에서 영원히 행복; 나쁜 자는 다음 생에 여자→짐승…이성이 승리할 때까지 윤회.
- 원인 둘: (1)지성을 지닌 원인=아름답고 선한 것의 작업자, (2)타자에 의해 움직여지고 다시 타자를 움직이는 원인=질서·설계 없이 우연. 창조는 필연+지성의 혼합. 주의: 필연은 신의 권능에 종속되지 않는다.
- 흙·공기·불·물은 제1원리/원소가 아님. 불은 '이것(this)'이 아니라 '이러한 것(such)' = 실체가 아니라 실체의 상태.
- 지성(mind) vs 참된 의견: 다르다. 지성은 가르침으로 심기고 참된 이성을 동반, 신·극소수의 속성. 의견은 설득으로 심기고 만인이 공유.
- 공간 이론(난해): 공간은 본질의 세계와 감각 사물의 세계 사이의 중간적 존재. 존재 세 종류 — (1)항상 동일·창조도 파괴도 안 됨·지성만 관조, (2)감각으로 지각·창조됨·항상 운동·의견과 감각으로 파악, (3)공간=영원·불멸·모든 창조물에 터전 제공·'모조 이성(spurious reason)'으로 파악·거의 실재 아님. 러셀: 매우 난해, 기하학적 성찰에서 비롯됐을 것(공간은 순수 이성 같으면서 감각세계의 측면). 칸트가 좋아했을 것.
- 물질의 진짜 원소 = 두 직각삼각형: 정사각형의 절반(45-45-90), 정삼각형의 절반(30-60-90). 신이 형상·수로 빚어 "가능한 한 가장 아름답고 좋게". 이 둘로 다섯 정다면체 중 넷을 구성, 각 원소의 원자는 정다면체.
- 대응: 흙=정육면체, 불=정사면체, 공기=정팔면체, 물=정이십면체.
- 정십이면체: "신이 우주의 윤곽을 그리는 데 쓴 다섯 번째 조합." 우주가 정십이면체임을 암시(다른 곳에선 구체라고도). 정오각형 면 ↔ 피타고라스의 오각별('건강').
- 인간 안 두 영혼: 불멸적(신이 창조, 머리에) + 가멸적(신들이 창조, 가슴에). 가멸적 영혼: 쾌락(악의 최대 유인)·고통·경솔과 두려움·달래기 어려운 분노·쉽게 빗나가는 희망에 종속.
- 기이한 생리학: 내장은 음식을 붙잡아 탐식을 막는 목적. 윤회 재론(비겁·불의 → 여자; 수학 없이 별만 보는 경박한 자 → 새; 철학 없는 자 → 야생 육지동물; 가장 어리석은 자 → 물고기).
- 마지막: "우주는 가시적 동물이 되었으며…지성적 신의 이미지인 감각적 신, 가장 위대하고 아름답고 완전한, 유일무이한 하늘이다."
- 러셀의 평가: 진지하게 믿은 듯한 것 = 혼돈→질서의 창조, 네 원소의 비례와 정다면체, 시간·공간론, 복사본/원형. 필연과 목적의 혼합은 철학 이전부터의 그리스적 신념이며 플라톤은 이를 수용해 (기독교를 괴롭힌) 악의 문제를 피함. 윤회 세부·신들의 역할은 장식. 전체는 고대·중세에 미친 막대한 영향 때문에 연구할 가치가 있고, 그 영향은 가장 환상적인 부분에만 국한되지 않는다.`;

const SYSTEM_PROMPT = `당신은 버트런드 러셀의 목소리를 빌린, 박식하고 따뜻하지만 약간 건조한 위트를 지닌 철학사 튜터다. 아래 원천 텍스트(러셀 《서양철학사》의 '플라톤의 우주생성론' 절)를 바탕으로, 학습자를 한 명의 지적인 동료로 대하며 소크라테스식 대화로 끌고 간다.

[원천 텍스트]
${SOURCE}

[수업의 방식]
- 절대 한꺼번에 쏟아붓지 마라. 한 번에 하나의 생각만. 배경을 가볍게 깔고 → 흥미로운 질문을 던지고 → 학습자의 실제 답에 진심으로 반응하고(맞은 핵심은 짚어 칭찬, 빗나간 부분은 부드럽게 교정) → 그 답을 발판 삼아 자연스럽게 다음으로 넘어간다.
- 매 turn은 짧게: 한국어 4~6문장 정도. 학습자가 읽고 답하고 싶게 만들어라.
- 라틴어/그리스어 원어를 가끔 괄호로 곁들여라(예: 코라 χώρα, 크로노스 χρόνος). 학습자는 고급 독자다. 그러나 현학적으로 굴지는 마라.
- 러셀처럼 가끔 가벼운 아이러니를 허용하라(예: 신화적 장식은 너무 진지하게 받아들이지 말자고 넌지시).

[대략의 흐름 — 학습자 반응에 따라 유연하게]
1) 도입: 왜 이 시시한(?) 대화편이 천 년을 지배했는가 하는 역설. 첫 질문.
2) 창조의 틀: 무에서가 아니라 '재배열'. 영원한 원형의 복사본. (필요시 diagram: cosmos)
3) 세계는 왜 구체이고 회전하는가 — 닮음의 미학, 자족성. (cosmos)
4) 네 원소와 연속 비례. (elements_proportion)
5) 시간 = 영원의 움직이는 이미지 — 이 절의 백미. (time_eternity)
6) 정다면체와 원소: 두 삼각형 → 다섯 정다면체. 물질의 궁극은 수학적 구조. (triangles, 이어서 platonic_solids)
7) 세 종류의 존재와 공간(코라)의 난해함, 칸트 연결. (three_beings)
8) 영혼·윤회·가멸/불멸(가볍게, 장식임을 일러두며).
9) 러셀의 종합 평가: 무엇이 진지하고 무엇이 장식인가. 마무리하며 더 파고들 주제를 권한다.

[도해 — 적절한 순간에만, 텍스트가 그 내용을 다룰 때 함께 띄운다]
- "cosmos": 하나뿐인 회전하는 구체, 자족성.
- "elements_proportion": 불:공기=공기:물=물:흙 연속 비례.
- "time_eternity": 정지한 영원 vs 수에 따라 움직이는 시간.
- "triangles": 두 직각삼각형(정사각형의 절반 45-45-90, 정삼각형의 절반 30-60-90).
- "platonic_solids": 다섯 정다면체와 원소 대응(불=정사면체, 흙=정육면체, 공기=정팔면체, 물=정이십면체, 우주=정십이면체).
- "three_beings": 존재 / (공간=수용자 코라) / 생성의 세 층위.
한 turn에 도해는 최대 1개. 같은 도해를 반복하지 마라.

[출력 형식 — 반드시 이것만, 다른 텍스트·마크다운·코드펜스 금지]
{
  "message": "튜터의 이번 발화(한국어).",
  "diagram": "cosmos | elements_proportion | time_eternity | triangles | platonic_solids | three_beings 중 하나, 또는 null",
  "choices": ["짧은 응답 후보 1", "..."],
  "progress": 0부터 100 사이 정수(수업 진행도 대략)
}
choices는 0~3개, 각 12단어 이내. 자유 서술을 유도하고 싶으면 빈 배열 []. 학습자가 길게 답하길 원할 땐 빈 배열이 좋다. 매 turn 끝은 질문이나 권유로 마쳐 대화의 동력을 유지하라. 마지막 평가까지 끝나면 message에서 마무리 인사를 하되 다시 짚어볼 주제를 choices로 제안하라.`;

/* ── 기하 헬퍼 ─────────────────────────────────────────── */
const poly = (cx, cy, r, n, rotDeg = -90) => {
  const a0 = (rotDeg * Math.PI) / 180;
  return Array.from({ length: n }, (_, k) => {
    const a = a0 + (k * 2 * Math.PI) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
};
const ptsStr = (p) => p.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" ");

const GOLD = "#C9A24B";
const ASTRAL = "#6FA8C7";
const INK = "#ECE6D6";
const MUTED = "#9DB0C4";

/* ── 도해들 ────────────────────────────────────────────── */
function SolidFig({ x, label, sub, type }) {
  const cx = 60, cy = 60;
  let body = null;
  if (type === "tetra") {
    const t = poly(cx, 62, 46, 3, -90);
    body = (
      <g>
        <polygon points={ptsStr(t)} fill="none" stroke={GOLD} strokeWidth="1.4" />
        {t.map((p, i) => <line key={i} x1={cx} y1={66} x2={p[0]} y2={p[1]} stroke={GOLD} strokeWidth="1" opacity="0.85" />)}
      </g>
    );
  } else if (type === "cube") {
    const f = [[28, 44], [86, 44], [86, 102], [28, 102]];
    const b = f.map(([a, c]) => [a + 22, c - 22]);
    body = (
      <g fill="none" stroke={GOLD} strokeWidth="1.3">
        <polygon points={ptsStr(b)} opacity="0.6" />
        <polygon points={ptsStr(f)} />
        {f.map((p, i) => <line key={i} x1={p[0]} y1={p[1]} x2={b[i][0]} y2={b[i][1]} opacity="0.7" />)}
      </g>
    );
  } else if (type === "octa") {
    const d = poly(cx, 62, 48, 4, -90);
    body = (
      <g fill="none" stroke={GOLD} strokeWidth="1.3">
        <polygon points={ptsStr(d)} />
        <line x1={d[3][0]} y1={d[3][1]} x2={d[1][0]} y2={d[1][1]} opacity="0.85" />
        <line x1={d[0][0]} y1={d[0][1]} x2={d[2][0]} y2={d[2][1]} opacity="0.4" />
      </g>
    );
  } else if (type === "icosa") {
    const o = poly(cx, 62, 46, 5, -90);
    const inn = poly(cx, 62, 19, 5, -90 + 36);
    body = (
      <g fill="none" stroke={GOLD} strokeWidth="1.2">
        <polygon points={ptsStr(o)} />
        <polygon points={ptsStr(inn)} opacity="0.85" />
        {o.map((p, i) => (
          <g key={i}>
            <line x1={p[0]} y1={p[1]} x2={inn[i][0]} y2={inn[i][1]} opacity="0.7" />
            <line x1={p[0]} y1={p[1]} x2={inn[(i + 4) % 5][0]} y2={inn[(i + 4) % 5][1]} opacity="0.7" />
          </g>
        ))}
      </g>
    );
  } else if (type === "dodeca") {
    const o = poly(cx, 62, 46, 5, -90);
    const inn = poly(cx, 62, 25, 5, -90 + 36);
    body = (
      <g fill="none" stroke={GOLD} strokeWidth="1.2">
        <polygon points={ptsStr(o)} />
        <polygon points={ptsStr(inn)} opacity="0.9" />
        {inn.map((p, i) => (
          <g key={i}>
            <line x1={p[0]} y1={p[1]} x2={o[i][0]} y2={o[i][1]} opacity="0.7" />
            <line x1={p[0]} y1={p[1]} x2={o[(i + 1) % 5][0]} y2={o[(i + 1) % 5][1]} opacity="0.7" />
          </g>
        ))}
      </g>
    );
  }
  return (
    <g transform={`translate(${x},0)`}>
      {body}
      <text x="60" y="132" textAnchor="middle" fill={INK} fontSize="14" fontWeight="600" style={{ fontFamily: "'Noto Serif KR', serif" }}>{label}</text>
      <text x="60" y="150" textAnchor="middle" fill={MUTED} fontSize="11">{sub}</text>
    </g>
  );
}

function Diagram({ name }) {
  const cap = (t) => <div style={{ color: MUTED, fontSize: 12.5, marginTop: 10, fontStyle: "italic" }}>{t}</div>;

  if (name === "platonic_solids") {
    return (
      <div className="dgram">
        <svg viewBox="0 0 720 170" width="100%" role="img" aria-label="다섯 정다면체와 원소">
          <SolidFig x={0} type="tetra" label="불" sub="정사면체" />
          <SolidFig x={140} type="octa" label="공기" sub="정팔면체" />
          <SolidFig x={280} type="icosa" label="물" sub="정이십면체" />
          <SolidFig x={420} type="cube" label="흙" sub="정육면체" />
          <SolidFig x={560} type="dodeca" label="우주" sub="정십이면체" />
        </svg>
        {cap("두 직각삼각형이 다섯 정다면체를 짓고, 각 원소의 ‘원자’가 곧 정다면체다. 다섯째 정십이면체엔 우주 전체가 배당된다.")}
      </div>
    );
  }

  if (name === "triangles") {
    return (
      <div className="dgram">
        <svg viewBox="0 0 420 200" width="100%" role="img" aria-label="두 직각삼각형">
          <g fill="none" stroke={GOLD} strokeWidth="1.6">
            <polygon points="40,160 160,160 40,50" />
            <polygon points="40,160 47,153 54,160" stroke={ASTRAL} strokeWidth="1.2" />
          </g>
          <text x="100" y="183" textAnchor="middle" fill={INK} fontSize="13">정사각형의 절반</text>
          <text x="100" y="199" textAnchor="middle" fill={MUTED} fontSize="11">45·45·90</text>
          <g fill="none" stroke={GOLD} strokeWidth="1.6">
            <polygon points="250,160 380,160 250,72" />
            <polygon points="250,160 257,153 264,160" stroke={ASTRAL} strokeWidth="1.2" />
          </g>
          <text x="315" y="183" textAnchor="middle" fill={INK} fontSize="13">정삼각형의 절반</text>
          <text x="315" y="199" textAnchor="middle" fill={MUTED} fontSize="11">30·60·90</text>
        </svg>
        {cap("플라톤이 본 물질의 진짜 ‘원소’. 흙·물·불·공기가 아니라, 만물을 빚는 두 종류의 직각삼각형이다.")}
      </div>
    );
  }

  if (name === "elements_proportion") {
    const items = [["불", 18], ["공기", 24], ["물", 30], ["흙", 36]];
    let x = 70;
    const xs = [];
    items.forEach((it, i) => { xs.push(x); x += it[1] + 70; });
    return (
      <div className="dgram">
        <svg viewBox="0 0 460 150" width="100%" role="img" aria-label="네 원소의 연속 비례">
          {items.map((it, i) => (
            <g key={i}>
              <circle cx={xs[i]} cy={70} r={it[1]} fill="none" stroke={GOLD} strokeWidth="1.4" />
              <text x={xs[i]} y={76} textAnchor="middle" fill={INK} fontSize="15" style={{ fontFamily: "'Noto Serif KR', serif" }}>{it[0]}</text>
              {i < 3 && <text x={(xs[i] + xs[i + 1]) / 2} y={76} textAnchor="middle" fill={ASTRAL} fontSize="18">:</text>}
            </g>
          ))}
          <text x="230" y="135" textAnchor="middle" fill={MUTED} fontSize="12.5" fontStyle="italic">불 : 공기 = 공기 : 물 = 물 : 흙 — 연속 비례(continuous proportion)</text>
        </svg>
        {cap("네 원소는 우정처럼 비례로 묶여 하나의 조화를 이룬다. 그래서 세계는 신 아니고는 풀어헤칠 수 없다.")}
      </div>
    );
  }

  if (name === "time_eternity") {
    const ticks = poly(330, 75, 44, 12, -90);
    return (
      <div className="dgram">
        <svg viewBox="0 0 460 175" width="100%" role="img" aria-label="영원과 시간">
          {/* 영원 */}
          <circle cx="120" cy="75" r="44" fill="none" stroke={GOLD} strokeWidth="1.6" />
          <circle cx="120" cy="75" r="3.5" fill={GOLD} />
          <text x="120" y="148" textAnchor="middle" fill={INK} fontSize="14" fontWeight="600">영원 (αἰών)</text>
          <text x="120" y="165" textAnchor="middle" fill={MUTED} fontSize="11">‘있다’ — 정지</text>
          {/* 화살 */}
          <line x1="190" y1="75" x2="262" y2="75" stroke={MUTED} strokeWidth="1.1" strokeDasharray="3 3" />
          <polygon points="262,75 254,71 254,79" fill={MUTED} />
          <text x="226" y="62" textAnchor="middle" fill={MUTED} fontSize="11" fontStyle="italic">모사(模寫)</text>
          {/* 시간 */}
          <circle cx="330" cy="75" r="44" fill="none" stroke={GOLD} strokeWidth="1.6" />
          {ticks.map((p, i) => {
            const inner = poly(330, 75, 38, 12, -90)[i];
            return <line key={i} x1={inner[0]} y1={inner[1]} x2={p[0]} y2={p[1]} stroke={GOLD} strokeWidth="1" opacity="0.8" />;
          })}
          <g className="spin" style={{ transformOrigin: "330px 75px" }}>
            <line x1="330" y1="75" x2="330" y2="40" stroke={ASTRAL} strokeWidth="1.8" />
            <circle cx="330" cy="75" r="3" fill={ASTRAL} />
          </g>
          <text x="330" y="148" textAnchor="middle" fill={INK} fontSize="14" fontWeight="600">시간 (χρόνος)</text>
          <text x="330" y="165" textAnchor="middle" fill={MUTED} fontSize="11">‘있었다·있을 것이다’ — 운동</text>
        </svg>
        {cap("시간은 영원의 ‘움직이는 이미지’. 한꺼번에 가질 수 없는 완전함을, 수에 따라 돌며 조금씩 풀어낸다.")}
      </div>
    );
  }

  if (name === "three_beings") {
    const Band = ({ y, t, s, hl }) => (
      <g>
        <rect x="30" y={y} width="400" height="42" rx="6" fill={hl ? "rgba(111,168,199,0.10)" : "rgba(201,162,75,0.06)"} stroke={hl ? ASTRAL : GOLD} strokeWidth={hl ? "1.4" : "1"} />
        <text x="48" y={y + 19} fill={INK} fontSize="14" fontWeight="600">{t}</text>
        <text x="48" y={y + 35} fill={MUTED} fontSize="11.5">{s}</text>
      </g>
    );
    return (
      <div className="dgram">
        <svg viewBox="0 0 460 185" width="100%" role="img" aria-label="세 종류의 존재">
          <Band y={8} t="존재 (Being)" s="영원·불변, 지성으로만 관조" />
          <Band y={64} t="공간 = 수용자 (코라 χώρα)" s="둘 사이의 중간, ‘모조 이성’으로만 파악, 거의 실재 아님" hl />
          <Band y={120} t="생성 (Becoming)" s="감각·운동, 의견으로 파악" />
        </svg>
        {cap("러셀이 ‘매우 난해하다’ 고백한 대목. 본질도 감각물도 아닌 제3의 것 — 칸트가 반겼을 공간관이다.")}
      </div>
    );
  }

  if (name === "cosmos") {
    return (
      <div className="dgram">
        <svg viewBox="0 0 300 200" width="100%" role="img" aria-label="회전하는 우주 구체">
          <g className="spin" style={{ transformOrigin: "150px 95px" }}>
            <circle cx="150" cy="95" r="62" fill="none" stroke={GOLD} strokeWidth="1.5" />
            <ellipse cx="150" cy="95" rx="62" ry="22" fill="none" stroke={GOLD} strokeWidth="0.9" opacity="0.65" />
            <ellipse cx="150" cy="95" rx="24" ry="62" fill="none" stroke={GOLD} strokeWidth="0.9" opacity="0.65" />
            <line x1="150" y1="33" x2="150" y2="157" stroke={GOLD} strokeWidth="0.6" opacity="0.4" />
          </g>
          <path d="M150 14 A 81 81 0 0 1 231 95" fill="none" stroke={ASTRAL} strokeWidth="1.2" strokeDasharray="4 4" />
          <polygon points="231,95 224,88 237,88" fill={ASTRAL} />
          <text x="150" y="190" textAnchor="middle" fill={MUTED} fontSize="12" fontStyle="italic">하나뿐인 구체 · 원운동 · 손발 없는 자족적 생물</text>
        </svg>
      </div>
    );
  }
  return null;
}

/* ── API 호출 ──────────────────────────────────────────── */
async function callTutor(apiHistory) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: apiHistory,
    }),
  });
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  let clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
    if (a !== -1 && b !== -1) {
      try { return JSON.parse(clean.slice(a, b + 1)); } catch {}
    }
    return { message: clean || "응답을 불러오지 못했습니다. 다시 시도해 주세요.", diagram: null, choices: [], progress: null };
  }
}

/* ── 헤더의 회전 우주 마크(시그니처) ───────────────────── */
function CosmosMark() {
  const pent = poly(22, 22, 14, 5, -90);
  return (
    <svg width="46" height="46" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r="20" fill="none" stroke={GOLD} strokeWidth="1" opacity="0.5" />
      <g className="spin-slow" style={{ transformOrigin: "22px 22px" }}>
        <polygon points={ptsStr(pent)} fill="none" stroke={GOLD} strokeWidth="1.1" />
        <circle cx="22" cy="22" r="2.4" fill={GOLD} />
      </g>
    </svg>
  );
}

/* ── 메인 ──────────────────────────────────────────────── */
export default function TimaeusCourse() {
  const [started, setStarted] = useState(false);
  const [msgs, setMsgs] = useState([]); // {role:'tutor'|'user', text, diagram}
  const [choices, setChoices] = useState([]);
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const apiRef = useRef([]);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, loading]);

  async function turn(userText, hidden = false) {
    if (loading) return;
    if (!hidden) setMsgs((m) => [...m, { role: "user", text: userText }]);
    apiRef.current = [...apiRef.current, { role: "user", content: userText }];
    setChoices([]);
    setLoading(true);
    try {
      const out = await callTutor(apiRef.current);
      const text = out.message || "…";
      apiRef.current = [...apiRef.current, { role: "assistant", content: text }];
      setMsgs((m) => [...m, { role: "tutor", text, diagram: out.diagram || null }]);
      setChoices(Array.isArray(out.choices) ? out.choices.slice(0, 3) : []);
      if (typeof out.progress === "number") setProgress(Math.max(0, Math.min(100, out.progress)));
    } catch {
      setMsgs((m) => [...m, { role: "tutor", text: "연결에 문제가 있었습니다. 잠시 후 다시 보내 주세요.", diagram: null }]);
    } finally {
      setLoading(false);
    }
  }

  function begin() {
    setStarted(true);
    turn("강의를 시작해 주세요. 먼저 배경을 가볍게 깔고, 흥미로운 첫 질문을 던져 주세요.", true);
  }
  function send() {
    const t = input.trim();
    if (!t || loading) return;
    setInput("");
    turn(t);
  }
  function reset() {
    apiRef.current = [];
    setMsgs([]); setChoices([]); setProgress(0); setInput(""); setStarted(false);
  }

  const CIRC = 2 * Math.PI * 13;

  return (
    <div className="tw-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Noto+Serif+KR:wght@400;600&display=swap');
        .tw-root{
          --ground:#0E1A2B; --ground2:#13243A; --ink:#ECE6D6; --muted:#9DB0C4;
          --gold:#C9A24B; --line:rgba(201,162,75,.26);
          min-height:100%; color:var(--ink);
          font-family:'Noto Serif KR','Cormorant Garamond',Georgia,serif;
          background:
            radial-gradient(1200px 500px at 70% -10%, rgba(111,168,199,.10), transparent 60%),
            radial-gradient(900px 600px at 10% 110%, rgba(201,162,75,.08), transparent 60%),
            var(--ground);
        }
        .tw-wrap{max-width:760px;margin:0 auto;padding:26px 20px 40px;}
        .tw-head{display:flex;align-items:center;gap:14px;padding-bottom:18px;border-bottom:1px solid var(--line);}
        .tw-eyebrow{font-family:'Cormorant Garamond',serif;font-style:italic;letter-spacing:.04em;color:var(--gold);font-size:15px;}
        .tw-title{font-family:'Cormorant Garamond','Noto Serif KR',serif;font-size:26px;font-weight:600;line-height:1.15;margin:1px 0 0;}
        .tw-prog{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;}
        .spin{animation:rot 14s linear infinite;}
        .spin-slow{animation:rot 60s linear infinite;}
        @keyframes rot{to{transform:rotate(360deg);}}
        .tw-stream{padding:22px 0 8px;display:flex;flex-direction:column;gap:20px;}
        .row{display:flex;}
        .row.user{justify-content:flex-end;}
        .bub{max-width:90%;line-height:1.72;font-size:16px;}
        .bub.tutor{color:var(--ink);}
        .bub.user{background:rgba(201,162,75,.12);border:1px solid var(--line);color:var(--ink);
          padding:11px 15px;border-radius:14px 14px 4px 14px;font-size:15px;max-width:78%;}
        .who{font-family:'Cormorant Garamond',serif;font-style:italic;color:var(--gold);font-size:14px;margin-bottom:5px;letter-spacing:.02em;}
        .dgram{margin:16px 0 2px;padding:18px 16px 14px;border:1px solid var(--line);border-radius:14px;
          background:linear-gradient(180deg, rgba(255,255,255,.015), rgba(0,0,0,.12));}
        .chips{display:flex;flex-wrap:wrap;gap:9px;padding:4px 0 2px;}
        .chip{cursor:pointer;border:1px solid var(--line);background:rgba(201,162,75,.06);color:var(--ink);
          font-family:inherit;font-size:14px;padding:9px 14px;border-radius:20px;transition:.15s;}
        .chip:hover{background:rgba(201,162,75,.16);border-color:var(--gold);}
        .chip:focus-visible{outline:2px solid var(--gold);outline-offset:2px;}
        .tw-input{display:flex;gap:10px;align-items:flex-end;margin-top:18px;padding-top:18px;border-top:1px solid var(--line);}
        .tw-input textarea{flex:1;resize:none;background:var(--ground2);color:var(--ink);
          border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-family:inherit;font-size:15px;line-height:1.5;min-height:46px;max-height:140px;}
        .tw-input textarea:focus{outline:none;border-color:var(--gold);}
        .tw-input textarea::placeholder{color:#5d7186;}
        .btn{cursor:pointer;border:none;border-radius:12px;padding:12px 18px;font-family:'Cormorant Garamond',serif;
          font-size:16px;font-weight:600;letter-spacing:.02em;background:var(--gold);color:#15233a;transition:.15s;}
        .btn:hover{filter:brightness(1.08);}
        .btn:disabled{opacity:.45;cursor:default;}
        .btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--line);font-size:13px;padding:7px 12px;}
        .dots span{display:inline-block;width:6px;height:6px;margin:0 2px;border-radius:50%;background:var(--gold);opacity:.5;animation:bl 1.1s infinite;}
        .dots span:nth-child(2){animation-delay:.18s;} .dots span:nth-child(3){animation-delay:.36s;}
        @keyframes bl{0%,80%,100%{opacity:.25;transform:translateY(0);}40%{opacity:1;transform:translateY(-3px);}}
        /* 시작 화면 */
        .hero{text-align:center;padding:48px 8px 30px;}
        .hero .mark{display:flex;justify-content:center;margin-bottom:18px;}
        .hero h1{font-family:'Cormorant Garamond','Noto Serif KR',serif;font-weight:600;font-size:40px;line-height:1.08;margin:0 0 6px;}
        .hero .lat{font-family:'Cormorant Garamond',serif;font-style:italic;color:var(--gold);font-size:19px;margin-bottom:18px;}
        .hero p{color:var(--muted);font-size:15.5px;line-height:1.75;max-width:520px;margin:0 auto 26px;}
        .hero .start{font-size:18px;padding:13px 28px;}
        @media (max-width:560px){ .hero h1{font-size:32px;} .tw-title{font-size:22px;} .bub.tutor{max-width:100%;} }
        @media (prefers-reduced-motion: reduce){ .spin,.spin-slow,.dots span{animation:none;} }
      `}</style>

      <div className="tw-wrap">
        {!started ? (
          <div className="hero">
            <div className="mark"><CosmosMark /></div>
            <div className="lat">Platonis Timaeus</div>
            <h1>세계의 탄생</h1>
            <p>
              철학으로는 그리 대단치 않은데도 천 년을 지배한 기이한 대화편 하나가 있습니다.
              러셀의 안내를 빌려, 혼돈에서 질서로 — 정다면체와 ‘영원의 움직이는 이미지’까지,
              당신의 대답을 따라 한 걸음씩 걸어가 봅니다.
            </p>
            <button className="btn start" onClick={begin}>강의 시작하기</button>
          </div>
        ) : (
          <>
            <div className="tw-head">
              <CosmosMark />
              <div>
                <div className="tw-eyebrow">Platonis Timaeus</div>
                <div className="tw-title">세계의 탄생</div>
              </div>
              <div className="tw-prog">
                <svg width="30" height="30" viewBox="0 0 30 30">
                  <circle cx="15" cy="15" r="13" fill="none" stroke="rgba(201,162,75,.2)" strokeWidth="2.4" />
                  <circle cx="15" cy="15" r="13" fill="none" stroke={GOLD} strokeWidth="2.4" strokeLinecap="round"
                    strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - progress / 100)}
                    transform="rotate(-90 15 15)" style={{ transition: "stroke-dashoffset .6s ease" }} />
                </svg>
                <span>{progress}%</span>
              </div>
            </div>

            <div className="tw-stream">
              {msgs.map((m, i) => (
                <div key={i} className={`row ${m.role}`}>
                  {m.role === "tutor" ? (
                    <div className="bub tutor">
                      <div className="who">튜터</div>
                      {m.text.split("\n").filter(Boolean).map((p, j) => (
                        <p key={j} style={{ margin: j ? "10px 0 0" : 0 }}>{p}</p>
                      ))}
                      {m.diagram && <Diagram name={m.diagram} />}
                    </div>
                  ) : (
                    <div className="bub user">{m.text}</div>
                  )}
                </div>
              ))}
              {loading && (
                <div className="row tutor">
                  <div className="bub tutor">
                    <div className="who">튜터</div>
                    <div className="dots"><span /><span /><span /></div>
                  </div>
                </div>
              )}
              <div ref={endRef} />
            </div>

            {!loading && choices.length > 0 && (
              <div className="chips">
                {choices.map((c, i) => (
                  <button key={i} className="chip" onClick={() => turn(c)}>{c}</button>
                ))}
              </div>
            )}

            <div className="tw-input">
              <textarea
                value={input}
                placeholder="자유롭게 답하거나 되물어 보세요…  (Enter 전송 · Shift+Enter 줄바꿈)"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                rows={1}
              />
              <button className="btn" onClick={send} disabled={loading || !input.trim()}>보내기</button>
            </div>
            <div style={{ marginTop: 12, textAlign: "right" }}>
              <button className="btn ghost" onClick={reset}>처음부터</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
