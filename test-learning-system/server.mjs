import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

const artifacts = JSON.parse(await readFile(join(ROOT, "course_artifacts.json"), "utf8"));

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function moduleById(moduleId) {
  return artifacts.course_plan.modules.find((module) => module.id === moduleId) || artifacts.course_plan.modules[0];
}

function chunkById(id) {
  return artifacts.source_chunks.find((chunk) => chunk.id === id);
}

function visualIds() {
  return artifacts.visuals.map((visual) => visual.id);
}

function clampHistory(history) {
  return Array.isArray(history) ? history.slice(-12).map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    content: String(message.text || "").slice(0, 1800)
  })) : [];
}

function keywordScore(text, keywords = []) {
  const normalized = String(text || "").toLowerCase();
  return keywords.reduce((score, keyword) => {
    return normalized.includes(String(keyword).toLowerCase()) ? score + 1 : score;
  }, 0);
}

function courseManagerHint(module, payload) {
  if (payload.event !== "user_message") {
    return "새 module 시작이다. 아직 사용자의 이해도를 평가하지 말고, 좋은 첫 질문으로 열어라.";
  }
  const best = keywordScore(payload.userText, module.best_keywords);
  const weak = keywordScore(payload.userText, module.misconception_keywords);
  const likelySatisfied = best >= 2 || (best >= 1 && weak === 0);
  if (likelySatisfied) {
    return "교안 기준으로 사용자의 최근 답변은 현재 module의 핵심 목표를 대체로 충족한 것으로 보인다. 특별한 큰 오해가 보이지 않으면 새 옆길 질문을 던지지 말고, 이해를 인정한 뒤 다음 module 이동을 제안하라.";
  }
  if (weak > 0) {
    return "교안 기준으로 사용자의 최근 답변에는 현재 module의 대표적 오해가 섞여 있다. 바로 다음 module로 넘기지 말고, 오해를 부드럽게 교정한 뒤 같은 목표를 다른 각도로 다시 묻는 것이 좋다.";
  }
  return "교안 기준으로 사용자의 최근 답변은 아직 현재 module의 핵심 목표를 충분히 드러내지 않는다. 설명을 조금 보태고, 목표에 가까워지도록 한 번 더 유도하라.";
}

function buildSystemPrompt(module, payload) {
  const sourceChunks = module.source_chunk_ids
    .map((id) => chunkById(id))
    .filter(Boolean)
    .map((chunk) => `[${chunk.id}] ${chunk.text}`)
    .join("\n\n");
  const concepts = artifacts.concept_map
    .filter((concept) => module.concept_ids.includes(concept.id))
    .map((concept) => {
      return `- ${concept.name}: ${concept.definition}\n  왜 중요한가: ${concept.why_it_matters}\n  흔한 오해: ${(concept.misconceptions || []).join(" / ")}`;
    })
    .join("\n");

  return `당신은 러셀의 《서양철학사》 중 플라톤의 우주생성론을 가르치는 한국어 철학사 튜터다.

목표는 정해진 문항을 읽어 주는 것이 아니라, 사용자의 실제 반응을 보고 자연스럽게 설명하고 질문하며 원문으로 이끌어 가는 것이다. 정말 선생처럼 말하라. 내부 학습 목표나 시스템 용어를 사용자에게 노출하지 마라.

현재 course:
- 제목: ${artifacts.course_plan.title}
- 전체 audience: ${artifacts.course_plan.audience}

현재 module:
- id: ${module.id}
- 제목: ${module.title}
- 내부 학습 목표: ${module.learning_goal}
- 내부 hook 후보: ${module.hook}
- 내부 checkpoint 기준: ${module.checkpoint}
- 현재 phase: ${payload.phase || "start"}
- 완료한 module 수: ${(payload.completed || []).length}/${artifacts.course_plan.modules.length}
- course manager 판단: ${courseManagerHint(module, payload)}

관련 개념:
${concepts}

반드시 근거로 삼을 원문 조각:
${sourceChunks}

사용 가능한 visual id:
${[null, ...visualIds()].join(", ")}

응답 원칙:
- 한국어로 자연스럽게 5-9문장 정도 말하라. 필요하면 두 단락까지 가능하다.
- 첫 문장은 사용자의 실제 답변에 반응해야 한다. 시작 turn이면 자연스러운 도입으로 시작하라.
- "목표는 ...", "module", "checkpoint", "teaching point" 같은 내부 설계 문구를 화면 발화에 쓰지 마라.
- 사용자가 맞힌 부분은 구체적으로 짚고, 빗나간 부분은 부드럽게 교정하라.
- 원문 밖 지식을 길게 덧붙이지 말고, 필요하면 한 문장만 연결하라.
- 질문은 매번 새로 생성하라. 내부 hook/checkpoint 문장을 그대로 베끼지 마라.
- 한 turn에 질문은 하나만 던져라.
- 사용자가 충분히 이해했다고 판단되면 checkpoint_passed를 true로 하고, 다음 module로 넘어가자고 제안하라.
- 사용자가 아직 모호하거나 오해하면 checkpoint_passed를 false로 두고, 같은 개념을 다른 방식으로 다시 묻거나 힌트를 줘라.
- diagram은 관련 visual이 설명에 실제로 도움이 될 때만 선택하라. 반복적으로 남발하지 마라.

수업 진행 정책:
- start_module 이벤트에서는 수업을 자연스럽게 열고, 현재 module의 핵심 긴장을 드러내는 질문 하나로 끝내라. state_update.next_phase는 "discuss"로 둬라.
- user_message 이벤트에서는 사용자의 답이 현재 내부 학습 목표를 충분히 만족하는지 먼저 판단하라.
- 충분하면 새 주제로 옆길 질문을 만들지 말고, 왜 충분한지 짚은 뒤 checkpoint_passed=true, advance_module=true, next_phase="complete"로 둬라.
- 부족하면 현재 목표를 버리지 말고, 필요한 설명을 한 뒤 같은 목표를 다른 각도에서 다시 묻고 checkpoint_passed=false로 둬라.
- 사용자가 흥미로운 옆길을 열어도 한두 문장만 인정하고 현재 module의 목표로 되돌아와라.
- 한 module에서 같은 수준의 질문을 오래 반복하지 마라. 사용자가 핵심을 잡으면 과감히 다음 module로 이동시켜라.

반드시 JSON만 출력하라. 마크다운 코드펜스는 금지.
JSON schema:
{
  "message": "사용자에게 보여줄 자연스러운 튜터 발화",
  "diagram": "visual id 또는 null",
  "choices": ["짧은 응답 후보 0-3개"],
  "progress": 0부터 100 사이 정수,
  "module_id": "${module.id}",
  "source_refs": ["${module.source_chunk_ids.join('", "')} 중 하나 이상"],
  "state_update": {
    "next_phase": "orient | discuss | explain | check | remediate | complete",
    "checkpoint_passed": true 또는 false,
    "advance_module": true 또는 false,
    "detected_misconception": "없으면 null, 있으면 짧게"
  }
}`;
}

