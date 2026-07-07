import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getDb } from "./project-db";
import { dataPath, projectDirAt } from "./paths";
import { CourseArtifactService } from "./course-artifact-service";
import type { MaterialArtifacts } from "../shared/artifact-types";
import type { ProjectArchiveExport, ProjectRescanResult, ProjectSummary } from "../shared/rpc-types";
import type { TutorContentBlock } from "../shared/tutor-types";
import { SettingsService } from "./settings-service";
import { syncProjectRootToDb, writeProjectManifest } from "./project-bundle-sync";
import { writeZipFromDirectory } from "./archive-writer";

type ProjectRow = {
  id: string;
  title: string;
  description: string | null;
  root_path: string | null;
  created_at: number;
  updated_at: number;
  last_opened_at: number | null;
  archived_at: number | null;
};

type SourceRow = {
  id: string;
  project_id: string;
  title: string;
  source_type: string;
  original_file_name: string;
  original_file_path: string | null;
  imported_file_path: string;
  content_hash: string;
  quality_status: string;
  created_at: number;
  updated_at: number;
};

type MaterialRow = {
  id: string;
  project_id: string;
  title: string;
  material_type: string;
  status: string;
  generation_error: string | null;
  created_at: number;
  updated_at: number;
};

type SessionRow = {
  id: string;
  project_id: string;
  material_id: string;
  title: string;
  status: "active" | "completed" | "archived";
  current_module_id: string | null;
  completed_module_ids_json: string;
  model: string | null;
  created_at: number;
  updated_at: number;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  module_id: string | null;
  source_refs_json: string;
  choices_json: string;
  blocks_json: string;
  visual_id: string | null;
  state_update_json: string | null;
  created_at: number;
  ordinal: number;
};

function toProject(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    rootPath: row.root_path || dataPath("projects"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    archivedAt: row.archived_at,
  };
}

function jsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function jsonBlocks(raw: string | null): TutorContentBlock[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TutorContentBlock[]) : [];
  } catch {
    return [];
  }
}

