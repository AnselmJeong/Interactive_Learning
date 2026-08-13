import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform, type ZoomBehavior } from "d3-zoom";
import { LocateFixed, MessageSquareText, RotateCcw } from "lucide-react";
import type { LearningRelationType, PreparedLearningConcept, PreparedLearningIr, PreparedLearningRelation } from "../../../shared/learning-ir-types";
import { routeConceptRelation } from "../concept-graph-layout";
import { InlineMarkdownContent, MarkdownContent } from "./MarkdownContent";

const RELATION_LABEL: Record<LearningRelationType, string> = {
  supports: "뒷받침",
  challenges: "반박·수정",
  causes: "원인",
  enables: "가능하게 함",
  contrasts_with: "대조",
  part_of: "구성 관계",
  precedes: "선행",
  prerequisite_for: "이해의 전제",
  explains: "설명",
};

const NODE_WIDTH = 208;
const NODE_HEIGHT = 92;

export function isConceptGraphZoomEvent(event: Pick<Event, "type"> & { button?: number }) {
  return event.type === "wheel" || event.button === 1;
}

export function compactConceptNodeLabel(label: string) {
  const match = label.match(/^(.*?)\s*\(([^()]*)\)\s*$/u);
  if (!match) return label;
  const [, primary = label, parenthetical = ""] = match;
  if (!/[A-Za-z]/u.test(parenthetical) || /[$\\]/u.test(parenthetical)) return label;
  const visualUnits = Array.from(label).reduce((total, character) => {
    if (/\s/u.test(character)) return total + 0.35;
    if (/[\x00-\x7f]/u.test(character)) return total + 0.55;
    return total + 1;
  }, 0);
  return Math.ceil(visualUnits / 11) > 3 ? primary.trim() : label;
}

const CONCEPT_NODE_MATH_SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", theta: "θ", lambda: "λ", mu: "μ",
  sigma: "σ", tau: "τ", omega: "ω", Delta: "Δ", Gamma: "Γ", Omega: "Ω",
  leq: "≤", geq: "≥", neq: "≠", approx: "≈", sim: "∼", pm: "±", times: "×", cdot: "·",
};

function plainMathFormula(formula: string) {
  return formula
    .trim()
    .replace(/\\(?:mathrm|mathbf|mathit|text|operatorname)\{([^{}]*)\}/gu, "$1")
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/gu, "$1/$2")
    .replace(/\\dot\{([^{}]*)\}/gu, "$1̇")
    .replace(/_\{([^{}]*)\}/gu, "_$1")
    .replace(/\^\{([^{}]*)\}/gu, "^$1")
    .replace(/\\([A-Za-z]+)/gu, (_, command: string) => CONCEPT_NODE_MATH_SYMBOLS[command] || command)
    .replace(/[{}]/gu, "")
    .replace(/\s+/gu, " ");
}

export function plainConceptNodeLabel(label: string) {
  return compactConceptNodeLabel(label)
    .replace(/\$([^$\n]+)\$/gu, (_, formula: string) => plainMathFormula(formula))
    .replace(/\\\(([^\n]*?)\\\)/gu, (_, formula: string) => plainMathFormula(formula))
    .replace(/\*{1,3}([^*]+)\*{1,3}/gu, "$1")
    .trim();
}

type ForceConceptNode = SimulationNodeDatum & {
  id: string;
  concept: PreparedLearningConcept;
  learned: boolean;
  initialX: number;
  initialY: number;
};

type ForceConceptLink = SimulationLinkDatum<ForceConceptNode> & {
  id: string;
  relation: PreparedLearningRelation;
};

function resolvedNode(value: string | number | ForceConceptNode, byId: Map<string, ForceConceptNode>) {
  return typeof value === "object" ? value : byId.get(String(value));
}