function buildUserPrompt(payload, module) {
  const event = payload.event || "user_message";
  if (event === "start_module") {
    return "새 module을 시작한다. 원문 맥락을 바탕으로 자연스럽게 도입하고, 사용자가 생각해 볼 질문 하나로 끝내라.";
  }
  const hint = courseManagerHint(module, payload);
  return `사용자 최근 발화:
${payload.userText || ""}

course manager 직접 지시:
${hint}

위 지시를 우선하라. 이 발화에 직접 반응한 뒤, 현재 module의 학습 목표를 지키면서 다음 한 걸음을 정하라.`;
}

function parseJsonFromText(text) {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON");
  }
}

function sanitizeTutorOutput(output, module, payload) {
  const allowedRefs = new Set(module.source_chunk_ids);
  const allowedVisuals = new Set(visualIds());
  const source_refs = Array.isArray(output.source_refs)
    ? output.source_refs.filter((id) => allowedRefs.has(id))
    : [];

  const completed = payload.completed || [];
  const moduleIndex = artifacts.course_plan.modules.findIndex((item) => item.id === module.id);
  const baseProgress = Math.round((completed.length / artifacts.course_plan.modules.length) * 100);
  const progress = Number.isFinite(output.progress)
    ? Math.max(baseProgress, Math.min(100, Math.round(output.progress)))
    : baseProgress;

  const best = keywordScore(payload.userText, module.best_keywords);
  const weak = keywordScore(payload.userText, module.misconception_keywords);
  const rubricSatisfied = payload.event === "user_message" && (best >= 2 || (best >= 1 && weak === 0));
  const nextPhase = rubricSatisfied
    ? "complete"
    : payload.event === "start_module" && (!output.state_update?.next_phase || output.state_update.next_phase === "orient")
    ? "discuss"
    : output.state_update?.next_phase || "discuss";

  return {
    message: String(output.message || "잠시만요. 이 대목을 다시 원문에 붙여서 생각해 봅시다."),
    diagram: allowedVisuals.has(output.diagram) ? output.diagram : null,
    choices: Array.isArray(output.choices) ? output.choices.slice(0, 3).map(String) : [],
    progress,
    module_id: module.id,
    source_refs: source_refs.length ? source_refs : module.source_chunk_ids.slice(0, 1),
    state_update: {
      next_phase: nextPhase,
      checkpoint_passed: rubricSatisfied || Boolean(output.state_update?.checkpoint_passed),
      advance_module: rubricSatisfied || Boolean(output.state_update?.advance_module),
      detected_misconception: output.state_update?.detected_misconception || null
    }
  };
}

async function callOpenAI(payload) {
  if (!OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set");
    error.status = 503;
    throw error;
  }

  const module = moduleById(payload.moduleId);
  const messages = [
    { role: "system", content: buildSystemPrompt(module, payload) },
    ...clampHistory(payload.history),
    { role: "user", content: buildUserPrompt(payload, module) }
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.75,
      response_format: { type: "json_object" },
      messages
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`OpenAI request failed: ${response.status} ${detail.slice(0, 500)}`);
    error.status = 502;
    throw error;
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  return sanitizeTutorOutput(parseJsonFromText(text), module, payload);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(ROOT, safePath);

  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, {
        provider: OPENAI_API_KEY ? "openai" : null,
        model: OPENAI_API_KEY ? OPENAI_MODEL : null,
        adaptive: Boolean(OPENAI_API_KEY)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tutor") {
      const payload = await readJson(req);
      const output = await callOpenAI(payload);
      sendJson(res, 200, output);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, { error: error.message || "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Adaptive test learning system running at http://localhost:${PORT}/`);
  console.log(OPENAI_API_KEY ? `Provider: OpenAI (${OPENAI_MODEL})` : "Provider: not configured. Set OPENAI_API_KEY.");
});