function safeFilePart(value: string, fallback = "untitled") {
  return (
    value
      .replace(/[\\/:*?"<>|#{}\[\]`]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90) || fallback
  );
}

function stamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function isoTime(value: number) {
  return new Date(value).toISOString();
}

function sourceExcerpt(text: string, maxWords = 36) {
  return text.replace(/\s+/g, " ").trim().split(/\s+/).slice(0, maxWords).join(" ");
}

function blocksToMarkdown(blocks: TutorContentBlock[], fallback: string) {
  if (!blocks.length) return fallback.trim();
  return blocks
    .map((block) => {
      if (block.type === "hook") return `> ${block.body}`;
      if (block.type === "guided_reading") return block.sourceRef ? `${block.body}\n\n_Source: ${block.sourceRef}_` : block.body;
      if (block.type === "paragraph") return block.body;
      if (block.type === "bullets") return `${block.title ? `**${block.title}**\n\n` : ""}${block.items.map((item) => `- ${item}`).join("\n")}`;
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
    })
    .filter(Boolean)
    .join("\n\n");
}

function coursePlanMarkdown(artifacts: MaterialArtifacts) {
  return [
    `# ${artifacts.coursePlan.title}`,
    artifacts.coursePlan.subtitle,
    "",
    `Estimated time: ${artifacts.coursePlan.estimatedTimeMinutes} minutes`,
    "",
    "## Modules",
    "",
    ...artifacts.coursePlan.modules.map((module, index) => `${index + 1}. **${module.title}**\n   ${module.learningGoal}`),
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function annotationsMarkdown(artifacts: MaterialArtifacts) {
  const lines = ["# Saved Lookups", ""];
  if (!artifacts.annotations.length) {
    lines.push("No saved lookups.", "");
    return lines.join("\n");
  }

  for (const annotation of artifacts.annotations) {
    const meta = artifacts.sourceIndex[annotation.chunkId];
    lines.push(`## ${annotation.selectedText}`, "");
    lines.push(`Type: ${annotation.kind}`);
    if (meta?.title || meta?.locator) lines.push(`Source: ${[meta.title, meta.locator].filter(Boolean).join(", ")}`);
    lines.push("");
    const result = annotation.result;
    if (result.kind === "define" || result.kind === "lookup" || result.kind === "question") {
      if (result.kind === "question" && result.question) lines.push(`Question: ${result.question}`, "");
      lines.push(result.body, "");
    } else if (result.kind === "image") {
      if (result.body) lines.push(result.body, "");
      for (const image of result.images) {
        lines.push(`- ${image.title}: ${image.pageUrl || image.imageUrl || image.thumbnailUrl}`);
      }
      lines.push("");
    } else if (result.kind === "note") {
      lines.push(result.note, "");
    }
    for (const source of annotation.sourceMeta) {
      lines.push(`- ${source.provider || "Source"}: ${source.url || source.title}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

export class ProjectService {
  private readonly settings = new SettingsService();
  private readonly artifacts = new CourseArtifactService();

  async create(input: { title: string; description?: string }) {
    const title = input.title.trim();
    if (!title) throw new Error("Project title is required");

    const id = crypto.randomUUID();
    const now = Date.now();
    const appSettings = await this.settings.get();
    const rootPath = appSettings.projectRootFolder || dataPath("projects");
    await mkdir(projectDirAt(rootPath, id), { recursive: true });
    getDb()
      .query(
        `INSERT INTO projects (id, title, description, root_path, created_at, updated_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, title, input.description?.trim() || null, rootPath, now, now, now);
    const project = this.open(id);
    await writeProjectManifest(project);
    return project;
  }

  async list() {
    const appSettings = await this.settings.get();
    const rootPath = appSettings.projectRootFolder || dataPath("projects");
    await syncProjectRootToDb(rootPath);
    return this.listFromRoot(rootPath);
  }

  async rescan(): Promise<ProjectRescanResult> {
    const appSettings = await this.settings.get();
    const rootPath = appSettings.projectRootFolder || dataPath("projects");
    const sync = await syncProjectRootToDb(rootPath);
    return { projects: this.listFromRoot(rootPath), sync };
  }

  private listFromRoot(rootPath: string) {
    const rows = getDb()
      .query<ProjectRow, [string]>(
        `SELECT * FROM projects
         WHERE archived_at IS NULL
           AND root_path = ?
         ORDER BY COALESCE(last_opened_at, updated_at) DESC`
      )
      .all(rootPath);
    return rows.map(toProject);
  }

  open(projectId: string) {
    const now = Date.now();
    getDb().query("UPDATE projects SET last_opened_at = ?, updated_at = ? WHERE id = ?").run(now, now, projectId);
    const row = getDb().query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!row) throw new Error("Project not found");
    return toProject(row);
  }

  archive(projectId: string) {
    const now = Date.now();
    getDb().query("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, projectId);
    const row = getDb().query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (row) void writeProjectManifest(toProject(row));
    return true;
  }

  async delete(projectId: string) {
    const row = getDb().query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!row) throw new Error("Project not found");

    const rootPath = row.root_path || dataPath("projects");
    const projectPath = join(rootPath, projectId);
    getDb().query("DELETE FROM projects WHERE id = ?").run(projectId);
    await rm(projectPath, { recursive: true, force: true });
    return true;
  }

  async exportArchive(projectId: string, destinationFolder?: string): Promise<ProjectArchiveExport> {
    const project = this.open(projectId);
    const settings = await this.settings.get();
    const outDir = destinationFolder || settings.defaultDownloadFolder;
    await mkdir(outDir, { recursive: true });

    const staging = await mkdtemp(join(tmpdir(), "learnie-archive-"));
    const sourcesDir = join(staging, "sources");
    const materialsDir = join(staging, "materials");
    await mkdir(sourcesDir, { recursive: true });
    await mkdir(materialsDir, { recursive: true });

    try {
      const sources = getDb().query<SourceRow, [string]>("SELECT * FROM project_sources WHERE project_id = ? ORDER BY created_at ASC").all(projectId);
      const materials = getDb().query<MaterialRow, [string]>("SELECT * FROM learning_materials WHERE project_id = ? ORDER BY created_at ASC").all(projectId);
      const sessions = getDb().query<SessionRow, [string]>("SELECT * FROM learning_sessions WHERE project_id = ? ORDER BY created_at ASC").all(projectId);

      await writeFile(join(staging, "README.md"), `# ${project.title} Learning Archive\n\nExported: ${new Date().toISOString()}\nSessions: ${sessions.length}\n`, "utf8");
      await writeFile(join(staging, "project.json"), `${JSON.stringify(project, null, 2)}\n`, "utf8");
      await writeFile(
        join(sourcesDir, "sources.json"),
        `${JSON.stringify(
          sources.map((source) => ({
            id: source.id,
            title: source.title,
            sourceType: source.source_type,
            originalFileName: source.original_file_name,
            qualityStatus: source.quality_status,
            createdAt: source.created_at,
            updatedAt: source.updated_at,
          })),
          null,
          2
        )}\n`,
        "utf8"
      );

      let sessionCount = 0;
      for (const [materialIndex, material] of materials.entries()) {
        const materialDir = join(materialsDir, `${String(materialIndex + 1).padStart(2, "0")}-${safeFilePart(material.title)}`);
        const sessionsDir = join(materialDir, "sessions");
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(join(materialDir, "material.json"), `${JSON.stringify(material, null, 2)}\n`, "utf8");

        let artifacts: MaterialArtifacts | null = null;
        try {
          artifacts = await this.artifacts.getArtifacts(material.id);
          await writeFile(join(materialDir, "course_plan.md"), coursePlanMarkdown(artifacts), "utf8");
          await writeFile(join(materialDir, "annotations.json"), `${JSON.stringify(artifacts.annotations, null, 2)}\n`, "utf8");
          await writeFile(join(materialDir, "annotations.md"), annotationsMarkdown(artifacts), "utf8");
        } catch (error) {
          await writeFile(join(materialDir, "course_plan.md"), `# ${material.title}\n\nMaterial artifacts could not be loaded: ${(error as Error).message}\n`, "utf8");
        }

        const materialSessions = sessions.filter((session) => session.material_id === material.id);
        for (const [sessionIndex, session] of materialSessions.entries()) {
          const fileName = `${stamp(new Date(session.created_at))}-${String(sessionIndex + 1).padStart(2, "0")}-${safeFilePart(session.title, "session")}.md`;
          const messages = getDb()
            .query<MessageRow, [string]>("SELECT * FROM learning_messages WHERE session_id = ? ORDER BY ordinal ASC")
            .all(session.id);
          const markdown = this.sessionMarkdown(project, material, session, messages, artifacts);
          await writeFile(join(sessionsDir, fileName), markdown, "utf8");
          sessionCount += 1;
        }
      }

      const fileName = `${safeFilePart(project.title, "project")}-learning-archive-${stamp()}.zip`;
      const zipPath = join(outDir, fileName);
      if (existsSync(zipPath)) await rm(zipPath, { force: true });
      await writeZipFromDirectory(staging, zipPath);
      return { zipPath, fileName, sessionCount };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private sessionMarkdown(project: ProjectSummary, material: MaterialRow, session: SessionRow, messages: MessageRow[], artifacts: MaterialArtifacts | null) {
    const completedModuleIds = jsonArray(session.completed_module_ids_json);
    const totalModuleCount = artifacts?.coursePlan.modules.length || 0;
    const currentModuleTitle = artifacts?.coursePlan.modules.find((module) => module.id === session.current_module_id)?.title || "";
    const sourceById = new Map((artifacts?.sourceChunks || []).map((chunk) => [chunk.id, chunk]));
    const index = artifacts?.sourceIndex || {};
    const lines = [
      `# ${session.title}`,
      "",
      `Project: ${project.title}`,
      `Material: ${material.title}`,
      `Status: ${session.status}`,
      `Model: ${session.model || ""}`,
      `Created: ${isoTime(session.created_at)}`,
      `Updated: ${isoTime(session.updated_at)}`,
      `Progress: ${completedModuleIds.length}/${totalModuleCount || "?"} modules`,
      currentModuleTitle ? `Current module: ${currentModuleTitle}` : "",
      "",
      "## Conversation",
      "",
    ].filter(Boolean);

    for (const message of messages) {
      lines.push(`### ${message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System"}`, "");
      lines.push(blocksToMarkdown(jsonBlocks(message.blocks_json), message.content), "");
      const refs = jsonArray(message.source_refs_json);
      if (refs.length) {
        lines.push("Sources:");
        for (const refId of refs) {
          const chunk = sourceById.get(refId);
          const meta = index[refId];
          lines.push(`- ${meta?.title || refId}${meta?.locator ? `, ${meta.locator}` : ""}${chunk?.text ? `: "${sourceExcerpt(chunk.text)}"` : ""}`);
        }
        lines.push("");
      }
    }
    return `${lines.join("\n").trim()}\n`;
  }

  folder(projectId?: string) {
    if (!projectId) return dataPath();
    const row = getDb().query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(projectId);
    return projectDirAt(row?.root_path || dataPath("projects"), projectId);
  }

  rootFor(projectId: string) {
    const row = getDb().query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!row) throw new Error("Project not found");
    return row.root_path || dataPath("projects");
  }

  async migrateUnsetProjectRoots(newRootPath: string) {
    await mkdir(newRootPath, { recursive: true });
    const legacyRoot = dataPath("projects");
    const rows = getDb()
      .query<ProjectRow, [string]>("SELECT * FROM projects WHERE root_path IS NULL OR root_path = '' OR root_path = ?")
      .all(legacyRoot);

    for (const row of rows) {
      const oldDir = join(row.root_path || legacyRoot, row.id);
      const newDir = join(newRootPath, row.id);
      if (oldDir !== newDir && existsSync(oldDir) && !existsSync(newDir)) {
        await moveDirectory(oldDir, newDir);
      } else {
        await mkdir(newDir, { recursive: true });
      }
      getDb().query("UPDATE projects SET root_path = ?, updated_at = ? WHERE id = ?").run(newRootPath, Date.now(), row.id);
      await writeProjectManifest(toProject({ ...row, root_path: newRootPath, updated_at: Date.now() }));
    }
    await syncProjectRootToDb(newRootPath);
  }
}

async function moveDirectory(from: string, to: string) {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, force: false, errorOnExist: true });
    await rm(from, { recursive: true, force: true });
  }
}
