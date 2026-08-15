import { parse, serialize, type DefaultTreeAdapterTypes } from "parse5";
import type { ExternalHtmlDependency, ExternalHtmlImportRejection } from "../shared/artifact-types";
import { dependencyPolicyForUrl, loadExternalHtmlDependency } from "./external-html-dependencies";

export const MAX_EXTERNAL_HTML_ORIGINAL_BYTES = 2 * 1024 * 1024;
export const MAX_EXTERNAL_HTML_RUNNABLE_BYTES = 5 * 1024 * 1024;
export const EXTERNAL_HTML_IMPORTER_VERSION = 1 as const;

const FORBIDDEN_ELEMENTS = new Map([
  ["iframe", "중첩 frame"], ["frame", "중첩 frame"], ["object", "외부 object"], ["embed", "외부 embed"],
  ["portal", "portal"], ["base", "base URL 변경"], ["form", "form 제출"],
]);
const URL_ATTRIBUTES = new Set(["src", "href", "action", "formaction", "poster", "data", "xlink:href"]);
const BLOCKED_SCRIPT_PATTERNS: Array<[RegExp, string, string]> = [
  [/\bnavigator\s*\.\s*serviceWorker\b/i, "service_worker", "Service Worker는 지원하지 않습니다."],
  [/\bnew\s+(?:Shared)?Worker\s*\(/i, "worker", "Web Worker는 지원하지 않습니다."],
  [/\bimportScripts\s*\(/i, "import_scripts", "importScripts는 지원하지 않습니다."],
  [/\bimport\s*\(/i, "dynamic_import", "동적 import는 지원하지 않습니다."],
  [/\bWebAssembly\b/i, "webassembly", "WebAssembly는 지원하지 않습니다."],
  [/\bwindow\s*\.\s*open\s*\(/i, "popup", "새 창 열기는 지원하지 않습니다."],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/i, "network_api", "네트워크 API는 사용할 수 없습니다."],
  [/\bnavigator\s*\.\s*(?:clipboard|geolocation)\b/i, "device_api", "Clipboard와 위치 API는 사용할 수 없습니다."],
  [/\bgetUserMedia\s*\(/i, "media_capture", "카메라와 마이크는 사용할 수 없습니다."],
];

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;

export type PreparedExternalHtml = {
  title: string;
  originalText: string;
  runnableText: string;
  dependencies: ExternalHtmlDependency[];
  dependencyLicenses: Array<{ fileName: string; bytes: Uint8Array }>;
  rejectionReasons: ExternalHtmlImportRejection[];
};

function rejection(code: string, message: string): ExternalHtmlImportRejection {
  return { code, message };
}

function isElement(node: Node): node is Element {
  return "tagName" in node && Array.isArray(node.attrs);
}

function attr(element: Element, name: string) {
  return element.attrs.find((item) => item.name.toLowerCase() === name)?.value || "";
}

function textContent(node: DefaultTreeAdapterTypes.ParentNode): string {
  return node.childNodes.map((child) => {
    if ("value" in child) return child.value;
    return "childNodes" in child ? textContent(child) : "";
  }).join("");
}

function cleanTitle(value: string, fallback: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
}

function urlIsAllowedInline(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.startsWith("#")) return true;
  if (/^data:(?:image\/(?:png|jpeg|webp|gif)|font\/)/i.test(normalized)) return true;
  return normalized.startsWith("blob:");
}

function cssRemoteUrls(value: string) {
  return [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)]
    .map((match) => match[2]?.trim() || "")
    .filter((url) => !urlIsAllowedInline(url));
}

function pushOnce(rejections: ExternalHtmlImportRejection[], item: ExternalHtmlImportRejection) {
  if (!rejections.some((existing) => existing.code === item.code && existing.message === item.message)) rejections.push(item);
}

export async function prepareExternalHtmlBytes(bytes: Uint8Array, originalFileName: string): Promise<PreparedExternalHtml> {
  const rejections: ExternalHtmlImportRejection[] = [];
  if (!bytes.length) rejections.push(rejection("empty_file", "HTML 파일이 비어 있습니다."));
  if (bytes.length > MAX_EXTERNAL_HTML_ORIGINAL_BYTES) rejections.push(rejection("original_too_large", "HTML 원본은 2 MiB 이하여야 합니다."));
  if (bytes.includes(0)) rejections.push(rejection("nul_byte", "NUL byte가 포함된 파일은 지원하지 않습니다."));
  let originalText = "";
  try {
    originalText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    rejections.push(rejection("invalid_utf8", "UTF-8 HTML 파일만 가져올 수 있습니다."));
  }
  const fallbackTitle = originalFileName.replace(/\.(?:html?|HTML?)$/, "").trim() || "대화형 설명";
  if (!/<html(?:\s|>)/i.test(originalText)) rejections.push(rejection("missing_html_root", "완전한 HTML 문서(<html>)만 가져올 수 있습니다."));
  const document = parse(originalText);
  let title = fallbackTitle;
  const dependencies: ExternalHtmlDependency[] = [];
  const dependencyLicenses: Array<{ fileName: string; bytes: Uint8Array }> = [];
  const dependencyNodes: Array<{ element: Element; url: string }> = [];

  const walk = (node: Node) => {
    if (!isElement(node)) return;
    const tag = node.tagName.toLowerCase();
    const forbidden = FORBIDDEN_ELEMENTS.get(tag);
    if (forbidden) pushOnce(rejections, rejection(`forbidden_${tag}`, `${forbidden} 요소는 지원하지 않습니다.`));
    if (tag === "title") title = cleanTitle(textContent(node), fallbackTitle);
    if (tag === "meta" && attr(node, "http-equiv").toLowerCase() === "refresh") {
      pushOnce(rejections, rejection("meta_refresh", "자동 페이지 이동은 지원하지 않습니다."));
    }
    if (node.attrs.some((item) => item.name.toLowerCase() === "download")) {
      pushOnce(rejections, rejection("download", "파일 다운로드 동작은 지원하지 않습니다."));
    }
    if (attr(node, "target").toLowerCase() === "_blank") {
      pushOnce(rejections, rejection("popup_target", "새 창에서 여는 링크는 지원하지 않습니다."));
    }
    if (tag === "input" && attr(node, "type").toLowerCase() === "file") {
      pushOnce(rejections, rejection("file_input", "파일 선택 input은 지원하지 않습니다."));
    }
    for (const attribute of node.attrs) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name === "style") {
        for (const url of cssRemoteUrls(value)) pushOnce(rejections, rejection("remote_css_url", `외부 CSS resource는 지원하지 않습니다: ${url.slice(0, 160)}`));
      }
      if (!URL_ATTRIBUTES.has(name) || !value) continue;
      if (tag === "script" && name === "src") {
        const policy = dependencyPolicyForUrl(value);
        if (policy) dependencyNodes.push({ element: node, url: value });
        else pushOnce(rejections, rejection("unsupported_dependency", `지원 목록에 없는 외부 script입니다: ${value.slice(0, 160)}`));
      } else if (!urlIsAllowedInline(value)) {
        pushOnce(rejections, rejection("remote_resource", `외부 resource 또는 이동 URL은 지원하지 않습니다: ${value.slice(0, 160)}`));
      }
    }
    if (tag === "style") {
      for (const url of cssRemoteUrls(textContent(node))) pushOnce(rejections, rejection("remote_css_url", `외부 CSS resource는 지원하지 않습니다: ${url.slice(0, 160)}`));
    }
    if (tag === "script" && !attr(node, "src")) {
      const script = textContent(node);
      for (const [pattern, code, message] of BLOCKED_SCRIPT_PATTERNS) {
        if (pattern.test(script)) pushOnce(rejections, rejection(code, message));
      }
    }
    node.childNodes.forEach(walk);
    if (tag === "template" && "content" in node) node.content.childNodes.forEach(walk);
  };
  document.childNodes.forEach(walk);

  if (!rejections.length) {
    for (const dependencyNode of dependencyNodes) {
      const policy = dependencyPolicyForUrl(dependencyNode.url);
      if (!policy) continue;
      try {
        const loaded = await loadExternalHtmlDependency(policy);
        dependencyNode.element.attrs = dependencyNode.element.attrs.filter((item) => item.name.toLowerCase() !== "src");
        dependencyNode.element.childNodes = [{
          nodeName: "#text",
          value: new TextDecoder().decode(loaded.bytes),
          parentNode: dependencyNode.element,
        }];
        dependencies.push(loaded.metadata);
        dependencyLicenses.push({ fileName: `${loaded.metadata.name}.txt`, bytes: loaded.licenseBytes });
      } catch (error) {
        rejections.push(rejection("dependency_asset_invalid", (error as Error).message));
      }
    }
  }

  const provenance = `<!-- Learnie external HTML runnable snapshot; importer=${EXTERNAL_HTML_IMPORTER_VERSION} -->\n`;
  const runnableText = `${provenance}${serialize(document)}`;
  if (new TextEncoder().encode(runnableText).length > MAX_EXTERNAL_HTML_RUNNABLE_BYTES) {
    rejections.push(rejection("runnable_too_large", "변환된 실행본은 5 MiB 이하여야 합니다."));
  }
  return { title: cleanTitle(title, fallbackTitle), originalText, runnableText, dependencies, dependencyLicenses, rejectionReasons: rejections };
}
