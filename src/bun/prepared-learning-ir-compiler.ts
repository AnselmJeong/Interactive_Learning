import type { AiChatClient, ChatParams } from "./openai-compatible-client";
import {
  PREPARED_LEARNING_IR_COMPILER_VERSION,
  PREPARED_LEARNING_IR_PROMPT_VERSION,
  PREPARED_LEARNING_IR_SCHEMA_VERSION,
  type ArtifactQualityIssue,
  type LearningRelationType,
  type PreparedLearningConcept,
  type PreparedLearningIr,
  type PreparedLearningPedagogicalRole,
  type PreparedLearningRelation,
  type PreparedLearningStep,
} from "../shared/learning-ir-types";
import { canonicalJson, sha256 } from "./learning-ir-validator";

const MAX_MESSAGE_TEXT = 1_800;
const MAX_BATCH_CHARACTERS = 22_000;
const MAX_EXTRACTION_CONCURRENCY = 3;
const MAX_BATCH_CONCEPTS = 8;
const MAX_BATCH_RELATIONS = 12;
const MAX_CONCEPTS = 512;
const MAX_RELATIONS = 1_024;
const MAX_REDUCED_CONCEPTS = 24;
const MAX_REDUCED_RELATIONS = 48;
const COURSE_PHASE_COUNT = 4;
const RELATION_TYPES = new Set<LearningRelationType>([
  "supports",
  "challenges",
  "causes",
  "enables",
  "contrasts_with",
  "part_of",
  "precedes",
  "prerequisite_for",
  "explains",
]);
const ROLES = new Set<PreparedLearningPedagogicalRole>(["introduce", "explain", "connect", "contrast", "apply", "review"]);
const NON_CONCEPT_LABEL = /^(?:figure|fig\.?|table|chapter|section|introduction|conclusion|references|bibliography|\d+(?:\.\d+)*\s+(?:introduction|conclusion|summary))\b/i;
const GENERIC_SIGNIFICANCE = /(?:later questions?|core context|important context|basis for (?:later|subsequent)|이후 질문|핵심 문맥|근거가 되는)/i;
const KOREAN_TEXT = /[가-힣]/u;

export type PreparedLearningMessageInput = {
  id: string;
  routeIndex: number;
  moduleId: string;
  targetEvent: string;
  content: string;
  blocks: unknown[];
  sourceChunkIds: string[];
  visualId: string | null;
};

export type PreparedLearningIrRuntime = {
  client: AiChatClient;
  model: string;
};

export function preparedLearningMessageFingerprint(messages: PreparedLearningMessageInput[]) {
  return sha256(messages.map((message) => ({
    id: message.id,
    routeIndex: message.routeIndex,
    content: message.content,
    sourceChunkIds: message.sourceChunkIds,
    visualId: message.visualId,
  })));
}

type CandidateConcept = {
  key?: string;
  label?: string;
  definition?: string;
  learningSignificance?: string;
  messageIds?: string[];
  sourceChunkIds?: string[];
};

type CandidateRelation = {
  fromKey?: string;
  toKey?: string;
  fromLabel?: string;
  toLabel?: string;
  type?: LearningRelationType;
  explanation?: string;
  messageIds?: string[];
  sourceChunkIds?: string[];
};

type CandidateStep = {
  messageId?: string;
  role?: PreparedLearningPedagogicalRole;
  summary?: string;
  conceptKeys?: string[];
};

