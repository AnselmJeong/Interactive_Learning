import { describe, expect, test } from "bun:test";
import { displayableCourseTitle, displayableHeadingPath, displayableModuleTitle, displayableOutlineTitle, displayableSourceTitle, plainDisplayText, titleCasedSourceTitle } from "./display-title";

describe("display title text", () => {
  test("strips markdown bold wrappers from Korean module titles", () => {
    expect(plainDisplayText("**하나의 세계, 두 제국**")).toBe("하나의 세계, 두 제국");
    expect(plainDisplayText("**누가 야만인인가? 유목민과 농경민**")).toBe("누가 야만인인가? 유목민과 농경민");
  });

  test("repairs escaped markdown markers before display", () => {
    expect(plainDisplayText("\\*\\*중간 지대: 변경의 부상\\*\\*")).toBe("중간 지대: 변경의 부상");
  });

  test("keeps outline cleanup working after removing title markdown", () => {
    expect(displayableCourseTitle("**History course**")).toBe("History");
    expect(displayableOutlineTitle("Chapter 2 > **중간 지대: 변경의 부상**")).toBe("중간 지대: 변경의 부상");
    expect(displayableHeadingPath(["Roman course", "**누가 야만인인가? 유목민과 농경민**"], " › ", ["Roman course"])).toBe("누가 야만인인가? 유목민과 농경민");
  });

  test("preserves numbered source titles with periods", () => {
    expect(displayableSourceTitle("1. Turning Aristotle into Arithmetic", "chapter-1.md")).toBe("1. Turning Aristotle into Arithmetic");
  });

  test("removes redundant serial numbers only from module titles", () => {
    expect(displayableModuleTitle("1. Turning Aristotle into Arithmetic")).toBe("Turning Aristotle into Arithmetic");
    expect(displayableModuleTitle("02) Making Choices")).toBe("Making Choices");
    expect(displayableModuleTitle("[ 12 ] the rise and fall of scholasticism")).toBe("The Rise and Fall of Scholasticism");
    expect(displayableModuleTitle("【28】 -- materialistic atomism")).toBe("Materialistic Atomism");
    expect(displayableModuleTitle("### [7] FROM MYTH TO SCIENCE")).toBe("From Myth to Science");
    expect(displayableModuleTitle("resurrected self [ 71 ]")).toBe("Resurrected Self");
    expect(displayableModuleTitle("Chapter 9: modern philosophy")).toBe("Modern Philosophy");
    expect(displayableModuleTitle("제9장 데카르트")).toBe("데카르트");
    expect(displayableModuleTitle("Version 1.0")).toBe("Version 1.0");
    expect(displayableModuleTitle("1984 and Political Language")).toBe("1984 and Political Language");
  });

  test("applies English title case to module titles while preserving acronyms", () => {
    expect(displayableModuleTitle("From myth to Science")).toBe("From Myth to Science");
    expect(displayableModuleTitle("AI and the rise of DNA research")).toBe("AI and the Rise of DNA Research");
    expect(displayableModuleTitle("science: from myth to mind")).toBe("Science: From Myth to Mind");
  });

  test("removes only known file extensions from source fallbacks", () => {
    expect(displayableSourceTitle("", "/tmp/The Laws of Thought.md")).toBe("The Laws of Thought");
    expect(displayableSourceTitle("Version 1.0", "version.md")).toBe("Version 1.0");
  });

  test("applies title case to extracted all-uppercase titles", () => {
    expect(titleCasedSourceTitle("FROM MYTH TO SCIENCE")).toBe("From Myth to Science");
    expect(titleCasedSourceTitle("INDIVIDUALISM AND SUBJECTIVITY")).toBe("Individualism and Subjectivity");
    expect(titleCasedSourceTitle("PEOPLE OF THE BOOK")).toBe("People of the Book");
    expect(titleCasedSourceTitle("XII BEFORE THE FALL")).toBe("XII before the Fall");
  });

  test("capitalizes edge words and words following subtitle separators", () => {
    expect(titleCasedSourceTitle("SCIENCE: FROM MYTH TO MIND")).toBe("Science: From Myth to Mind");
    expect(titleCasedSourceTitle("A JOURNEY TO")).toBe("A Journey To");
    expect(titleCasedSourceTitle("IV")).toBe("IV");
  });

  test("preserves manually authored mixed case", () => {
    expect(titleCasedSourceTitle("From myth to Science")).toBe("From myth to Science");
  });
});