function DynamicConceptGraph({
  ir,
  selectedId,
  onSelect,
  learnedRouteIndex,
  canOpenLearningMessage,
}: {
  ir: PreparedLearningIr;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  learnedRouteIndex?: number;
  canOpenLearningMessage?: (preparedMessageId: string) => boolean;
}) {
  const messageOrder = useMemo(() => new Map(ir.steps.map((step) => [step.messageId, step.routeIndex])), [ir.steps]);
  const graphRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewportRef = useRef<SVGGElement | null>(null);
  const nodeRefs = useRef(new Map<string, SVGForeignObjectElement>());
  const pathRefs = useRef(new Map<string, SVGPathElement>());
  const labelRefs = useRef(new Map<string, SVGGElement>());
  const simulationRef = useRef<Simulation<ForceConceptNode, ForceConceptLink> | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const zoomTransformRef = useRef(zoomIdentity);
  const nodesRef = useRef<ForceConceptNode[]>([]);
  const linksRef = useRef<ForceConceptLink[]>([]);
  const dragRef = useRef<{ id: string; pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const [size, setSize] = useState({ width: 840, height: 680 });
  const [panning, setPanning] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());

  const connectedConceptIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedId) return ids;
    for (const relation of ir.relations) {
      if (relation.fromConceptId === selectedId) ids.add(relation.toConceptId);
      if (relation.toConceptId === selectedId) ids.add(relation.fromConceptId);
    }
    return ids;
  }, [ir.relations, selectedId]);

  const graph = useMemo(() => {
    const orderedConcepts = [...ir.concepts].sort((left, right) => (messageOrder.get(left.firstIntroducedMessageId) ?? Number.MAX_SAFE_INTEGER)
      - (messageOrder.get(right.firstIntroducedMessageId) ?? Number.MAX_SAFE_INTEGER));
    const nodes: ForceConceptNode[] = orderedConcepts.map((concept, index) => {
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      const radius = 70 + Math.sqrt(index) * 48;
      const initialX = size.width / 2 + Math.cos(angle) * radius;
      const initialY = size.height / 2 + Math.sin(angle) * radius;
      return {
        id: concept.id,
        concept,
        learned: learnedRouteIndex != null
          ? (messageOrder.get(concept.firstIntroducedMessageId) ?? Number.MAX_SAFE_INTEGER) <= learnedRouteIndex
          : Boolean(canOpenLearningMessage?.(concept.firstIntroducedMessageId)),
        x: initialX,
        y: initialY,
        initialX,
        initialY,
      };
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    const links: ForceConceptLink[] = ir.relations
      .filter((relation) => nodeIds.has(relation.fromConceptId) && nodeIds.has(relation.toConceptId))
      .map((relation) => ({ id: relation.id, relation, source: relation.fromConceptId, target: relation.toConceptId }));
    return { nodes, links };
  }, [canOpenLearningMessage, ir.concepts, ir.relations, learnedRouteIndex, messageOrder, size.height, size.width]);

  useEffect(() => {
    const element = graphRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: Math.max(480, entry.contentRect.width), height: Math.max(520, entry.contentRect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    const viewport = viewportRef.current;
    if (!svg || !viewport) return;
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.28, 2.6])
      .filter(isConceptGraphZoomEvent)
      .on("start", (event) => setPanning(event.sourceEvent?.button === 1))
      .on("zoom", (event) => {
        zoomTransformRef.current = event.transform;
        viewport.setAttribute("transform", event.transform.toString());
        for (const node of nodesRef.current) {
          const element = nodeRefs.current.get(node.id);
          if (!element) continue;
          element.setAttribute("transform", `${event.transform.toString()} translate(${node.x || 0} ${node.y || 0})`);
        }
      })
      .on("end", () => setPanning(false));
    select(svg).call(behavior).on("dblclick.zoom", null);
    zoomRef.current = behavior;
    return () => {
      select(svg).on(".zoom", null);
      zoomRef.current = null;
    };
  }, []);

  useEffect(() => {
    nodesRef.current = graph.nodes;
    linksRef.current = graph.links;
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const update = () => {
      for (const node of graph.nodes) {
        const element = nodeRefs.current.get(node.id);
        if (!element) continue;
        element.setAttribute("transform", `${zoomTransformRef.current.toString()} translate(${node.x || 0} ${node.y || 0})`);
      }
      for (const link of graph.links) {
        const source = resolvedNode(link.source, byId);
        const target = resolvedNode(link.target, byId);
        if (!source || !target) continue;
        const route = routeConceptRelation(
          { x: (source.x || 0) - NODE_WIDTH / 2, y: (source.y || 0) - NODE_HEIGHT / 2, width: NODE_WIDTH, height: NODE_HEIGHT },
          { x: (target.x || 0) - NODE_WIDTH / 2, y: (target.y || 0) - NODE_HEIGHT / 2, width: NODE_WIDTH, height: NODE_HEIGHT },
        );
        const path = `M ${route.start.x} ${route.start.y} L ${route.end.x} ${route.end.y}`;
        pathRefs.current.get(link.id)?.setAttribute("d", path);
        pathRefs.current.get(`${link.id}:hit`)?.setAttribute("d", path);
        labelRefs.current.get(link.id)?.setAttribute("transform", `translate(${route.label.x} ${route.label.y})`);
      }
    };
    const simulation = forceSimulation<ForceConceptNode>(graph.nodes)
      .alphaDecay(0.055)
      .velocityDecay(0.38)
      .force("link", forceLink<ForceConceptNode, ForceConceptLink>(graph.links).id((node) => node.id).distance(230).strength(0.16))
      .force("charge", forceManyBody().strength(-920).distanceMax(780))
      .force("collision", forceCollide<ForceConceptNode>().radius(124).strength(0.92).iterations(2))
      .force("center", forceCenter(size.width / 2, size.height / 2).strength(0.055))
      .force("x", forceX<ForceConceptNode>(size.width / 2).strength(0.012))
      .force("y", forceY<ForceConceptNode>(size.height / 2).strength(0.012))
      .on("tick", update);
    simulationRef.current = simulation;
    update();
    return () => {
      simulation.stop();
      if (simulationRef.current === simulation) simulationRef.current = null;
    };
  }, [graph, size.height, size.width]);

  function graphPoint(event: ReactPointerEvent) {
    const svg = svgRef.current;
    if (!svg) return [0, 0] as const;
    const bounds = svg.getBoundingClientRect();
    return zoomTransform(svg).invert([event.clientX - bounds.left, event.clientY - bounds.top]) as [number, number];
  }

  function startNodeDrag(event: ReactPointerEvent<HTMLButtonElement>, node: ForceConceptNode) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const [x, y] = graphPoint(event);
    dragRef.current = { id: node.id, pointerId: event.pointerId, x, y, moved: false };
    node.fx = node.x;
    node.fy = node.y;
    event.currentTarget.setPointerCapture(event.pointerId);
    simulationRef.current?.alphaTarget(0.18).restart();
  }

  function moveNode(event: ReactPointerEvent<HTMLButtonElement>, node: ForceConceptNode) {
    const drag = dragRef.current;
    if (!drag || drag.id !== node.id || drag.pointerId !== event.pointerId) return;
    const [x, y] = graphPoint(event);
    if (Math.hypot(x - drag.x, y - drag.y) > 3) drag.moved = true;
    node.fx = x;
    node.fy = y;
  }

  function finishNodeDrag(event: ReactPointerEvent<HTMLButtonElement>, node: ForceConceptNode) {
    const drag = dragRef.current;
    if (!drag || drag.id !== node.id) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    simulationRef.current?.alphaTarget(0);
    if (drag.moved) {
      suppressClickRef.current = true;
      setPinnedIds((current) => new Set(current).add(node.id));
    }
  }

  function resetGraph() {
    setPinnedIds(new Set());
    for (const node of nodesRef.current) {
      node.fx = null;
      node.fy = null;
      node.x = node.initialX;
      node.y = node.initialY;
      node.vx = 0;
      node.vy = 0;
    }
    simulationRef.current?.alpha(1).restart();
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (svg && behavior) select(svg).call(behavior.transform, zoomIdentity);
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return (
    <div ref={graphRef} className={`concept-force-graph ${panning ? "panning" : ""}`}>
      <svg ref={svgRef} width="100%" height="100%" role="img" aria-label="동적 개념 관계도. 왼쪽 드래그로 개념을 옮기고 가운데 드래그로 화면을 이동할 수 있습니다.">
        <defs>
          <marker id="concept-relation-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="concept-relation-arrow" /></marker>
          <marker id="concept-relation-arrow-learned" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="concept-relation-arrow learned" /></marker>
          <marker id="concept-relation-arrow-selected" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="concept-relation-arrow selected" /></marker>
        </defs>
        <rect
          className="concept-graph-background"
          width="100%"
          height="100%"
          data-clears-selection="true"
          onClick={() => onSelect(null)}
        />
        <g ref={viewportRef}>
          <g className="concept-force-links">
            {graph.links.map((link) => {
              const source = resolvedNode(link.source, byId);
              const target = resolvedNode(link.target, byId);
              const learned = Boolean(source?.learned && target?.learned);
              const frontier = Boolean(source?.learned !== target?.learned);
              const selected = link.relation.fromConceptId === selectedId || link.relation.toConceptId === selectedId;
              const contextMuted = Boolean(selectedId && !selected);
              const labelVisible = selected;
              const label = RELATION_LABEL[link.relation.type];
              const labelWidth = Math.max(48, Math.min(112, Array.from(label).length * 11 + 24));
              return (
                <g
                  key={link.id}
                  className={`concept-relation ${learned ? "learned" : frontier ? "frontier" : "upcoming"} ${selected ? "selected" : ""} ${contextMuted ? "context-muted" : ""} ${labelVisible ? "label-visible" : ""}`}
                >
                  <path className="concept-relation-hit" ref={(element) => { if (element) pathRefs.current.set(`${link.id}:hit`, element); else pathRefs.current.delete(`${link.id}:hit`); }} />
                  <path
                    ref={(element) => { if (element) pathRefs.current.set(link.id, element); else pathRefs.current.delete(link.id); }}
                    markerEnd={`url(#${selected ? "concept-relation-arrow-selected" : learned ? "concept-relation-arrow-learned" : "concept-relation-arrow"})`}
                  />
                  <g
                    ref={(element) => { if (element) labelRefs.current.set(link.id, element); else labelRefs.current.delete(link.id); }}
                    className="concept-relation-label"
                    style={{ opacity: labelVisible ? 1 : 0 }}
                  >
                    <rect x={-labelWidth / 2} y={-12} width={labelWidth} height={24} rx={12} />
                    <text dominantBaseline="central">{label}</text>
                  </g>
                </g>
              );
            })}
          </g>
        </g>
        <g className="concept-force-nodes">
          {graph.nodes.map((node) => (
            <foreignObject
              key={node.id}
              ref={(element) => { if (element) nodeRefs.current.set(node.id, element); else nodeRefs.current.delete(node.id); }}
              x={-NODE_WIDTH / 2}
              y={-NODE_HEIGHT / 2}
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
              overflow="visible"
            >
                <button
                  type="button"
                  className={`concept-node ${selectedId === node.id ? "selected" : connectedConceptIds.has(node.id) ? "connected" : selectedId ? "context-muted" : ""} ${node.learned ? "learned" : "upcoming"} ${pinnedIds.has(node.id) ? "pinned" : ""}`}
                  onPointerDown={(event) => startNodeDrag(event, node)}
                  onPointerMove={(event) => moveNode(event, node)}
                  onPointerUp={(event) => finishNodeDrag(event, node)}
                  onPointerCancel={(event) => finishNodeDrag(event, node)}
                  onClick={() => {
                    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                    onSelect(node.id);
                  }}
                  aria-pressed={selectedId === node.id}
                  aria-label={node.concept.label}
                >
                  <strong>{plainConceptNodeLabel(node.concept.label)}</strong>
                </button>
            </foreignObject>
          ))}
        </g>
      </svg>
      <div className="concept-force-controls">
        <button type="button" onClick={resetGraph} title="초기 배치로 돌아가기"><RotateCcw size={15} aria-hidden="true" /> 초기 배치</button>
      </div>
      <p className="concept-force-hint">왼쪽 드래그: 개념 이동 · 가운데 드래그: 화면 이동 · 휠: 확대·축소</p>
    </div>
  );
}

