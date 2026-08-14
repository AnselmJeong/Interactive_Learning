import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "./project-db";
import { SettingsService } from "./settings-service";
import { writeZipFromDirectory } from "./archive-writer";
import type { AnnotationReadableExport } from "../shared/rpc-types";
import type { NoteImageAttachment } from "../shared/artifact-types";
import { resolveNoteImageAsset } from "./annotation-image-assets";

type ExportAnnotationRow = {
  id: string;
  kind: string;
  selected_text: string;
  result_json: string;
  source_meta_json: string;
  anchor_json: string | null;
  created_at: number;
  document_title: string | null;
  document_type: "book" | "article" | null;
  source_title: string | null;
  project_title: string;
};

function safeFilePart(value: string, fallback = "annotations") {
  return value.replace(/[\\/:*?"<>|#{}\[\]`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || fallback;
}

function stamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function collisionSafePath(folder: string, baseName: string) {
  const stem = baseName.endsWith(".zip") ? baseName.slice(0, -4) : baseName;
  let candidate = join(folder, `${stem}.zip`);
  for (let index = 2; existsSync(candidate); index += 1) candidate = join(folder, `${stem}-${index}.zip`);
  return candidate;
}

function json<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function resultMarkdown(raw: string, noteImageMarkdown = "") {
  const result = json<Record<string, unknown>>(raw, {});
  if (result.kind === "note" && typeof result.note === "string") return [result.note.trim(), noteImageMarkdown].filter(Boolean).join("\n\n");
  if (result.kind === "question_thread" && Array.isArray(result.messages)) {
    return result.messages.map((message) => {
      const item = message as Record<string, unknown>;
      if (typeof item.content !== "string") return "";
      return `**${item.role === "user" ? "Learner" : "Tutor"}:** ${item.content}`;
    }).filter(Boolean).join("\n\n");
  }
  const body = [result.body, result.question, result.answer]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .join("\n\n");
  if (result.kind === "image" && Array.isArray(result.images)) {
    const images = result.images.map((image) => {
      const item = image as Record<string, unknown>;
      const url = typeof item.imageUrl === "string" ? item.imageUrl : typeof item.pageUrl === "string" ? item.pageUrl : "";
      const title = typeof item.title === "string" ? item.title : "Image";
      return url ? `- [${title}](${url})` : `- ${title}`;
    }).filter(Boolean).join("\n");
    return [body, images].filter(Boolean).join("\n\n");
  }
  return body.trim();
}

function noteImages(raw: string) {
  const result = json<{ kind?: string; images?: NoteImageAttachment[] }>(raw, {});
  return result.kind === "note" && Array.isArray(result.images) ? result.images : [];
}

function sourceLinks(raw: string) {
  return json<Array<{ title?: string; url?: string }>>(raw, [])
    .map((source) => source.url ? `- [${source.title || source.url}](${source.url})` : source.title ? `- ${source.title}` : "")
    .filter(Boolean);
}

export class AnnotationExportService {
  private readonly settings = new SettingsService();

  async exportReadable(projectId: string, annotationIds: string[], destinationFolder?: string): Promise<AnnotationReadableExport> {
    const ids = [...new Set(annotationIds.filter(Boolean))];
    if (!ids.length) throw new Error("내보낼 annotation이 없습니다.");
    const placeholders = ids.map(() => "?").join(", ");
    const rows = getDb().query<ExportAnnotationRow, string[]>(`
      SELECT a.id, a.kind, a.selected_text, a.result_json, a.source_meta_json, a.anchor_json, a.created_at,
             d.title AS document_title, d.document_type, s.title AS source_title, p.title AS project_title
      FROM material_annotations a
      JOIN projects p ON p.id = a.project_id
      LEFT JOIN project_sources s ON s.id = a.source_id
      LEFT JOIN project_documents d ON d.id = s.document_id
      WHERE a.project_id = ? AND a.id IN (${placeholders})
      ORDER BY COALESCE(d.imported_at, 0), COALESCE(s.source_ordinal, 0), a.created_at
    `).all(projectId, ...ids);
    if (rows.length !== ids.length) throw new Error("일부 annotation이 현재 project에 없으므로 내보내기를 중단했습니다.");

    const projectTitle = rows[0]!.project_title;
    const lines = [
      `# ${projectTitle} — 하이라이트와 노트`,
      "",
      `내보낸 기록: ${rows.length}개`,
      `생성 시각: ${new Date().toISOString()}`,
      "",
    ];
    let currentDocument = "";
    let currentSource = "";
    const assetsToCopy: Array<{ sourcePath: string; relativePath: string }> = [];
    for (const row of rows) {
      const documentTitle = row.document_title || "분류되지 않은 자료";
      if (documentTitle !== currentDocument) {
        currentDocument = documentTitle;
        currentSource = "";
        lines.push(`## ${documentTitle}`, "");
      }
      if (row.document_type !== "article" && row.source_title && row.source_title !== currentSource) {
        currentSource = row.source_title;
        lines.push(`### ${row.source_title}`, "");
      }
      const kindLabel = row.kind === "note" ? "노트" : row.kind === "highlight" ? "하이라이트" : row.kind === "question" ? "질문" : row.kind === "image" ? "이미지" : "찾아보기";
      lines.push(`#### ${kindLabel} · ${new Date(row.created_at).toLocaleString("ko-KR")}`, "", `> ${row.selected_text.replace(/\n/g, "\n> ")}`, "");
      const imageLines = noteImages(row.result_json).map((image) => {
        const asset = resolveNoteImageAsset(row.id, image.id);
        if (!asset) return "";
        const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1] || "img";
        const relativePath = `assets/${row.id}-${image.id}.${extension}`;
        assetsToCopy.push({ sourcePath: asset.path, relativePath });
        return `![${image.fileName.replace(/[\[\]]/g, " ")}](${relativePath})`;
      }).filter(Boolean).join("\n\n");
      const body = resultMarkdown(row.result_json, imageLines);
      if (body) lines.push(body, "");
      const links = sourceLinks(row.source_meta_json);
      if (links.length) lines.push("참고:", ...links, "");
    }

    const settings = await this.settings.get();
    const outDir = destinationFolder || settings.defaultDownloadFolder;
    await mkdir(outDir, { recursive: true });
    const fileName = `${safeFilePart(projectTitle)}-annotations-${stamp()}.zip`;
    const zipPath = collisionSafePath(outDir, fileName);
    const staging = await mkdtemp(join(tmpdir(), "learnie-annotation-export-"));
    const exportRoot = join(staging, `${safeFilePart(projectTitle)}-annotations`);
    try {
      await mkdir(exportRoot, { recursive: true });
      if (assetsToCopy.length) {
        await mkdir(join(exportRoot, "assets"), { recursive: true });
        await Promise.all(assetsToCopy.map((asset) => copyFile(asset.sourcePath, join(exportRoot, asset.relativePath))));
      }
      await writeFile(join(exportRoot, "annotations.md"), `${lines.join("\n").trim()}\n`, "utf8");
      await writeZipFromDirectory(staging, zipPath);
      return { zipPath, fileName: zipPath.split("/").pop() || fileName, projectId, annotationCount: rows.length, assetCount: assetsToCopy.length };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
