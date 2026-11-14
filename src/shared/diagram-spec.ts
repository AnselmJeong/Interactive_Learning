/**
 * Structured diagrams: the LLM describes the graph (nodes, arrows, groups) as JSON,
 * Learnie compiles it to Mermaid flowchart text and Pele lays it out and renders SVG.
 * The model never writes coordinates or Mermaid syntax, so layout is consistent and
 * labels cannot break the parser.
 */

export type DiagramDirection = "TD" | "LR";
export type DiagramTone = "default" | "accent" | "muted";
export type DiagramShape = "box" | "round" | "note";
export type DiagramLineStyle = "solid" | "dashed";

export type DiagramNode = { id: string; label: string; tone?: DiagramTone; shape?: DiagramShape };
export type DiagramEdge = { from: string; to: string; label?: string; style?: DiagramLineStyle };
export type DiagramGroup = { label: string; nodes: string[]; style?: DiagramLineStyle };

export type DiagramSpec = {
  direction: DiagramDirection;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups?: DiagramGroup[];
};

export const DIAGRAM_LIMITS = { nodes: 14, edges: 24, groups: 4, label: 160, edgeLabel: 60, groupLabel: 80 } as const;

/** Prompt fragment describing the diagram block for tutor-style JSON outputs. */
export const DIAGRAM_BLOCK_SCHEMA = `- diagram: {"type":"diagram","title":"optional","caption":"optional one sentence stating what the arrows mean and any limits","direction":"TD|LR","nodes":[{"id":"a","label":"short label; \\n for a line break; formulas in $...$","tone":"default|accent|muted","shape":"box|round|note"}],"edges":[{"from":"a","to":"b","label":"optional short verb","style":"solid|dashed"}],"groups":[{"label":"optional frame title","nodes":["a","b"],"style":"solid|dashed"}]}`;

export const DIAGRAM_RULE = `For any relationship with structure — a causal chain, mechanism, branching, convergence, feedback loop, hierarchy, or a process with side conditions — emit a diagram block. Describe only the graph: nodes, directed edges and optional groups. Learnie lays it out automatically, so never give coordinates, sizes, SVG, HTML, CSS or Mermaid code. Use 2-${DIAGRAM_LIMITS.nodes} nodes with concise labels (one idea per node, at most two short lines). Write formulas inside labels with $...$ exactly like in prose. Use direction "TD" for top-down processes and "LR" for short left-to-right chains or comparisons. Use tone "accent" for the outcome or key node, "muted" for background conditions, shape "note" for a side remark or caveat list, and a dashed group to frame related nodes (for example limitations). Label an edge only when the relation is not obvious (e.g. "causes", "inhibits", "measured by"). Use dashed edges for indirect, hypothetical or weaker relations.`;

const DIRECTION_ALIASES: Record<string, DiagramDirection> = {
  td: "TD", tb: "TD", bt: "TD", vertical: "TD", down: "TD", "top-down": "TD",
  lr: "LR", rl: "LR", horizontal: "LR", right: "LR", "left-right": "LR",
};

