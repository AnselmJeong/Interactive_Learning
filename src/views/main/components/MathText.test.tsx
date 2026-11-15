import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { displayableOutlineTitle } from "../../../shared/display-title";
import { formatAroundMath, MathText, MathTitle, plainMathText } from "./MathText";

function texOf(html: string) {
  return [...html.matchAll(/encoding="application\/x-tex">([^<]*)</gu)].map((match) => match[1]);
}

describe("MathText", () => {
  test("renders delimited math in a heading", () => {
    const html = renderToStaticMarkup(<MathTitle title={"DC 계수는 평균의 $N$배다"} />);
    expect(texOf(html)).toEqual(["N"]);
    expect(html).not.toContain("$");
    expect(html).toContain("배다");
  });

  test("renders a diagram title with an expression", () => {
    const html = renderToStaticMarkup(<MathTitle title={"$N/2+1$이 나오는 경로"} />);
    expect(texOf(html)).toEqual(["N/2+1"]);
    expect(html).toContain("이 나오는 경로");
  });

  test("renders undelimited LaTeX and subscripts", () => {
    expect(texOf(renderToStaticMarkup(<MathText text={"주기 \\frac{1}{T}의 의미"} />))).toEqual(["\\frac{1}{T}"]);
    expect(texOf(renderToStaticMarkup(<MathText text={"f_i 의 역할"} />))).toEqual(["f_{i}"]);
  });

  test("title clean-up does not touch math", () => {
    const parts = formatAroundMath("**강조** 와 $a > b$", displayableOutlineTitle);
    expect(parts).toEqual([{ kind: "text", value: "강조 와 " }, { kind: "math", tex: "a > b" }]);
  });

  test("plain text keeps TeX without delimiters", () => {
    expect(plainMathText("평균의 $N$배")).toBe("평균의 N배");
    expect(plainMathText("수식 없음")).toBe("수식 없음");
  });
});
