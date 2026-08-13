import type { SourceFigure, VisualSpec } from "../shared/artifact-types";
import type { GroundedVisualSpec, LearningSectionIr, SourceSemanticIr } from "../shared/learning-ir-types";
import { sha256 } from "./learning-ir-validator";

const MAX_VISUALS_PER_SECTION = 2;
const MAX_VISUAL_NODES = 8;

function grounded(
  visual: VisualSpec,
  section: LearningSectionIr,
  nodeIds: string[],
  placement: GroundedVisualSpec["placement"] = "after_explanation",
): GroundedVisualSpec {
  const basis = { visual, sectionId: section.id, sourceChunkIds: section.sourceChunkIds, nodeIds, placement };
  return {
    ...visual,
    schemaVersion: 1,
    sectionId: section.id,
    sourceChunkIds: section.sourceChunkIds,
    nodeIds,
    placement,
    contentHash: sha256(basis),
  } as GroundedVisualSpec;
}

function relevantFigures(section: LearningSectionIr, figures: SourceFigure[]) {
  return figures.filter((figure) => figure.sourceChunkIds.some((id) => section.sourceChunkIds.includes(id)));
}

function visualForSection(ir: SourceSemanticIr, section: LearningSectionIr): GroundedVisualSpec | null {
  const concepts = ir.concepts.filter((concept) => section.conceptIds.includes(concept.id)).slice(0, MAX_VISUAL_NODES);
  const claims = ir.claims.filter((claim) => section.claimIds.includes(claim.id)).slice(0, MAX_VISUAL_NODES);
  const nodes = [...concepts.map((item) => item.id), ...claims.map((item) => item.id)].slice(0, MAX_VISUAL_NODES);
  if (nodes.length < 2) return null;
  const id = `visual-${sha256([ir.materialId, section.id, section.kind, nodes]).slice(0, 20)}`;

  if (section.kind === "comparative" && concepts.length >= 2) {
    return grounded({
      id,
      type: "contrast",
      title: section.title,
      left: { label: concepts[0]!.label, body: concepts[0]!.definition },
      right: { label: concepts[1]!.label, body: concepts[1]!.definition },
    }, section, nodes);
  }
  if (section.kind === "historical_narrative" && claims.length >= 2) {
    return grounded({
      id,
      type: "timeline",
      title: section.title,
      events: claims.map((claim, index) => ({ label: claim.statement, body: claim.role, marker: String(index + 1) })),
    }, section, nodes);
  }
  if (section.kind === "argument_reconstruction" || section.kind === "causal_mechanism" || section.kind === "procedural_technical") {
    const items = (claims.length ? claims.map((claim) => claim.statement) : concepts.map((concept) => concept.label)).slice(0, MAX_VISUAL_NODES);
    return grounded({ id, type: "flow", title: section.title, items }, section, nodes);
  }
  if (section.kind === "quantitative") return null;
  return grounded({ id, type: "layers", title: section.title, items: concepts.map((concept) => concept.label) }, section, nodes);
}

export function buildGroundedVisuals(ir: SourceSemanticIr, figures: SourceFigure[]): GroundedVisualSpec[] {
  const visuals: GroundedVisualSpec[] = [];
  for (const section of ir.sections) {
    // A real source figure grounded to the section is more faithful than a generated schematic.
    if (relevantFigures(section, figures).length) continue;
    const visual = visualForSection(ir, section);
    if (visual) visuals.push(visual);
    if (visuals.filter((item) => item.sectionId === section.id).length >= MAX_VISUALS_PER_SECTION) continue;
  }
  return visuals;
}

export function isGroundedVisual(value: VisualSpec): value is GroundedVisualSpec {
  const candidate = value as Partial<GroundedVisualSpec>;
  return candidate.schemaVersion === 1
    && typeof candidate.sectionId === "string"
    && Array.isArray(candidate.sourceChunkIds)
    && candidate.sourceChunkIds.length > 0
    && Array.isArray(candidate.nodeIds)
    && typeof candidate.contentHash === "string";
}
