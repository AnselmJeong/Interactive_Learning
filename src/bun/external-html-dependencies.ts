import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExternalHtmlDependency } from "../shared/artifact-types";
import { projectRoot } from "./paths";

export type ExternalHtmlDependencyPolicy = {
  sourceUrl: string;
  name: string;
  version: string;
  bundledAssetId: string;
  bundledAssetPath: string;
  sha256: string;
  licenseAssetPath: string;
  licenseSha256: string;
  license: string;
  transform: "inline_script" | "inline_style";
};

export const EXTERNAL_HTML_DEPENDENCY_REGISTRY = [
  {
    sourceUrl: "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js",
    name: "chart.js",
    version: "4.4.1",
    bundledAssetId: "chart.js-4.4.1-umd",
    bundledAssetPath: "external-html-dependencies/chart.js-4.4.1.umd.js",
    sha256: "74401d738dd3e03ee5dfb3b6841210fe2c4ead8a960c4011ca4ba0b78a9fd8f3",
    licenseAssetPath: "external-html-dependencies/chart.js-4.4.1-LICENSE.md",
    licenseSha256: "5a0877ad6d818529be4f33009d0942cdf7e2ed7656156f4aba7308459a546030",
    license: "MIT",
    transform: "inline_script",
  },
] as const satisfies readonly ExternalHtmlDependencyPolicy[];

function sha256(bytes: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function dependencyCandidates(policy: ExternalHtmlDependencyPolicy, license: boolean) {
  const packagedRelative = license ? policy.licenseAssetPath : policy.bundledAssetPath;
  const sourceRelative = license ? "node_modules/chart.js/LICENSE.md" : "node_modules/chart.js/dist/chart.umd.js";
  const executableDir = dirname(process.execPath);
  return [
    resolve(projectRoot(), sourceRelative),
    resolve(executableDir, "..", "Resources", "app", packagedRelative),
    resolve(executableDir, "Resources", "app", packagedRelative),
    resolve(process.cwd(), packagedRelative),
  ];
}

async function readVerified(candidates: string[], expectedSha256: string, label: string) {
  const path = candidates.find(existsSync);
  if (!path) throw new Error(`${label} bundled asset is missing`);
  const bytes = await readFile(path);
  if (sha256(bytes) !== expectedSha256) throw new Error(`${label} bundled asset hash mismatch`);
  return bytes;
}

export async function loadExternalHtmlDependency(policy: ExternalHtmlDependencyPolicy) {
  const [bytes, licenseBytes] = await Promise.all([
    readVerified(dependencyCandidates(policy, false), policy.sha256, `${policy.name} ${policy.version}`),
    readVerified(dependencyCandidates(policy, true), policy.licenseSha256, `${policy.name} license`),
  ]);
  const metadata: ExternalHtmlDependency = {
    name: policy.name,
    version: policy.version,
    originalUrl: policy.sourceUrl,
    bundledAssetId: policy.bundledAssetId,
    sha256: policy.sha256,
    license: policy.license,
  };
  return { bytes, licenseBytes, metadata };
}

export function dependencyPolicyForUrl(url: string) {
  return EXTERNAL_HTML_DEPENDENCY_REGISTRY.find((policy) => policy.sourceUrl === url) || null;
}
