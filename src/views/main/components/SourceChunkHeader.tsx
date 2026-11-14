import { cleanHeadingParts, comparableHeadingTitle, displayableHeadingPath } from "../../../shared/display-title";

export function SourceChunkHeader({ headingPath, previousHeadingPath = [], locator, status }: {
  headingPath: string[];
  previousHeadingPath?: string[];
  locator: string;
  status: "covered" | "current" | "upcoming";
}) {
  const parts = cleanHeadingParts(headingPath);
  const previous = cleanHeadingParts(previousHeadingPath);
  const sameSection = parts.length === previous.length && parts.every((part, index) =>
    comparableHeadingTitle(part) === comparableHeadingTitle(previous[index]!));
  const title = sameSection ? "" : parts.at(-1);
  const locatorKey = comparableHeadingTitle(locator);
  const repeatsTitle = parts.some((part) => comparableHeadingTitle(part) === locatorKey)
    || comparableHeadingTitle(displayableHeadingPath(parts)) === locatorKey;
  const location = locatorKey && locatorKey !== "document" && !repeatsTitle ? locator : "";

  return <>
    <header className="source-chunk-header">
      {title ? <h4 className="source-heading">{title}</h4> : null}
      <span className="source-chunk-status">{status === "current" ? "진행 중" : status === "covered" ? "다룸" : "예정"}</span>
    </header>
    {location ? <p className="source-chunk-location">{location}</p> : null}
  </>;
}