type CandidateFragment = {
  concepts?: CandidateConcept[];
  relations?: CandidateRelation[];
  steps?: CandidateStep[];
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function candidateItems(value: unknown): UnknownRecord[] {
  const values = Array.isArray(value) ? value : Object.values(record(value) || {});
  return values.map((item) => record(item)).filter((item): item is UnknownRecord => Boolean(item));
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function normalizeCandidateResponse(value: unknown): CandidateFragment {
  const outer = record(value) || {};
  const envelope = record(outer.result) || record(outer.data) || record(outer.learningIr) || record(outer.learning_ir) || outer;
  const nested = record(envelope.graph) || envelope;
  const conceptItems = candidateItems(nested.concepts || nested.nodes || nested.concept_nodes);
  const relationItems = candidateItems(nested.relations || nested.edges || nested.concept_relations);
  return {
    concepts: conceptItems.map((item) => ({
      key: String(item.key || item.conceptKey || item.concept_key || item.id || ""),
      label: String(item.label || item.name || item.concept || ""),
      definition: String(item.definition || item.description || ""),
      learningSignificance: String(item.learningSignificance || item.learning_significance || item.significance || item.whyItMatters || item.why_it_matters || ""),
      messageIds: stringArray(item.messageIds || item.message_ids || item.evidenceMessageIds || item.evidence_message_ids),
      sourceChunkIds: stringArray(item.sourceChunkIds || item.source_chunk_ids),
    })),
    relations: relationItems.map((item) => ({
      fromKey: String(item.fromKey || item.from_key || item.sourceKey || item.source_key || ""),
      toKey: String(item.toKey || item.to_key || item.targetKey || item.target_key || ""),
      fromLabel: String(item.fromLabel || item.from_label || item.sourceLabel || item.source_label || ""),
      toLabel: String(item.toLabel || item.to_label || item.targetLabel || item.target_label || ""),
      type: String(item.type || item.relationType || item.relation_type || "") as LearningRelationType,
      explanation: String(item.explanation || item.description || ""),
      messageIds: stringArray(item.messageIds || item.message_ids || item.evidenceMessageIds || item.evidence_message_ids),
      sourceChunkIds: stringArray(item.sourceChunkIds || item.source_chunk_ids),
    })),
  };
}

function mergeCandidateFragments(...fragments: CandidateFragment[]): CandidateFragment {
  return {
    concepts: fragments.flatMap((fragment) => fragment.concepts || []),
    relations: fragments.flatMap((fragment) => fragment.relations || []),
    steps: fragments.flatMap((fragment) => fragment.steps || []),
  };
}

function isOutputTokenLimitError(error: unknown) {
  return /(?:finish_reason\s*[=:]\s*length|output token limit|max(?:imum)?[_ -]?tokens)/i.test(String((error as Error)?.message || error));
}

function compact(value: string, max: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trim()}…`;
}

function identity(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function uniqueAllowed(values: unknown, allowed: Set<string>) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === "string" && allowed.has(value)))];
}

function batches(messages: PreparedLearningMessageInput[]) {
  const result: PreparedLearningMessageInput[][] = [];
  let current: PreparedLearningMessageInput[] = [];
  let characters = 0;
  for (const message of messages) {
    const length = Math.min(message.content.length, MAX_MESSAGE_TEXT) + 240;
    if (current.length && characters + length > MAX_BATCH_CHARACTERS) {
      result.push(current);
      current = [];
      characters = 0;
    }
    current.push(message);
    characters += length;
  }
  if (current.length) result.push(current);
  return result;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  transform: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await transform(items[index]!, index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    () => worker(),
  ));
  return results;
}

function messagePayload(messages: PreparedLearningMessageInput[]) {
  return messages.map((message) => ({
    id: message.id,
    routeIndex: message.routeIndex,
    moduleId: message.moduleId,
    targetEvent: message.targetEvent,
    content: compact(message.content, MAX_MESSAGE_TEXT),
    sourceChunkIds: message.sourceChunkIds,
    visualId: message.visualId,
  }));
}

async function extractFragment(
  runtime: PreparedLearningIrRuntime,
  messages: PreparedLearningMessageInput[],
): Promise<CandidateFragment> {
  const request: ChatParams = {
    model: runtime.model,
    temperature: 0.1,
    maxTokens: 5_500,
    timeoutMs: 180_000,
    thinking: "disabled" as const,
    messages: [
      {
        role: "system",
        content: [
          "Extract what these completed tutor messages actually teach. Return JSON with concepts and relations only.",
          "A concept is a domain entity, model, process, mechanism, variable, or distinction needed to understand an explanation.",
          "Section titles, chapter titles, introductory paragraphs, quotations, figures, captions, and message headings are not concepts.",
          "Do not create a concept merely because a word appears. It must be substantively explained in at least one supplied message.",
          "Every concept needs a specific definition, a non-generic learningSignificance, messageIds, and sourceChunkIds already attached to those messages.",
          "Every relation must connect two extracted concept keys and state the specific relationship explained by the messages.",
          "Write every label, definition, learningSignificance, and relation explanation in Korean. Put an established English technical term after its Korean name in parentheses only when useful.",
          `Return at most ${MAX_BATCH_CONCEPTS} concepts and ${MAX_BATCH_RELATIONS} relations. Keep definitions, significance, and explanations to one concise sentence each.`,
          'Use exactly this JSON shape: {"concepts":[{"key":"c1","label":"...","definition":"...","learningSignificance":"...","messageIds":["exact supplied id"],"sourceChunkIds":["exact supplied id"]}],"relations":[{"fromKey":"c1","toKey":"c2","type":"explains","explanation":"...","messageIds":["exact supplied id"],"sourceChunkIds":["exact supplied id"]}]}.',
          "Do not force a relation or invent a fallback. Omit anything not supported by the completed messages.",
          "Relation types: supports, challenges, causes, enables, contrasts_with, part_of, precedes, prerequisite_for, explains.",
          "Do not return per-message steps or repeat the supplied message text.",
          "Use short local concept keys such as c1. Preserve formulas with $...$ delimiters. Do not return paths, markdown images, coordinates, HTML, SVG, or Mermaid.",
        ].join(" "),
      },
      { role: "user", content: JSON.stringify(messagePayload(messages)) },
    ],
  };
  let response: unknown;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await runtime.client.chatJson(request);
      break;
    } catch (error) {
      lastError = error;
      if (isOutputTokenLimitError(error) && messages.length > 1) {
        const midpoint = Math.ceil(messages.length / 2);
        const left = await extractFragment(runtime, messages.slice(0, midpoint));
        const right = await extractFragment(runtime, messages.slice(midpoint));
        return mergeCandidateFragments(left, right);
      }
    }
  }
  if (!response && lastError) throw lastError;
  if (!response || typeof response !== "object") throw new Error("Learning IR extraction returned no object");
  return normalizeCandidateResponse(response);
}

function normalizeFragments(fragments: CandidateFragment[], messages: PreparedLearningMessageInput[]) {
  const messageIds = new Set(messages.map((message) => message.id));
  const chunkIdsByMessage = new Map(messages.map((message) => [message.id, new Set(message.sourceChunkIds)]));
  const concepts: CandidateConcept[] = [];
  const relations: CandidateRelation[] = [];
  const steps: CandidateStep[] = [];

  for (const fragment of fragments) {
    const localConcepts = new Map<string, CandidateConcept>();
    for (const raw of (Array.isArray(fragment.concepts) ? fragment.concepts : []).slice(0, MAX_BATCH_CONCEPTS)) {
      const label = compact(String(raw.label || ""), 120);
      const definition = compact(String(raw.definition || ""), 600);
      const learningSignificance = compact(String(raw.learningSignificance || ""), 600);
      const evidenceMessageIds = uniqueAllowed(raw.messageIds, messageIds);
      const allowedChunks = new Set(evidenceMessageIds.flatMap((id) => [...(chunkIdsByMessage.get(id) || [])]));
      const suppliedChunks = uniqueAllowed(raw.sourceChunkIds, allowedChunks);
      const sourceChunkIds = suppliedChunks.length ? suppliedChunks : [...allowedChunks];
      if (!raw.key || !label || !definition || !learningSignificance || !evidenceMessageIds.length || !sourceChunkIds.length) continue;
      if (!KOREAN_TEXT.test(label) || !KOREAN_TEXT.test(definition) || !KOREAN_TEXT.test(learningSignificance)) continue;
      if (NON_CONCEPT_LABEL.test(label) || GENERIC_SIGNIFICANCE.test(learningSignificance)) continue;
      const normalized = { ...raw, label, definition, learningSignificance, messageIds: evidenceMessageIds, sourceChunkIds };
      localConcepts.set(raw.key, normalized);
      concepts.push(normalized);
    }
    for (const raw of (Array.isArray(fragment.relations) ? fragment.relations : []).slice(0, MAX_BATCH_RELATIONS)) {
      const from = raw.fromKey ? localConcepts.get(raw.fromKey) : undefined;
      const to = raw.toKey ? localConcepts.get(raw.toKey) : undefined;
      const explanation = compact(String(raw.explanation || ""), 500);
      const evidenceMessageIds = uniqueAllowed(raw.messageIds, messageIds);
      const allowedChunks = new Set(evidenceMessageIds.flatMap((id) => [...(chunkIdsByMessage.get(id) || [])]));
      const suppliedChunks = uniqueAllowed(raw.sourceChunkIds, allowedChunks);
      const sourceChunkIds = suppliedChunks.length ? suppliedChunks : [...allowedChunks];
      if (!from?.label || !to?.label || !raw.type || !RELATION_TYPES.has(raw.type) || !explanation || !KOREAN_TEXT.test(explanation) || !evidenceMessageIds.length || !sourceChunkIds.length) continue;
      relations.push({
        ...raw,
        fromLabel: from.label,
        toLabel: to.label,
        explanation,
        messageIds: evidenceMessageIds,
        sourceChunkIds,
      });
    }
    for (const raw of Array.isArray(fragment.steps) ? fragment.steps : []) {
      if (!raw.messageId || !messageIds.has(raw.messageId)) continue;
      steps.push({
        ...raw,
        role: raw.role && ROLES.has(raw.role) ? raw.role : "explain",
        summary: compact(String(raw.summary || ""), 300),
        conceptKeys: Array.isArray(raw.conceptKeys)
          ? raw.conceptKeys.flatMap((key) => localConcepts.get(key)?.label || [])
          : [],
      });
    }
  }
  return { concepts, relations, steps };
}

function roundRobin<T>(groups: T[][], limit: number) {
  const result: T[] = [];
  for (let index = 0; result.length < limit; index += 1) {
    let added = false;
    for (const group of groups) {
      if (group[index] === undefined) continue;
      result.push(group[index]!);
      added = true;
      if (result.length >= limit) break;
    }
    if (!added) break;
  }
  return result;
}

function candidateCoursePhase(candidate: Pick<CandidateConcept, "messageIds">, messagePosition: Map<string, number>, messageCount: number) {
  const firstPosition = (candidate.messageIds || []).reduce(
    (earliest, id) => Math.min(earliest, messagePosition.get(id) ?? Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );
  if (!Number.isFinite(firstPosition) || firstPosition === Number.MAX_SAFE_INTEGER) return 0;
  return Math.min(COURSE_PHASE_COUNT - 1, Math.floor(firstPosition * COURSE_PHASE_COUNT / Math.max(1, messageCount)));
}

function prepareBalancedReductionCandidates(
  normalized: ReturnType<typeof normalizeFragments>,
  messages: PreparedLearningMessageInput[],
) {
  const messagePosition = new Map(messages.map((message, index) => [message.id, index]));
  const mergedConcepts = new Map<string, CandidateConcept>();
  for (const concept of normalized.concepts) {
    const key = identity(String(concept.label || ""));
    if (!key) continue;
    const existing = mergedConcepts.get(key);
    if (!existing) {
      mergedConcepts.set(key, { ...concept, messageIds: [...(concept.messageIds || [])], sourceChunkIds: [...(concept.sourceChunkIds || [])] });
      continue;
    }
    const preferIncoming = (concept.messageIds?.length || 0) > (existing.messageIds?.length || 0);
    mergedConcepts.set(key, {
      ...(preferIncoming ? concept : existing),
      messageIds: [...new Set([...(existing.messageIds || []), ...(concept.messageIds || [])])],
      sourceChunkIds: [...new Set([...(existing.sourceChunkIds || []), ...(concept.sourceChunkIds || [])])],
    });
  }

  const conceptGroups = Array.from({ length: COURSE_PHASE_COUNT }, () => [] as CandidateConcept[]);
  for (const concept of mergedConcepts.values()) {
    conceptGroups[candidateCoursePhase(concept, messagePosition, messages.length)]!.push(concept);
  }
  for (const group of conceptGroups) {
    group.sort((left, right) => (messagePosition.get(left.messageIds?.[0] || "") ?? Number.MAX_SAFE_INTEGER)
        - (messagePosition.get(right.messageIds?.[0] || "") ?? Number.MAX_SAFE_INTEGER));
  }
  const concepts = roundRobin(
    conceptGroups,
    mergedConcepts.size,
  );
  const selectedLabels = new Set(concepts.map((concept) => identity(String(concept.label || ""))));

  const mergedRelations = new Map<string, CandidateRelation>();
  for (const relation of normalized.relations) {
    const from = identity(String(relation.fromLabel || ""));
    const to = identity(String(relation.toLabel || ""));
    if (!selectedLabels.has(from) || !selectedLabels.has(to)) continue;
    const key = `${from}\u0000${to}\u0000${relation.type || ""}`;
    const existing = mergedRelations.get(key);
    mergedRelations.set(key, existing ? {
      ...existing,
      messageIds: [...new Set([...(existing.messageIds || []), ...(relation.messageIds || [])])],
      sourceChunkIds: [...new Set([...(existing.sourceChunkIds || []), ...(relation.sourceChunkIds || [])])],
    } : { ...relation });
  }
  const relationGroups = Array.from({ length: COURSE_PHASE_COUNT }, () => [] as CandidateRelation[]);
  for (const relation of mergedRelations.values()) {
    relationGroups[candidateCoursePhase(relation, messagePosition, messages.length)]!.push(relation);
  }
  const relations = roundRobin(
    relationGroups,
    mergedRelations.size,
  );
  return { concepts, relations, steps: normalized.steps };
}

function hasBalancedCourseCoverage(
  candidate: CandidateFragment,
  balanced: ReturnType<typeof prepareBalancedReductionCandidates>,
  messages: PreparedLearningMessageInput[],
) {
  const messagePosition = new Map(messages.map((message, index) => [message.id, index]));
  const countByPhase = (concepts: CandidateConcept[]) => {
    const counts = Array.from({ length: COURSE_PHASE_COUNT }, () => 0);
    for (const concept of concepts) counts[candidateCoursePhase(concept, messagePosition, messages.length)]! += 1;
    return counts;
  };
  const available = countByPhase(balanced.concepts);
  const selected = countByPhase(Array.isArray(candidate.concepts) ? candidate.concepts : []);
  return available.every((count, phase) => selected[phase]! >= Math.min(3, count));
}

function completeCourseGraph(
  balanced: ReturnType<typeof prepareBalancedReductionCandidates>,
  reduced?: CandidateFragment,
) {
  const concepts = balanced.concepts;
  const labels = new Set(concepts.map((concept) => identity(String(concept.label || ""))));
  const relationByIdentity = new Map<string, CandidateRelation>();
  for (const relation of [...balanced.relations, ...(reduced?.relations || [])]) {
    const from = identity(String(relation.fromLabel || ""));
    const to = identity(String(relation.toLabel || ""));
    if (!labels.has(from) || !labels.has(to)) continue;
    const key = `${from}\u0000${to}\u0000${relation.type || ""}`;
    const existing = relationByIdentity.get(key);
    relationByIdentity.set(key, existing ? {
      ...existing,
      messageIds: [...new Set([...(existing.messageIds || []), ...(relation.messageIds || [])])],
      sourceChunkIds: [...new Set([...(existing.sourceChunkIds || []), ...(relation.sourceChunkIds || [])])],
    } : relation);
  }
  return { concepts, relations: [...relationByIdentity.values()] };
}

async function reduceGlobally(
  runtime: PreparedLearningIrRuntime,
  normalized: ReturnType<typeof normalizeFragments>,
  messages: PreparedLearningMessageInput[],
) {
  const request: ChatParams = {
    model: runtime.model,
    temperature: 0.1,
    maxTokens: 6_500,
    timeoutMs: 180_000,
    thinking: "disabled" as const,
    messages: [
      {
        role: "system",
        content: [
          "Reduce candidate teaching concepts into one compact learning graph of what the completed message set actually taught.",
          `Return at most ${MAX_REDUCED_CONCEPTS} cross-course anchor concepts and ${MAX_REDUCED_RELATIONS} meaningful relations. This response enriches the full graph; it does not replace the complete candidate set.`,
          "The candidates are balanced across four consecutive course phases. Keep at least three concepts from every phase that has candidates; do not fill the graph from the opening phase only.",
          "Merge duplicate labels, but do not merge distinct technical concepts. Prefer concepts that participate in explained relations or recur across messages.",
          "Never use chapter/section titles, figures, captions, quotations, or opening paragraphs as concepts.",
          "Write every learner-facing field in Korean. An English technical term may appear only after its Korean name in parentheses. Keep formulas inside $...$ delimiters.",
          "Return concepts with label, definition, learningSignificance, messageIds, sourceChunkIds.",
          "Return relations with fromLabel, toLabel, type, explanation, messageIds, sourceChunkIds.",
          "IDs and source refs must come from the candidates. Do not invent evidence or add generic importance statements.",
          'Use exactly this JSON shape: {"concepts":[{"label":"...","definition":"...","learningSignificance":"...","messageIds":["exact candidate id"],"sourceChunkIds":["exact candidate id"]}],"relations":[{"fromLabel":"...","toLabel":"...","type":"explains","explanation":"...","messageIds":["exact candidate id"],"sourceChunkIds":["exact candidate id"]}]}.',
          "If the messages do not support a connected learning graph, return fewer items; never fill a quota.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          candidateConcepts: normalized.concepts,
          candidateRelations: normalized.relations,
          messageOrder: messages.map((message) => ({ id: message.id, routeIndex: message.routeIndex, sourceChunkIds: message.sourceChunkIds })),
        }),
      },
    ],
  };
  let response: unknown;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await runtime.client.chatJson({
        ...request,
        maxTokens: attempt === 0 ? request.maxTokens : 9_000,
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!response && lastError) throw lastError;
  if (!response || typeof response !== "object") throw new Error("Learning IR reduction returned no object");
  return normalizeCandidateResponse(response);
}

function validateReduced(
  candidate: CandidateFragment,
  messages: PreparedLearningMessageInput[],
  materialId: string,
  messageSetId: string,
) {
  const issues: ArtifactQualityIssue[] = [];
  const messageIds = new Set(messages.map((message) => message.id));
  const messageOrder = new Map(messages.map((message) => [message.id, message.routeIndex]));
  const chunkIdsByMessage = new Map(messages.map((message) => [message.id, new Set(message.sourceChunkIds)]));
  const concepts: PreparedLearningConcept[] = [];
  const conceptByIdentity = new Map<string, PreparedLearningConcept>();

  for (const raw of (Array.isArray(candidate.concepts) ? candidate.concepts : []).slice(0, MAX_CONCEPTS)) {
    const label = compact(String(raw.label || ""), 120);
    const definition = compact(String(raw.definition || ""), 600);
    const learningSignificance = compact(String(raw.learningSignificance || ""), 600);
    const evidenceMessageIds = uniqueAllowed(raw.messageIds, messageIds).sort((a, b) => (messageOrder.get(a) || 0) - (messageOrder.get(b) || 0));
    const allowedChunks = new Set(evidenceMessageIds.flatMap((id) => [...(chunkIdsByMessage.get(id) || [])]));
    const sourceChunkIds = uniqueAllowed(raw.sourceChunkIds, allowedChunks);
    const key = identity(label);
    if (!key || conceptByIdentity.has(key) || !definition || !learningSignificance || !KOREAN_TEXT.test(label) || !KOREAN_TEXT.test(definition) || !KOREAN_TEXT.test(learningSignificance) || !evidenceMessageIds.length || !sourceChunkIds.length || NON_CONCEPT_LABEL.test(label) || GENERIC_SIGNIFICANCE.test(learningSignificance)) {
      issues.push({ code: "invalid_schema", stage: "prepared_learning_ir", message: `Rejected non-concept or ungrounded item: ${label || "unnamed"}` });
      continue;
    }
    const id = `taught-concept-${sha256([messageSetId, key, evidenceMessageIds]).slice(0, 20)}`;
    const concept: PreparedLearningConcept = {
      id,
      label,
      definition,
      learningSignificance,
      firstIntroducedMessageId: evidenceMessageIds[0]!,
      reinforcedMessageIds: evidenceMessageIds.slice(1),
      sourceChunkIds,
    };
    concepts.push(concept);
    conceptByIdentity.set(key, concept);
  }

  const relations: PreparedLearningRelation[] = [];
  const relationKeys = new Set<string>();
  for (const raw of (Array.isArray(candidate.relations) ? candidate.relations : []).slice(0, MAX_RELATIONS)) {
    const from = conceptByIdentity.get(identity(String(raw.fromLabel || "")));
    const to = conceptByIdentity.get(identity(String(raw.toLabel || "")));
    const explanation = compact(String(raw.explanation || ""), 500);
    const evidenceMessageIds = uniqueAllowed(raw.messageIds, messageIds);
    const allowedChunks = new Set(evidenceMessageIds.flatMap((id) => [...(chunkIdsByMessage.get(id) || [])]));
    const sourceChunkIds = uniqueAllowed(raw.sourceChunkIds, allowedChunks);
    const key = `${from?.id || ""}\u0000${to?.id || ""}\u0000${raw.type || ""}`;
    if (!from || !to || from.id === to.id || !raw.type || !RELATION_TYPES.has(raw.type) || !explanation || !KOREAN_TEXT.test(explanation) || !evidenceMessageIds.length || !sourceChunkIds.length || relationKeys.has(key)) {
      issues.push({ code: "invalid_edge", stage: "prepared_learning_ir", message: "Rejected an ungrounded or duplicate taught relation." });
      continue;
    }
    relationKeys.add(key);
    relations.push({
      id: `taught-relation-${sha256([messageSetId, key, evidenceMessageIds]).slice(0, 20)}`,
      fromConceptId: from.id,
      toConceptId: to.id,
      type: raw.type,
      explanation,
      messageIds: evidenceMessageIds,
      sourceChunkIds,
    });
  }
  if (concepts.length < 2 || relations.length < 1) {
    issues.push({ code: "invalid_edge", stage: "prepared_learning_ir", message: "Completed messages did not support a meaningful concept relationship graph." });
  }
  return { materialId, concepts, relations, issues };
}

function defaultRole(targetEvent: string): PreparedLearningPedagogicalRole {
  if (targetEvent === "start_module") return "introduce";
  if (targetEvent === "finish_prompt") return "review";
  return "explain";
}

export async function compilePreparedLearningIr(input: {
  materialId: string;
  messageSetId: string;
  messages: PreparedLearningMessageInput[];
  runtime: PreparedLearningIrRuntime;
  generatedAt?: string;
}): Promise<PreparedLearningIr> {
  if (!input.messages.length) throw new Error("A completed message set contains no prepared messages");
  const messageBatches = batches(input.messages);
  const fragments = await mapWithConcurrency(
    messageBatches,
    MAX_EXTRACTION_CONCURRENCY,
    (batch) => extractFragment(input.runtime, batch),
  );
  const normalized = normalizeFragments(fragments, input.messages);
  const balanced = prepareBalancedReductionCandidates(normalized, input.messages);
  let reduced: CandidateFragment;
  try {
    reduced = await reduceGlobally(input.runtime, balanced, input.messages);
  } catch (error) {
    if (!isOutputTokenLimitError(error)) throw error;
    reduced = { concepts: [], relations: [] };
  }
  const reducedHasGraph = Array.isArray(reduced.concepts)
    && reduced.concepts.length >= 2
    && Array.isArray(reduced.relations)
    && reduced.relations.length >= 1;
  const reducedCoversCourse = reducedHasGraph && hasBalancedCourseCoverage(reduced, balanced, input.messages);
  const groundedCandidate = completeCourseGraph(balanced, reducedCoversCourse ? reduced : undefined);
  const validated = validateReduced(groundedCandidate, input.messages, input.materialId, input.messageSetId);
  const finalConceptIds = new Set(validated.concepts.map((concept) => concept.id));
  const conceptByLabel = new Map(validated.concepts.map((concept) => [identity(concept.label), concept.id]));
  const stepCandidateByMessage = new Map(normalized.steps.map((step) => [step.messageId, step]));
  const steps: PreparedLearningStep[] = input.messages.map((message) => {
    const candidate = stepCandidateByMessage.get(message.id);
    const conceptIds = [...new Set([
      ...(candidate?.conceptKeys || []).map((label) => conceptByLabel.get(identity(label))),
      ...validated.concepts.filter((concept) => concept.firstIntroducedMessageId === message.id || concept.reinforcedMessageIds.includes(message.id)).map((concept) => concept.id),
    ].filter((id): id is string => Boolean(id && finalConceptIds.has(id))))];
    const relationIds = validated.relations.filter((relation) => relation.messageIds.includes(message.id)).map((relation) => relation.id);
    return {
      messageId: message.id,
      routeIndex: message.routeIndex,
      moduleId: message.moduleId,
      role: candidate?.role && ROLES.has(candidate.role) ? candidate.role : defaultRole(message.targetEvent),
      summary: candidate?.summary || compact(message.content, 300),
      conceptIds,
      relationIds,
      sourceChunkIds: message.sourceChunkIds,
      visualId: message.visualId,
    };
  });
  const messageSetFingerprint = preparedLearningMessageFingerprint(input.messages);
  const rejectedItemCount = validated.issues.length;
  return JSON.parse(canonicalJson({
    schemaVersion: PREPARED_LEARNING_IR_SCHEMA_VERSION,
    materialId: input.materialId,
    messageSetId: input.messageSetId,
    messageSetFingerprint,
    generatedAt: input.generatedAt || new Date().toISOString(),
    generator: {
      model: input.runtime.model,
      compilerVersion: PREPARED_LEARNING_IR_COMPILER_VERSION,
      promptVersion: PREPARED_LEARNING_IR_PROMPT_VERSION,
    },
    concepts: validated.concepts,
    relations: validated.relations,
    steps,
    quality: {
      status: validated.concepts.length >= 2 && validated.relations.length >= 1 ? (validated.issues.length ? "warning" : "good") : "degraded",
      issues: validated.issues,
      acceptedItemCount: validated.concepts.length + validated.relations.length + steps.length,
      rejectedItemCount,
    },
  })) as PreparedLearningIr;
}
