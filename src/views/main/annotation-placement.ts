import type { MaterialAnnotation } from "../../shared/artifact-types";
import type { TutorMessage } from "../../shared/tutor-types";
import { isFigureExplanationAnnotation } from "./figure-annotations";

export type AnnotationPlacement = {
  groups: Map<string, MaterialAnnotation[]>;
  blockGroups: Map<string, MaterialAnnotation[]>;
  unplaced: MaterialAnnotation[];
};

export function annotationHasAnchor(annotation: MaterialAnnotation) {
  return Boolean(annotation.anchorMessageId || annotation.anchorBlockId);
}

function isChatAnnotation(annotation: MaterialAnnotation) {
  return annotation.surface === "chat" || annotationHasAnchor(annotation);
}

export function shouldRenderSourceAnnotationCard(annotation: MaterialAnnotation) {
  if (annotation.kind === "highlight" || annotation.kind === "note") return false;
  if (isFigureExplanationAnnotation(annotation)) return false;
  return annotation.surface === "source" && !annotationHasAnchor(annotation);
}

export function shouldRenderChatAnnotationCard(annotation: MaterialAnnotation) {
  return annotation.kind !== "highlight" && isChatAnnotation(annotation);
}

export function shouldRenderInlineAnnotation(annotation: MaterialAnnotation) {
  if (!annotation.selectedText?.trim()) return false;
  if (isFigureExplanationAnnotation(annotation)) return false;
  return annotation.kind === "highlight" || annotation.kind === "note" || annotation.kind === "lookup" || annotation.kind === "question" || annotation.kind === "image" || annotation.kind === "define";
}

export function placeAnnotationsForMessages(annotations: MaterialAnnotation[], messages: TutorMessage[]): AnnotationPlacement {
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const assistantMessageIds = new Set(assistantMessages.map((message) => message.id));
  const visibleBlockIds = new Set<string>();
  const groups = new Map<string, MaterialAnnotation[]>();
  const blockGroups = new Map<string, MaterialAnnotation[]>();

  for (const message of assistantMessages) {
    message.blocks?.forEach((_, index) => {
      visibleBlockIds.add(`${message.id}:block-${index}`);
    });
  }

  function add(messageId: string, annotation: MaterialAnnotation) {
    const group = groups.get(messageId) || [];
    group.push(annotation);
    groups.set(messageId, group);
  }

  function addBlock(blockId: string, annotation: MaterialAnnotation) {
    const group = blockGroups.get(blockId) || [];
    group.push(annotation);
    blockGroups.set(blockId, group);
  }

  for (const annotation of annotations) {
    if (!shouldRenderChatAnnotationCard(annotation)) continue;
    if (annotation.anchorBlockId && visibleBlockIds.has(annotation.anchorBlockId)) {
      addBlock(annotation.anchorBlockId, annotation);
      continue;
    }
    if (annotation.anchorMessageId && assistantMessageIds.has(annotation.anchorMessageId)) {
      add(annotation.anchorMessageId, annotation);
    }
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.createdAt - b.createdAt);
  }
  for (const group of blockGroups.values()) {
    group.sort((a, b) => a.createdAt - b.createdAt);
  }
  const unplaced: MaterialAnnotation[] = [];
  return { groups, blockGroups, unplaced };
}