function text(value: unknown, max: number) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/\*\*(.+?)\*\*/gu, "$1")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, max)
    .trim();
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback?: T): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Validate untrusted JSON into a renderable diagram spec, or null when it is not a usable graph. */
export function sanitizeDiagramSpec(raw: unknown): DiagramSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const direction = DIRECTION_ALIASES[String(record.direction || "").trim().toLowerCase()] || "TD";
  const idMap = new Map<string, string>();
  const nodes: DiagramNode[] = [];
  const rawNodes = Array.isArray(record.nodes) ? record.nodes : [];
  for (const entry of rawNodes) {
    if (nodes.length >= DIAGRAM_LIMITS.nodes) break;
    const node = typeof entry === "string" ? { id: entry, label: entry } : entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    if (!node) continue;
    const detail = text(node.detail, DIAGRAM_LIMITS.label);
    const label = text([text(node.label ?? node.text ?? node.id, DIAGRAM_LIMITS.label), detail].filter(Boolean).join("\n"), DIAGRAM_LIMITS.label);
    const key = String(node.id ?? label).trim();
    if (!label || !key || idMap.has(key)) continue;
    const id = `n${nodes.length + 1}`;
    idMap.set(key, id);
    const tone = pick(node.tone, ["default", "accent", "muted"] as const);
    const shape = pick(node.shape, ["box", "round", "note"] as const);
    nodes.push({ id, label, ...(tone && tone !== "default" ? { tone } : {}), ...(shape && shape !== "box" ? { shape } : {}) });
  }
  if (nodes.length < 2) return null;

  const resolve = (value: unknown) => idMap.get(String(value ?? "").trim());
  const edges: DiagramEdge[] = [];
  const rawEdges = Array.isArray(record.edges) ? record.edges : [];
  for (const entry of rawEdges) {
    if (edges.length >= DIAGRAM_LIMITS.edges) break;
    if (!entry || typeof entry !== "object") continue;
    const edge = entry as Record<string, unknown>;
    const from = resolve(edge.from ?? edge.source);
    const to = resolve(edge.to ?? edge.target);
    if (!from || !to || from === to) continue;
    const label = text(edge.label, DIAGRAM_LIMITS.edgeLabel).replace(/\n/g, " ");
    const style = pick(edge.style, ["solid", "dashed"] as const);
    edges.push({ from, to, ...(label ? { label } : {}), ...(style === "dashed" ? { style } : {}) });
  }

  const grouped = new Set<string>();
  const groups: DiagramGroup[] = [];
  const rawGroups = Array.isArray(record.groups) ? record.groups : [];
  for (const entry of rawGroups) {
    if (groups.length >= DIAGRAM_LIMITS.groups) break;
    if (!entry || typeof entry !== "object") continue;
    const group = entry as Record<string, unknown>;
    // A node can only sit in one frame; later groups lose overlapping members.
    const members = (Array.isArray(group.nodes) ? group.nodes : []).map(resolve).filter((id): id is string => Boolean(id) && !grouped.has(id!));
    const unique = [...new Set(members)];
    if (!unique.length) continue;
    unique.forEach((id) => grouped.add(id));
    const style = pick(group.style, ["solid", "dashed"] as const);
    groups.push({ label: text(group.label ?? group.title, DIAGRAM_LIMITS.groupLabel).replace(/\n/g, " "), nodes: unique, ...(style === "dashed" ? { style } : {}) });
  }

  if (!edges.length && !groups.length) return null;
  return { direction, nodes, edges, ...(groups.length ? { groups } : {}) };
}

const MATH_SEGMENT = /\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/gu;

