import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

function normalizeCjkAdjacentEmphasis(content: string): string {
  return content
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((segment) => {
      if (segment.startsWith("```") || segment.startsWith("`")) return segment;
      return segment
        .replace(/(?<=[^*\s])(\*{1,3})(?=\p{Script=Hangul})/gu, "$1\u200b")
        .replace(/(?<=[^*\s])(\*{1,3})(?=[:：.,;!?…)\]\}\p{Script=Hangul}])/gu, "$1\u200b");
    })
    .join("");
}

export const MarkdownContent = memo(function MarkdownContent({ content, compact = false }: { content: string; compact?: boolean }) {
  return (
    <div className={`markdown-content ${compact ? "compact" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
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
        {normalizeCjkAdjacentEmphasis(content)}
      </ReactMarkdown>
    </div>
  );
});
