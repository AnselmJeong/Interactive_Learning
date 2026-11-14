import { describe, expect, test } from "bun:test";
import { displayableCourseTitle, isFigureHeading, moduleSubtopicFromTitle, numberedModuleTitle, displayableHeadingPath, displayableModuleTitle, displayableOutlineTitle, displayableSourceTitle, plainDisplayText, stripRepeatedSourceHeading, titleCasedSourceTitle } from "./display-title";

describe("display title text", () => {
  test("omits a title-only part fragment but preserves any actual explanation", () => {
    expect(stripRepeatedSourceHeading("Introductory", "1 Dimensions and contexts of selfhood › Part I Introductory")).toBe("");
    expect(stripRepeatedSourceHeading("British modernity", "Part II British modernity")).toBe("");
    const body = "British modernity\n\nThe author's argument begins here.";
    expect(stripRepeatedSourceHeading(body, "Part II British modernity")).toBe(body);
  });
  test("omits an extracted part-title table already displayed as a reader heading", () => {
    expect(stripRepeatedSourceHeading("| PART I |\n|--------|\n| Kant's Critique of Idealism |", "Introduction › I. Kant’s Critique of Idealism")).toBe("");
    expect(stripRepeatedSourceHeading("| PART I I |\n|--------|\n| Fichte's Critique of Subjectivism |", "II. Fichte’s Critique of Subjectivism")).toBe("");
    const realTable = "| PART I |\n|--------|\n| Kant's Critique of Idealism |\n| Another entry |";
    expect(stripRepeatedSourceHeading(realTable, "I. Kant’s Critique of Idealism")).toBe(realTable);
    expect(stripRepeatedSourceHeading("| PART II |\n|--------|\n| Kant's Critique of Idealism |", "I. Kant’s Critique of Idealism")).toContain("PART II");
  });
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

  test("collapses repeated path titles despite ordinal punctuation and case differences", () => {
    expect(displayableHeadingPath(['1. Seeking Understanding', '1 SEEKING UNDERSTANDING'])).toBe('1. Seeking Understanding');
    expect(displayableOutlineTitle('1. Seeking Understanding › 1 Seeking Understanding')).toBe('1. Seeking Understanding');
    expect(displayableHeadingPath(['2.1. Introduction', '2.1 Introduction', '2.1.1 Background'])).toBe('2.1. Introduction › 2.1.1 Background');
    expect(displayableHeadingPath(['1. Introduction', '2. Introduction'])).toBe('1. Introduction › 2. Introduction');
    expect(displayableHeadingPath(['1. Introduction', '1 Introduction', 'Context'], ' › ', ['1 Introduction'])).toBe('Context');
  });

  test("removes repeated leading body headings while retaining the next distinct subsection", () => {
    expect(stripRepeatedSourceHeading('# 1 INTRODUCTION\n\n## 1. Introduction\n\n### 1.1 Scope\n\nBody.', '1. Introduction')).toBe('### 1.1 Scope\n\nBody.');
    expect(stripRepeatedSourceHeading('# 2 Introduction\n\nBody.', '1. Introduction')).toBe('# 2 Introduction\n\nBody.');
    expect(stripRepeatedSourceHeading('# Chapter 2: A different topic\n\nBody.', '1. Introduction')).toBe('# Chapter 2: A different topic\n\nBody.');
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

  test("removes source titles from module paths despite hyphen differences", () => {
    const sourceTitles = ["MEG EEG Primer 01"];

    expect(displayableModuleTitle(
      "MEG-EEG Primer - 01 > ■ GENERAL PRINCIPLES OF GOOD EXPERIMENTATION",
      sourceTitles,
    )).toBe("General Principles of Good Experimentation");
    expect(displayableModuleTitle("MEG-EEG Primer - 01", sourceTitles)).toBe("");
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

describe("module subtopic titles", () => {
  const chapter = "2 Advantages and Limitations of Time- and Time-Frequency-Domain Analyses";

  test("drops the repeated chapter prefix, section numbers, and figure labels", () => {
    expect(moduleSubtopicFromTitle(`${chapter} > 2.1 Why EEG?`)).toBe("Why EEG?");
    expect(moduleSubtopicFromTitle(`${chapter} > 2.5 Limitations of ERPs > Figure 2.1`)).toBe("Limitations of ERPs");
    expect(moduleSubtopicFromTitle("Introduction")).toBe("Introduction");
  });

  test("numbers modules by position and prefers the extracted subtopic", () => {
    expect(numberedModuleTitle({ title: `${chapter} > 2.2 Why Not EEG?` }, 1)).toBe("2. Why Not EEG?");
    expect(numberedModuleTitle({ title: "1. 왜 EEG인가", subtopic: "EEG를 쓰는 이유" }, 0)).toBe("1. EEG를 쓰는 이유");
  });

  test("recognizes figure and table headings only", () => {
    expect(isFigureHeading("Figure 2.1")).toBe(true);
    expect(isFigureHeading("Fig. 3")).toBe(true);
    expect(isFigureHeading("Table 1")).toBe(true);
    expect(isFigureHeading("Figurative Language")).toBe(false);
    expect(isFigureHeading("Tables of the Law")).toBe(false);
  });
});