function escapeMermaidText(value: string) {
  return value
    .replace(/#/g, "#35;")
    .replace(/&/g, "#amp;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/\$/g, "#36;")
    .replace(/`/g, "#96;");
}

/** Escape a label for use inside a quoted Mermaid string, keeping $...$ math as Pele $$...$$ math. */
export function mermaidLabel(value: string) {
  return value
    .split("\n")
    .map((line) => {
      let out = "";
      let last = 0;
      for (const match of line.matchAll(MATH_SEGMENT)) {
        const tex = (match[1] ?? match[2] ?? match[3] ?? "").trim();
        out += escapeMermaidText(line.slice(last, match.index));
        // Quotes would end the Mermaid string; TeX rarely needs them, so drop them.
        out += tex ? `$$${tex.replace(/"/g, "''")}$$` : "";
        last = match.index! + match[0].length;
      }
      return out + escapeMermaidText(line.slice(last));
    })
    .join("<br/>");
}

/** Compile a sanitized diagram spec to Mermaid flowchart source. */
export function diagramToMermaid(spec: DiagramSpec) {
  // Wider wrapping keeps Korean phrases on one line; LR chains stay narrower so they fit the column.
  const lines = ["---", "config:", "  flowchart:", `    wrappingWidth: ${spec.direction === "LR" ? 200 : 300}`, "---", `flowchart ${spec.direction}`];
  const nodeLine = (node: DiagramNode) => {
    const label = `"${mermaidLabel(node.label)}"`;
    return node.shape === "round" ? `${node.id}(${label})` : `${node.id}[${label}]`;
  };
  const grouped = new Set(spec.groups?.flatMap((group) => group.nodes) || []);
  for (const node of spec.nodes) if (!grouped.has(node.id)) lines.push(`  ${nodeLine(node)}`);
  const byId = new Map(spec.nodes.map((node) => [node.id, node]));
  spec.groups?.forEach((group, index) => {
    lines.push(`  subgraph g${index + 1}["${mermaidLabel(group.label) || " "}"]`);
    for (const id of group.nodes) {
      const node = byId.get(id);
      if (node) lines.push(`    ${nodeLine(node)}`);
    }
    lines.push("  end");
  });
  for (const edge of spec.edges) {
    const arrow = edge.style === "dashed" ? "-.->" : "-->";
    lines.push(`  ${edge.from} ${arrow}${edge.label ? `|"${mermaidLabel(edge.label)}"|` : ""} ${edge.to}`);
  }
  for (const [from, to] of detachedLinks(spec)) lines.push(`  ${from} ~~~ ${to}`);
  for (const tone of ["accent", "muted"] as const) {
    const ids = spec.nodes.filter((node) => node.tone === tone).map((node) => node.id);
    if (ids.length) lines.push(`  class ${ids.join(",")} learn-${tone}`);
  }
  const notes = spec.nodes.filter((node) => node.shape === "note").map((node) => node.id);
  if (notes.length) lines.push(`  class ${notes.join(",")} learn-note`);
  spec.groups?.forEach((group, index) => {
    if (group.style === "dashed") lines.push(`  class g${index + 1} learn-dashed`);
  });
  return lines.join("\n");
}

/**
 * Side notes and caveat frames are usually not wired to the main chain. Invisible links place each
 * detached part after the main chain's end instead of beside its start.
 */
function detachedLinks(spec: DiagramSpec): Array<[string, string]> {
  const parent = new Map(spec.nodes.map((node) => [node.id, node.id]));
  const find = (id: string): string => {
    const up = parent.get(id)!;
    if (up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  const join = (a: string, b: string) => parent.set(find(a), find(b));
  spec.edges.forEach((edge) => join(edge.from, edge.to));
  spec.groups?.forEach((group) => group.nodes.slice(1).forEach((id) => join(group.nodes[0]!, id)));
  const main = find(spec.nodes[0]!.id);
  const mainNodes = spec.nodes.filter((node) => find(node.id) === main);
  const sinks = mainNodes.filter((node) => !spec.edges.some((edge) => edge.from === node.id));
  const anchor = (sinks.at(-1) || mainNodes.at(-1))!.id;
  const seen = new Set([main]);
  const links: Array<[string, string]> = [];
  for (const node of spec.nodes) {
    const root = find(node.id);
    if (seen.has(root)) continue;
    seen.add(root);
    links.push([anchor, node.id]);
  }
  return links;
}

/** Readable text version for exports, search and the render fallback. */
export function diagramPlainText(spec: DiagramSpec) {
  const label = (id: string) => (spec.nodes.find((node) => node.id === id)?.label || id).replace(/\n/g, " ");
  const item = (value: string) => (/^[·•\-*]/u.test(value) ? value : `· ${value}`);
  const edgeLines = spec.edges.map((edge) => `${label(edge.from)} ${edge.style === "dashed" ? "⇢" : "→"}${edge.label ? ` (${edge.label})` : ""} ${label(edge.to)}`);
  const connected = new Set(spec.edges.flatMap((edge) => [edge.from, edge.to]));
  const groupLines = (spec.groups || []).map((group) => [group.label, ...group.nodes.filter((id) => !connected.has(id)).map((id) => item(label(id)))].filter(Boolean).join("\n"));
  const loose = spec.nodes.filter((node) => !connected.has(node.id) && !spec.groups?.some((group) => group.nodes.includes(node.id))).map((node) => item(node.label.replace(/\n/g, " ")));
  return [...edgeLines, ...loose, ...groupLines].filter(Boolean).join("\n");
}

export type DiagramBlock = { type: "diagram"; title?: string; caption?: string; body: string } & DiagramSpec;

/** Normalize an untrusted tutor block into a diagram block (title/caption are plain text). */
export function normalizeDiagramBlock(raw: Record<string, unknown>): DiagramBlock | null {
  const spec = sanitizeDiagramSpec(raw);
  if (!spec) return null;
  const title = text(raw.title, 120).replace(/\n/g, " ") || undefined;
  const caption = text(raw.caption, 280).replace(/\n/g, " ") || undefined;
  return { type: "diagram", ...(title ? { title } : {}), ...(caption ? { caption } : {}), ...spec, body: diagramPlainText(spec) };
}
