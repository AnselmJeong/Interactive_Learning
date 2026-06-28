import { cp, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDb } from "./project-db";
import { dataPath, projectDirAt } from "./paths";
import type { ProjectSummary } from "../shared/rpc-types";
import { SettingsService } from "./settings-service";

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

export class ProjectService {
  private readonly settings = new SettingsService();

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
    return this.open(id);
  }

  list() {
    const rows = getDb()
      .query<ProjectRow, []>(
        `SELECT * FROM projects
         WHERE archived_at IS NULL
         ORDER BY COALESCE(last_opened_at, updated_at) DESC`
      )
      .all();
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
    return true;
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
    }
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
