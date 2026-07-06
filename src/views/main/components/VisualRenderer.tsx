import type { VisualSpec } from "../../../shared/artifact-types";
import { plainDisplayText } from "../../../shared/display-title";

function visualText(value: string) {
  return plainDisplayText(value) || value;
}

export function VisualRenderer({ visual }: { visual: VisualSpec }) {
  const displayVisual = toLearnerFacingVisual(visual);

  if (displayVisual.type === "flow" || displayVisual.type === "layers") {
    return (
      <div className="visual-block">
        <strong>{visualText(displayVisual.title)}</strong>
        <div className="flow-row">
          {displayVisual.items.map((item) => (
            <span key={item}>{visualText(item)}</span>
          ))}
        </div>
      </div>
    );
  }
  if (displayVisual.type === "contrast") {
    return (
      <div className="visual-block">
        <strong>{visualText(displayVisual.title)}</strong>
        <div className="contrast-grid">
          <div><b>{visualText(displayVisual.left.label)}</b><p>{displayVisual.left.body}</p></div>
          <div><b>{visualText(displayVisual.right.label)}</b><p>{displayVisual.right.body}</p></div>
        </div>
      </div>
    );
  }
  if (displayVisual.type === "grid") {
    return (
      <div className="visual-block">
        <strong>{visualText(displayVisual.title)}</strong>
        <div className="mini-grid">
          {displayVisual.items.map((item) => (
            <span key={item.label}><b>{visualText(item.label)}</b>{item.value}</span>
          ))}
        </div>
      </div>
    );
  }
  if (displayVisual.type === "timeline") {
    return (
      <div className="visual-block">
        <strong>{visualText(displayVisual.title)}</strong>
        <div className="timeline-list">
          {displayVisual.events.map((event) => (
            <div key={`${event.marker || ""}-${event.label}`}>
              <b>{visualText(event.marker ? `${event.marker} · ${event.label}` : event.label)}</b>
              <small>{event.body}</small>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (displayVisual.type === "axis") {
    return (
      <div className="visual-block">
        <strong>{visualText(displayVisual.title)}</strong>
        <div className="axis-visual">
          <div className="axis-end">
            <b>{visualText(displayVisual.left.label)}</b>
            <small>{displayVisual.left.caption}</small>
          </div>
          <div className="axis-line" aria-hidden="true">
            {displayVisual.markers.map((marker) => (
              <i key={marker.label} style={{ left: `${Math.max(0, Math.min(1, marker.position)) * 100}%` }}>
                <span>{visualText(marker.label)}</span>
              </i>
            ))}
          </div>
          <div className="axis-end">
            <b>{visualText(displayVisual.right.label)}</b>
            <small>{displayVisual.right.caption}</small>
          </div>
        </div>
      </div>
    );
  }
  if (displayVisual.type === "matrix") {
    return (
      <div className="visual-block">
        <strong>{visualText(displayVisual.title)}</strong>
        <div className="matrix-grid">
          {displayVisual.cells.map((cell) => (
            <span key={`${cell.row}-${cell.column}`}>
              <b>{visualText(`${cell.row} / ${cell.column}`)}</b>
              {cell.value}
            </span>
          ))}
        </div>
      </div>
    );
  }
  if (displayVisual.type === "annotated_table") {
    return (
      <div className="visual-block">
        <strong>{visualText(displayVisual.title)}</strong>
        <div className="block-table-scroll">
          <table className="annotated-table">
            <thead>
              <tr>
                {displayVisual.columns.map((column) => (
                  <th key={column}>{visualText(column)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayVisual.rows.map((row, index) => (
                <tr key={index}>
                  {displayVisual.columns.map((column, columnIndex) => (
                    <td key={column}>{row.cells[columnIndex]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  if (displayVisual.type === "geometry") {
    return (
      <div className="visual-block">
        <strong>{visualText(displayVisual.title)}</strong>
        <div className="geometry-row">
          {displayVisual.shapes.map((shape) => (
            <span key={`${shape.kind}-${shape.label}`}>
              <b>{visualText(shape.label)}</b>
              {shape.items?.length ? shape.items.map(visualText).join(" · ") : visualText(shape.kind)}
            </span>
          ))}
        </div>
        <p className="geometry-caption">{visualText(displayVisual.caption)}</p>
      </div>
    );
  }
  return (
    <div className="visual-block">
      <strong>{visualText(displayVisual.title)}</strong>
      <code>{displayVisual.formula}</code>
    </div>
  );
}

function toLearnerFacingVisual(visual: VisualSpec): VisualSpec {
  if (visual.type !== "annotated_table") return visual;
  if (!isLegacyTeachingGuideTable(visual)) return visual;

  const title = visualText(visual.title).replace(/\s*읽기\s*지도\s*$/, "");
  return {
    ...visual,
    title: `${title} 읽기 방향`,
    columns: ["읽기 포인트", "함께 볼 내용"],
    rows: [
      { cells: ["출발점", `${title}이 어떤 문제를 열고 있는지 먼저 잡습니다.`] },
      { cells: ["관계", "앞뒤 문장 사이에서 원인, 대비, 결과가 어떻게 이어지는지 봅니다."] },
      { cells: ["질문", "낯설게 들리는 표현은 외울 답이 아니라 다음 탐색의 실마리로 둡니다."] },
    ],
  };
}

function isLegacyTeachingGuideTable(visual: Extract<VisualSpec, { type: "annotated_table" }>) {
  const columnText = visual.columns.join(" ");
  const rowLabels = visual.rows.map((row) => row.cells[0]).join(" ");
  return (
    visual.title.includes("읽기 지도") ||
    columnText.includes("수업 재료") ||
    columnText.includes("메모") ||
    rowLabels.includes("핵심 발췌") ||
    rowLabels.includes("왜 중요한가") ||
    rowLabels.includes("생각할 거리")
  );
}
