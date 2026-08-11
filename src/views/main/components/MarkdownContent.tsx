import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";

const remarkPlugins: PluggableList = [[remarkGfm, { singleTilde: false }], remarkMath];

const PROTECTED_MARKDOWN_SEGMENT = /(```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$)/g;
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

export function normalizeMarkdownContent(content: string): string {
  return content
    .split(PROTECTED_MARKDOWN_SEGMENT)
    .map((segment) => {
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

export const MarkdownContent = memo(function MarkdownContent({ content, compact = false }: { content: string; compact?: boolean }) {
  return (
    <div className={`markdown-content ${compact ? "compact" : ""}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeKatex]}
        components={{
          table({ children }) {
            return (
              <div className="markdown-table-scroll">
                <table>{children}</table>
              </div>
            );
          },
          a({ href, children }) {
            const safeHref = href || "";
            return (
              <a href={safeHref} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          img({ src, alt }) {
            return (
              <figure className="markdown-figure">
                <img src={src || ""} alt={alt || ""} />
                {alt ? <figcaption>{alt}</figcaption> : null}
              </figure>
            );
          },
          del({ children }) {
            return <span>{children}</span>;
          },
          code({ className, children, ...props }) {
            const inline = !className;
            if (inline) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...props}>
                {String(children).replace(/\n$/, "")}
              </code>
            );
          },
        }}
      >
        {normalizeMarkdownContent(content)}
      </ReactMarkdown>
    </div>
  );
});
