import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Utils } from "electrobun/bun";
import { defaultUserDataBase } from "./platform-utils";

const APP_DATA_DIR_NAME = "learnie";

function ensureDir(path: string) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
  return path;
}

export function appDataDir() {
  const base = process.env.LEARNIE_APP_DATA_ROOT || defaultUserDataBase({ electrobunUserData: Utils.paths.userData });
  return ensureDir(join(base, APP_DATA_DIR_NAME));
}

export function dataPath(...parts: string[]) {
  return join(appDataDir(), ...parts);
}

export function projectRoot() {
  return resolve(process.env.LEARNIE_PROJECT_ROOT || process.env.INTERACTIVE_LEARNING_PROJECT_ROOT || process.cwd());
}

export function projectDir(projectId: string) {
  return ensureDir(dataPath("projects", projectId));
}

export function projectDirAt(rootPath: string, projectId: string) {
  return ensureDir(join(rootPath, projectId));
}

export function sourceDir(projectId: string, sourceId: string) {
  return ensureDir(join(projectDir(projectId), "sources", sourceId));
}

export function sourceDirAt(rootPath: string, projectId: string, sourceId: string) {
  return ensureDir(join(projectDirAt(rootPath, projectId), "sources", sourceId));
}

export function materialDir(projectId: string, materialId: string) {
  return ensureDir(join(projectDir(projectId), "materials", materialId));
}

export function materialDirAt(rootPath: string, projectId: string, materialId: string) {
  return ensureDir(join(projectDirAt(rootPath, projectId), "materials", materialId));
}

export function cacheDir(...parts: string[]) {
  return ensureDir(dataPath("cache", ...parts));
}
