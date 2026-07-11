import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "./project-db";
import { SettingsService } from "./settings-service";
import { CourseArtifactService } from "./course-artifact-service";
import { writeZipFromDirectory } from "./archive-writer";
import type { SessionReadableExport } from "../shared/project-transfer-types";
import type { TutorContentBlock } from "../shared/tutor-types";

type SessionExportRow = {
  id: string;
  title: string;
  status: string;
  project_id: string;
  material_id: string;
  current_module_id: string | null;
  completed_module_ids_json: string;
  model: string | null;
  created_at: number;
  updated_at: number;
  project_title: string;
  material_title: string;
};

type MessageRow = {
  role: string;
  content: string;
  source_refs_json: string;
  blocks_json: string;
};

type AnnotationRow = {
  kind: string;
  selected_text: string;
  result_json: string;
  source_meta_json: string;
};

function json<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function safeFilePart(value: string, fallback = "session") {
  return value.replace(/[\\/:*?"<>|#{}\[\]`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || fallback;
}

function stamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function collisionSafePath(folder: string, baseName: string) {
  const extension = ".zip";
  const stem = baseName.endsWith(extension) ? baseName.slice(0, -extension.length) : baseName;
  let candidate = join(folder, `${stem}${extension}`);
  for (let index = 2; existsSync(candidate); index += 1) candidate = join(folder, `${stem}-${index}${extension}`);
  return candidate;
}

function blocksToMarkdown(blocks: TutorContentBlock[], fallback: string) {
  if (!blocks.length) return fallback.trim();
  return blocks.map((block) => {
    if (block.type === "hook") return `> ${block.body}`;
    if (block.type === "guided_reading") return block.sourceRef ? `${block.body}\n\n_Source: ${block.sourceRef}_` : block.body;
    if (block.type === "paragraph") return block.body;
    if (block.type === "bullets") return `${block.title ? `**${block.title}**\n\n` : ""}${block.items.map((item) => `- ${item}`).join("\n")}`;
    if (block.type === "flow") return `${block.title ? `**${block.title}**\n\n` : ""}${block.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`;
    if (block.type === "compare_table") {
      const header = `| ${block.columns.join(" | ")} |`;
      const divider = `| ${block.columns.map(() => "---").join(" | ")} |`;
      const rows = block.rows.map((row) => `| ${block.columns.map((column) => row[column] || "").join(" | ")} |`);
      return [block.title ? `**${block.title}**` : "", header, divider, ...rows].filter(Boolean).join("\n");
    }
    if (block.type === "source_quote") return `> ${block.quote}\n\n_Source: ${block.sourceRef}${block.attribution ? `, ${block.attribution}` : ""}_`;
    if (block.type === "reflection") return `**Reflection**\n\n${block.body}${block.aiView ? `\n\n_AI의 견해:_ ${block.aiView}` : ""}`;
    if (block.type === "misconception") return `**${block.title || "Clarification"}**\n\n${block.body}\n\n${block.repair}`;
    if (block.type === "bridge") return `_${block.body}_`;
    return "";
  }).filter(Boolean).join("\n\n");
}

function annotationBody(raw: string) {
  const result = json<Record<string, unknown>>(raw, {});
  const candidates = [result.body, result.note, result.question, result.answer].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  if (candidates.length) return candidates.join("\n\n");
  const messages = Array.isArray(result.messages) ? result.messages : [];
  return messages.map((message) => {
    const item = message as Record<string, unknown>;
    const role = item.role === "user" ? "Learner" : "Tutor";
    return typeof item.content === "string" ? `**${role}:** ${item.content}` : "";
  }).filter(Boolean).join("\n\n");
}

export class SessionExportService {
  private readonly settings = new SettingsService();
  private readonly artifacts = new CourseArtifactService();

  async exportReadable(sessionId: string, destinationFolder?: string): Promise<SessionReadableExport> {
    const snapshot = getDb().transaction(() => {
      const session = getDb().query<SessionExportRow, [string]>(`
        SELECT s.*, p.title AS project_title, m.title AS material_title
        FROM learning_sessions s
        JOIN projects p ON p.id = s.project_id
        JOIN learning_materials m ON m.id = s.material_id
        WHERE s.id = ?
      `).get(sessionId);
      if (!session) throw new Error("Session not found");
      const messages = getDb().query<MessageRow, [string]>(`
        SELECT role, content, source_refs_json, blocks_json
        FROM learning_messages
        WHERE session_id = ? AND delivery_state = 'visible' AND role != 'system'
        ORDER BY ordinal ASC
      `).all(sessionId);
      const annotations = getDb().query<AnnotationRow, [string]>(`
        SELECT kind, selected_text, result_json, source_meta_json
        FROM material_annotations
        WHERE session_id = ? AND scope = 'session'
        ORDER BY created_at ASC
      `).all(sessionId);
      return { session, messages, annotations };
    })();
    const { session, messages, annotations } = snapshot;
    const artifacts = await this.artifacts.getArtifacts(session.material_id).catch(() => null);
    const sourceIndex = artifacts?.sourceIndex || {};
    const totalModules = artifacts?.coursePlan.modules.length || 0;
    const completedModules = json<string[]>(session.completed_module_ids_json, []).length;
    const lines = [
      `# ${session.title}`,
      "",
      `Project: ${session.project_title}`,
      `Material: ${session.material_title}`,
      `Status: ${session.status}`,
      `Progress: ${completedModules} of ${totalModules || "?"} modules`,
      `Created: ${new Date(session.created_at).toISOString()}`,
      `Updated: ${new Date(session.updated_at).toISOString()}`,
      session.model ? `Model: ${session.model}` : "",
      "",
      "## Conversation",
      "",
    ].filter(Boolean);

    for (const message of messages) {
      lines.push(`### ${message.role === "assistant" ? "Tutor" : "Learner"}`, "");
      lines.push(blocksToMarkdown(json<TutorContentBlock[]>(message.blocks_json, []), message.content), "");
      const refs = json<string[]>(message.source_refs_json, []).map((id) => sourceIndex[id]).filter(Boolean);
      if (refs.length) {
        lines.push("Sources:");
        for (const ref of refs) lines.push(`- ${[ref!.title, ref!.locator].filter(Boolean).join(", ")}`);
        lines.push("");
      }
    }

    lines.push("## Notes and highlights", "");
    if (!annotations.length) lines.push("No session notes or highlights.", "");
    for (const annotation of annotations) {
      lines.push(`### ${annotation.selected_text || annotation.kind}`, "", `Type: ${annotation.kind}`, "");
      const body = annotationBody(annotation.result_json);
      if (body) lines.push(body, "");
      const sources = json<Array<{ title?: string; url?: string }>>(annotation.source_meta_json, []);
      for (const source of sources) lines.push(`- ${source.title || source.url || "Source"}`);
      if (sources.length) lines.push("");
    }
    lines.push(`Exported: ${new Date().toISOString()}`, "");

    const settings = await this.settings.get();
    const outDir = destinationFolder || settings.defaultDownloadFolder;
    await mkdir(outDir, { recursive: true });
    const fileName = `${safeFilePart(session.title)}-learning-session-${stamp()}.zip`;
    const zipPath = collisionSafePath(outDir, fileName);
    const staging = await mkdtemp(join(tmpdir(), "learnie-session-export-"));
    const exportRoot = join(staging, `${safeFilePart(session.title)}-learning-session`);
    try {
      await mkdir(exportRoot, { recursive: true });
      await writeFile(join(exportRoot, "session.md"), `${lines.join("\n").trim()}\n`, "utf8");
      await writeZipFromDirectory(staging, zipPath);
      return { zipPath, fileName: zipPath.split("/").pop() || fileName, sessionId, messageCount: messages.length, annotationCount: annotations.length, assetCount: 0 };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
