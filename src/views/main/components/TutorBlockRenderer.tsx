import type { TutorContentBlock } from "../../../shared/tutor-types";
import { MarkdownContent } from "./MarkdownContent";

export function TutorBlockRenderer({ blocks }: { blocks: TutorContentBlock[] }) {
  const visibleBlocks = blocks.filter((block) => block.type !== "source_quote" || block.showToLearner);
  if (!visibleBlocks.length) return null;

  return (
    <div className="tutor-block-stack">
      {visibleBlocks.map((block, index) => (
        <TutorBlock key={`${block.type}-${index}`} block={block} />
      ))}
    </div>
  );
}

function TutorBlock({ block }: { block: TutorContentBlock }) {
  if (block.type === "hook") {
    return (
      <section className="tutor-block hook-block">
        <p>{block.body}</p>
      </section>
    );
  }

  if (block.type === "source_quote") {
    if (!block.showToLearner) return null;
    return (
      <section className="tutor-block source-quote-block">
        <p>{block.quote}</p>
        <small>{block.attribution || block.sourceRef}</small>
      </section>
    );
  }

  if (block.type === "guided_reading") {
    return (
      <section className="tutor-block guided-reading-block">
        <span>함께 읽기</span>
        <MarkdownContent content={block.body} compact />
      </section>
    );
  }

  if (block.type === "paragraph") {
    return (
      <section className="tutor-block paragraph-block">
        <MarkdownContent content={block.body} compact />
      </section>
    );
  }

  if (block.type === "bullets") {
    return (
      <section className="tutor-block bullet-block">
        {block.title ? <h4>{block.title}</h4> : null}
        <ul>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    );
  }

  if (block.type === "compare_table") {
    return (
      <section className="tutor-block compare-table-block">
        {block.title ? <h4>{block.title}</h4> : null}
        <div className="block-table-scroll">
          <table>
            <thead>
              <tr>
                {block.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {block.columns.map((column) => (
                    <td key={column}>{row[column]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  if (block.type === "reflection") {
    return (
      <section className="tutor-block reflection-block">
        <span>생각해 볼 점</span>
        <p>{block.body}</p>
      </section>
    );
  }

  if (block.type === "misconception") {
    return (
      <section className="tutor-block misconception-block">
        <h4>{block.title || "헷갈릴 수 있는 지점"}</h4>
        <p>{block.body}</p>
        <strong>{block.repair}</strong>
      </section>
    );
  }

  return (
    <section className="tutor-block bridge-block">
      <p>{block.body}</p>
    </section>
  );
}
