import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { basename } from "node:path";
import type { ImageLookupItem } from "../shared/artifact-types";

type ResolveHost = (hostname: string) => Promise<string[]>;

const MAX_DIRECT_IMAGE_BYTES = 6_000_000;
const MAX_REDIRECTS = 4;
const ALLOWED_IMAGE_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);

function isBlockedIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const a = parts[0]!;
  const b = parts[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

export function isPublicImageAddress(address: string) {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(normalized);
  if (version === 4) return !isBlockedIpv4(normalized);
  if (version !== 6) return false;
  const mappedIpv4 = /(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  if (mappedIpv4) return !isBlockedIpv4(mappedIpv4);
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

async function defaultResolveHost(hostname: string) {
  if (isIP(hostname)) return [hostname];
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

async function assertPublicImageUrl(url: URL, resolveHost: ResolveHost) {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("이미지 링크는 http 또는 https 주소여야 합니다.");
  }
  if (url.username || url.password) throw new Error("인증 정보가 포함된 이미지 링크는 사용할 수 없습니다.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error("로컬 주소의 이미지는 불러올 수 없습니다.");
  }
  const addresses = await resolveHost(hostname);
  if (!addresses.length || addresses.some((address) => !isPublicImageAddress(address))) {
    throw new Error("로컬 또는 사설 네트워크의 이미지는 불러올 수 없습니다.");
  }
}

function imageTitle(url: URL) {
  const filename = decodeURIComponent(basename(url.pathname)).replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
  return filename || url.hostname;
}

export function directImageUrl(value: string) {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    return new URL(trimmed);
  } catch {
    throw new Error("올바른 이미지 URL을 입력해 주세요.");
  }
}

export async function loadDirectImage(
  input: URL,
  fetchImpl: typeof fetch = fetch,
  resolveHost: ResolveHost = defaultResolveHost
): Promise<ImageLookupItem> {
  let current = new URL(input.toString());

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicImageUrl(current, resolveHost);
    const response = await fetchImpl(current.toString(), {
      redirect: "manual",
      headers: {
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "user-agent": "Learnie/0.7.5 desktop learning app",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("이미지 링크의 redirect 위치가 비어 있습니다.");
      if (redirects === MAX_REDIRECTS) throw new Error("이미지 링크의 redirect가 너무 많습니다.");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`이미지 링크를 불러오지 못했습니다 (HTTP ${response.status}).`);

    const mimeType = (response.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() || "";
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) throw new Error("링크가 지원되는 이미지 파일을 가리키지 않습니다.");
    const contentLength = Number(response.headers.get("content-length") || "0");
    if (contentLength > MAX_DIRECT_IMAGE_BYTES) throw new Error("이미지 파일이 6MB 제한을 초과합니다.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DIRECT_IMAGE_BYTES) throw new Error("이미지 파일이 6MB 제한을 초과합니다.");

    return {
      title: imageTitle(current),
      thumbnailUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
      imageUrl: current.toString(),
      pageUrl: current.toString(),
      sourceTitle: current.hostname,
      provider: "direct",
    };
  }

  throw new Error("이미지 링크를 불러오지 못했습니다.");
}