export function ConceptGraphView({
  ir,
  onOpenSource,
  onOpenLearningMessage,
  learnedRouteIndex,
  canOpenLearningMessage,
}: {
  ir: PreparedLearningIr;
  onOpenSource?: (chunkId: string) => void;
  onOpenLearningMessage?: (preparedMessageId: string) => void;
  learnedRouteIndex?: number;
  canOpenLearningMessage?: (preparedMessageId: string) => boolean;
}) {
  const byId = useMemo(() => new Map(ir.concepts.map((concept) => [concept.id, concept])), [ir.concepts]);
  const [selectedId, setSelectedId] = useState(ir.concepts[0]?.id || null);
  useEffect(() => setSelectedId(ir.concepts[0]?.id || null), [ir.messageSetId, ir.concepts]);
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const selectedRelations = selected ? ir.relations.filter((relation) => relation.fromConceptId === selected.id || relation.toConceptId === selected.id) : [];
  const firstLearningMessageAvailable = Boolean(selected && onOpenLearningMessage && canOpenLearningMessage?.(selected.firstIntroducedMessageId));

  return (
    <section className="concept-graph-section" aria-labelledby="concept-graph-title">
      <header>
        <div>
          <p className="eyebrow">완성된 학습지도</p>
          <h3 id="concept-graph-title">수업에서 실제로 연결한 개념</h3>
          <p>전체 학습 경로를 표시하고, 지금까지 다룬 영역을 강조합니다.</p>
        </div>
        <div className="concept-graph-key" aria-label="학습 진도 범례">
          <span><i className="learned" aria-hidden="true" /> 지금까지 학습</span>
          <span><i className="upcoming" aria-hidden="true" /> 앞으로 학습</span>
          <span><i className="focused" aria-hidden="true" /> 선택한 관계</span>
        </div>
      </header>

      <div className="concept-graph-workspace">
        <DynamicConceptGraph ir={ir} selectedId={selectedId} onSelect={setSelectedId} learnedRouteIndex={learnedRouteIndex} canOpenLearningMessage={canOpenLearningMessage} />

        {selected ? (
          <aside className="concept-detail" aria-live="polite">
            <p className="eyebrow">선택한 개념</p>
            <h4><InlineMarkdownContent content={selected.label} /></h4>
            <MarkdownContent content={selected.definition} compact />
            <section><h5>수업에서 이 개념을 쓴 이유</h5><MarkdownContent content={selected.learningSignificance} compact /></section>
            <section className="concept-first-lesson">
              <h5>처음 다룬 곳</h5>
              {firstLearningMessageAvailable ? (
                <button type="button" className="concept-lesson-link" onClick={() => onOpenLearningMessage?.(selected.firstIntroducedMessageId)}>
                  <MessageSquareText size={15} aria-hidden="true" /> 학습공간에서 처음 설명한 대목 보기
                </button>
              ) : <p>앞으로 학습할 대목입니다.</p>}
            </section>
            {selectedRelations.length ? (
              <section>
                <h5>직접 설명한 관계</h5>
                <ul>{selectedRelations.map((relation) => {
                  const otherId = relation.fromConceptId === selected.id ? relation.toConceptId : relation.fromConceptId;
                  return <li key={relation.id}><strong>{RELATION_LABEL[relation.type]} · <InlineMarkdownContent content={byId.get(otherId)?.label || ""} /></strong><MarkdownContent content={relation.explanation} compact /></li>;
                })}</ul>
              </section>
            ) : null}
            {selected.sourceChunkIds[0] && onOpenSource ? (
              <button type="button" className="wide-button" onClick={() => onOpenSource(selected.sourceChunkIds[0]!)}><LocateFixed size={15} aria-hidden="true" /> 이 설명의 원문 보기</button>
            ) : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
