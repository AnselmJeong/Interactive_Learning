import { memo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";

const remarkPlugins: PluggableList = [[remarkGfm, { singleTilde: false }], remarkMath];

const PROTECTED_MARKDOWN_SEGMENT = /(```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$)/g;
const RAW_LATEX_COMMAND = /\\(?:frac|dfrac|tfrac|sqrt|mathrm|mathbf|mathit|text|operatorname|tau|theta|lambda|alpha|beta|gamma|delta|sigma|omega)(?=[^A-Za-z]|$)/u;
const BARE_SUBSCRIPT_IDENTIFIER = /(^|[^A-Za-z0-9\u0370-\u03ff\\/$])((?:[A-Za-z\u0370-\u03ff]|alpha|beta|gamma|delta|theta|lambda|mu|sigma|tau|omega)(?:\\?_[A-Za-z0-9\u0370-\u03ff]+)+)(?=$|[^A-Za-z0-9\u0370-\u03ff_])/giu;
const BARE_INDEX_SHORTHAND = /(^|[^A-Za-z0-9\u0370-\u03ff\\/$])([stwx])([ij]{1,2})(?=$|[^A-Za-z0-9\u0370-\u03ff_])/gu;
const BARE_DESCRIPTIVE_SHORTHAND = /(^|[^A-Za-z0-9\u0370-\u03ff\\/$])([GVg])(syn|Na|K|Ca|leak)(?=$|[^A-Za-z0-9\u0370-\u03ff_])/gu;

function mathSubscript(part: string) {
  if (part.length === 1 || /^\d+$/u.test(part)) return part;
  return `\\mathrm{${part}}`;
}

function wrapBareSubscriptIdentifiers(segment: string) {
  return segment
    .replace(BARE_SUBSCRIPT_IDENTIFIER, (_, prefix: string, identifier: string) => {
      const [base = "", ...subscripts] = identifier.replace(/\\_/gu, "_").split("_");
      const subscript = subscripts.map(mathSubscript).join(",");
      return `${prefix}$${base}_{${subscript}}$`;
    })
    .replace(BARE_INDEX_SHORTHAND, (_, prefix: string, base: string, indices: string) => `${prefix}$${base}_{${indices}}$`)
    .replace(BARE_DESCRIPTIVE_SHORTHAND, (_, prefix: string, base: string, descriptor: string) => `${prefix}$${base}_{\\mathrm{${descriptor}}}$`);
}

/**
 * Older selections copied all three KaTeX text layers (MathML, TeX source,
 * and visual HTML). Keep the TeX source and remove only the adjacent rendered
 * duplicates so saved side-chat headings become valid inline math again.
 */
export function normalizeLegacySelectedMath(content: string) {
  if (content.includes("$") || content.includes("\\(") || content.includes("\\[") || content.includes("\\)") || content.includes("\\]")) return content;
  const command = RAW_LATEX_COMMAND.exec(content);
  if (!command || command.index < 0) return content;
  const asciiFormula = content.slice(command.index).match(/^[\x20-\x7e]+/u)?.[0] || "";
  const latex = asciiFormula.trim();
  if (!latex) return content;
  const rawPrefix = content.slice(0, command.index);
  const lastSpace = rawPrefix.lastIndexOf(" ");
  const renderedPrefix = rawPrefix.slice(lastSpace + 1);
  const prefix = /[\u0370-\u03ff=−]/u.test(renderedPrefix) ? rawPrefix.slice(0, lastSpace + 1) : rawPrefix;
  const rawSuffix = content.slice(command.index + asciiFormula.length);
  const koreanSuffixIndex = rawSuffix.search(/[가-힣]/u);
  const renderedSuffix = koreanSuffixIndex > 0 ? rawSuffix.slice(0, koreanSuffixIndex) : "";
  const suffix = koreanSuffixIndex > 0 && /[\u0370-\u03ff=−\u200b-\u200d]/u.test(renderedSuffix)
    ? rawSuffix.slice(koreanSuffixIndex)
    : rawSuffix;
  return `${prefix}$${latex}$${suffix}`;
}

export function normalizeMarkdownContent(content: string): string {
  return normalizeLegacySelectedMath(content)
    .split(PROTECTED_MARKDOWN_SEGMENT)
    .map((segment) => {
      if (segment.startsWith("$$")) return `\n$$\n${segment.slice(2, -2).trim()}\n$$\n`;
      if (segment.startsWith("```") || segment.startsWith("`") || segment.startsWith("$")) return segment;
      const normalized = segment
        .replace(/\\\[([\s\S]*?)\\\]/gu, (_, formula: string) => `\n$$\n${formula.trim()}\n$$\n`)
        .replace(/\\\(([^\n]*?)\\\)/gu, (_, formula: string) => `$${formula.trim()}$`)
        .replace(/(\*{1,3})[\u200b\u200c\u200d\ufeff]+/gu, "$1")
        .replace(/[\u200b\u200c\u200d\ufeff]+(\*{1,3})/gu, "$1")
        .replace(/\\\*\\\*\\\*/gu, "***")
        .replace(/\\\*\\\*/gu, "**")
        .replace(/\\(\*{2,3})(?=\S)/gu, "$1")
        .replace(/(?<=\S)\\(\*{2,3})/gu, "$1")
        .replace(/(?<=[\p{P}\p{S}])(\*{2,3})(?=[\u3131-\u318e\uac00-\ud7a3])/gu, "$1&ZeroWidthSpace;");
      return wrapBareSubscriptIdentifiers(normalized);
    })
    .join("");
}

export function normalizeInlineMarkdownContent(content: string) {
  return normalizeMarkdownContent(content)
    .replace(/\$\$\s*([\s\S]*?)\s*\$\$/gu, (_, formula: string) => `$${formula.trim()}$`)
    .replace(/\s*\n+\s*/gu, " ")
    .trim();
}

const markdownComponents = {
  table({ children }: { children?: ReactNode }) {
    return (
      <div className="markdown-table-scroll">
        <table>{children}</table>
      </div>
    );
  },
  a({ href, children }: { href?: string; children?: ReactNode }) {
    const safeHref = href || "";
    return <a href={safeHref} target="_blank" rel="noreferrer">{children}</a>;
  },
  img({ src, alt }: { src?: string; alt?: string }) {
    return (
      <figure className="markdown-figure">
        <img src={src || ""} alt={alt || ""} />
        {alt ? <figcaption>{alt}</figcaption> : null}
      </figure>
    );
  },
  del({ children }: { children?: ReactNode }) {
    return <span>{children}</span>;
  },
  code({ className, children, ...props }: ComponentPropsWithoutRef<"code">) {
    const inline = !className;
    return (
      <code className={className} {...props}>
        {inline ? children : String(children).replace(/\n$/, "")}
      </code>
    );
  },
};

export const MarkdownContent = memo(function MarkdownContent({ content, compact = false }: { content: string; compact?: boolean }) {
  return (
    <div className={`markdown-content ${compact ? "compact" : ""}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeKatex]}
        components={markdownComponents}
      >
        {normalizeMarkdownContent(content)}
      </ReactMarkdown>
    </div>
  );
});

export const InlineMarkdownContent = memo(function InlineMarkdownContent({ content }: { content: string }) {
  return (
    <span className="inline-markdown-content">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeKatex]}
        disallowedElements={["p"]}
        unwrapDisallowed
        components={markdownComponents}
      >
        {normalizeInlineMarkdownContent(content)}
      </ReactMarkdown>
    </span>
  );
});
