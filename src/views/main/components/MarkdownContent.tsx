import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";

const remarkPlugins: PluggableList = [[remarkGfm, { singleTilde: false }], remarkMath];

export function normalizeMarkdownContent(content: string): string {
  return content
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((segment) => {
      if (segment.startsWith("```") || segment.startsWith("`")) return segment;
      return segment
        .replace(/(\*{1,3})[\u200b\u200c\u200d\ufeff]+/gu, "$1")
        .replace(/[\u200b\u200c\u200d\ufeff]+(\*{1,3})/gu, "$1")
        .replace(/\\\*\\\*\\\*/gu, "***")
        .replace(/\\\*\\\*/gu, "**")
        .replace(/\\(\*{2,3})(?=\S)/gu, "$1")
        .replace(/(?<=\S)\\(\*{2,3})/gu, "$1")
        .replace(/(?<=[\p{P}\p{S}])(\*{2,3})(?=[\u3131-\u318e\uac00-\ud7a3])/gu, "$1&ZeroWidthSpace;");
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
