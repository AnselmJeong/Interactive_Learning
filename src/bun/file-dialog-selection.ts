import { existsSync } from "node:fs";

type PathExists = (path: string) => boolean;

function cleanPath(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseJsonPathList(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(cleanPath).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function normalizeSelectedPaths(selection: unknown, pathExists: PathExists = existsSync) {
  if (Array.isArray(selection)) {
    return selection.map(cleanPath).filter((path) => path && pathExists(path));
  }

  const selectedPath = cleanPath(selection);
  if (!selectedPath) return [];
  if (pathExists(selectedPath)) return [selectedPath];

  const jsonPaths = parseJsonPathList(selectedPath);
  if (jsonPaths.length) return jsonPaths.filter(pathExists);

  return selectedPath.split(",").map((path) => path.trim()).filter((path) => path && pathExists(path));
}
