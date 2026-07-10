import { describe, expect, test } from "bun:test";
import { capitalizedSourceTitle, displayableCourseTitle, displayableHeadingPath, displayableModuleTitle, displayableOutlineTitle, displayableSourceTitle, plainDisplayText } from "./display-title";

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
    expect(displayableModuleTitle("Version 1.0")).toBe("Version 1.0");
    expect(displayableModuleTitle("1984 and Political Language")).toBe("1984 and Political Language");
  });

  test("removes only known file extensions from source fallbacks", () => {
    expect(displayableSourceTitle("", "/tmp/The Laws of Thought.md")).toBe("The Laws of Thought");
    expect(displayableSourceTitle("Version 1.0", "version.md")).toBe("Version 1.0");
  });

  test("softens extracted all-uppercase titles while preserving roman numerals", () => {
    expect(capitalizedSourceTitle("FROM MYTH TO SCIENCE")).toBe("From Myth To Science");
    expect(capitalizedSourceTitle("XII BEFORE THE FALL")).toBe("XII Before The Fall");
    expect(capitalizedSourceTitle("IV")).toBe("IV");
  });

  test("preserves manually authored mixed case", () => {
    expect(capitalizedSourceTitle("From myth to Science")).toBe("From myth to Science");
  });
});
