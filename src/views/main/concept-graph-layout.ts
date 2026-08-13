import type { PreparedLearningConcept, PreparedLearningRelation } from "../../shared/learning-ir-types";

export type ConceptGraphLayoutNode = {
  id: string;
  x: number;
  y: number;
  layer: number;
  order: number;
};

export type ConceptGraphLayout = {
  width: number;
  height: number;
  nodes: ConceptGraphLayoutNode[];
  relations: PreparedLearningRelation[];
  truncated: boolean;
};

export type ConceptNodeBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ConceptRelationRoute = {
  start: { x: number; y: number };
  end: { x: number; y: number };
  label: { x: number; y: number };
};

export function routeConceptRelation(from: ConceptNodeBounds, to: ConceptNodeBounds): ConceptRelationRoute {
  const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
    return { start: fromCenter, end: toCenter, label: fromCenter };
  }

  const boundaryScale = (bounds: ConceptNodeBounds) => Math.min(
    Math.abs(dx) < 0.001 ? Number.POSITIVE_INFINITY : bounds.width / 2 / Math.abs(dx),
    Math.abs(dy) < 0.001 ? Number.POSITIVE_INFINITY : bounds.height / 2 / Math.abs(dy),
  );
  const fromScale = boundaryScale(from);
  const toScale = boundaryScale(to);
  const start = { x: fromCenter.x + dx * fromScale, y: fromCenter.y + dy * fromScale };
  const end = { x: toCenter.x - dx * toScale, y: toCenter.y - dy * toScale };
  return {
    start,
    end,
    label: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
  };
}

export function layoutConceptGraph(
  concepts: PreparedLearningConcept[],
  relations: PreparedLearningRelation[],
  messageOrder: Map<string, number>,
): ConceptGraphLayout {
  const ordered = [...concepts]
    .sort((left, right) => (messageOrder.get(left.firstIntroducedMessageId) ?? Number.MAX_SAFE_INTEGER)
      - (messageOrder.get(right.firstIntroducedMessageId) ?? Number.MAX_SAFE_INTEGER));
  const ids = new Set(ordered.map((concept) => concept.id));
  const graphRelations = relations
    .filter((relation) => ids.has(relation.fromConceptId) && ids.has(relation.toConceptId));
  const sequence = new Map(ordered.map((concept, index) => [concept.id, index]));
  const layer = new Map(ordered.map((concept) => [concept.id, 0]));

  // The message sequence breaks semantic cycles deterministically. An edge still
  // keeps its real direction; only the visual layer follows first teaching order.
  for (const relation of graphRelations) {
    const fromOrder = sequence.get(relation.fromConceptId) ?? 0;
    const toOrder = sequence.get(relation.toConceptId) ?? 0;
    const earlier = fromOrder <= toOrder ? relation.fromConceptId : relation.toConceptId;
    const later = earlier === relation.fromConceptId ? relation.toConceptId : relation.fromConceptId;
    layer.set(later, Math.min(5, Math.max(layer.get(later) || 0, (layer.get(earlier) || 0) + 1)));
  }

  const byLayer = new Map<number, PreparedLearningConcept[]>();
  for (const concept of ordered) {
    const value = layer.get(concept.id) || 0;
    const items = byLayer.get(value) || [];
    items.push(concept);
    byLayer.set(value, items);
  }
  const maxLayer = Math.max(0, ...byLayer.keys());
  const maxRows = Math.max(1, ...[...byLayer.values()].map((items) => items.length));
  const width = Math.max(680, (maxLayer + 1) * 220);
  const height = Math.max(330, maxRows * 120);
  const nodes = [...byLayer.entries()].flatMap(([layerIndex, items]) => items.map((concept, order) => ({
    id: concept.id,
    layer: layerIndex,
    order,
    x: 52 + layerIndex * ((width - 220) / Math.max(1, maxLayer)),
    y: 44 + order * ((height - 100) / Math.max(1, items.length - 1)),
  })));
  return {
    width,
    height,
    nodes,
    relations: graphRelations,
    truncated: false,
  };
}
