const PROTECTED_MARKDOWN_SEGMENT = /(```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$)/g;

/** Split structural Markdown pipes without splitting pipes inside code or math. */
export function splitMarkdownPipes(value: string) {
  const parts = [""];
  value.split(PROTECTED_MARKDOWN_SEGMENT).forEach((segment, index) => {
    if (index % 2 === 1) {
      parts[parts.length - 1] += segment;
      return;
    }
    const unprotectedParts = segment.split("|");
    parts[parts.length - 1] += unprotectedParts[0] || "";
    for (const part of unprotectedParts.slice(1)) parts.push(part);
  });
  return parts;
}

/**
 * Older messages may have split one display equation into a flow block at the
 * conditional-probability bars. Reassemble only that unmistakable shape.
 */
export function restoreLegacyDisplayMathFlow(title: string | undefined, steps: string[]) {
  const first = title?.trim() || "";
  const last = steps.at(-1)?.trim() || "";
  if (!first.startsWith("$$") || first.endsWith("$$") || !last.endsWith("$$") || steps.length < 2) return null;
  return [first, ...steps].join("|");
}
