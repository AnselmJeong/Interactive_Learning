import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LEARNING_MILESTONE_ASSET, resolveLearningBuddyLayout } from "./LearningBuddy";
import { crossedLearningMilestone } from "../learning-milestones";

const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");

describe("LearningBuddy layout", () => {
  test("keeps the chat buddy on the left and opens into the left pane when it is available", () => {
    expect(resolveLearningBuddyLayout({ viewMode: "chat", leftPaneOpen: true, rightPaneOpen: true })).toEqual({
      screenSide: "left",
      bubbleSide: "left",
    });
  });

  test("opens the chat buddy balloon to the right when the left pane is collapsed", () => {
    expect(resolveLearningBuddyLayout({ viewMode: "chat", leftPaneOpen: false, rightPaneOpen: true })).toEqual({
      screenSide: "left",
      bubbleSide: "right",
    });
  });

  test("keeps the source buddy on the right and opens into the right pane when it is available", () => {
    expect(resolveLearningBuddyLayout({ viewMode: "source", leftPaneOpen: true, rightPaneOpen: true })).toEqual({
      screenSide: "right",
      bubbleSide: "right",
    });
  });

  test("opens the source buddy balloon to the left when the right pane is collapsed", () => {
    expect(resolveLearningBuddyLayout({ viewMode: "source", leftPaneOpen: true, rightPaneOpen: false })).toEqual({
      screenSide: "right",
      bubbleSide: "left",
    });
  });

  test("anchors buddy balloons toward their resolved open side", () => {
    expect(appCss).toContain('.learning-buddy[data-side="left"] .learning-buddy-message { right: 0; left: auto; }');
    expect(appCss).toContain('.app-shell.left-pane-collapsed .learning-buddy[data-side="left"] .learning-buddy-message { left: 0; right: auto; }');
    expect(appCss).toContain('.learning-buddy[data-side="right"] .learning-buddy-message { left: 0; right: auto; }');
    expect(appCss).toContain('.app-shell.right-pane-collapsed .learning-buddy[data-side="right"] .learning-buddy-message { right: 0; left: auto; }');
  });
});

describe("LearningBuddy milestones", () => {
  test("uses a distinct normalized animation asset for every milestone", () => {
    const assets = Object.values(LEARNING_MILESTONE_ASSET);
    expect(new Set(assets).size).toBe(4);
    expect(assets).toEqual([
      "views://main/assets/buddy-milestone-30.gif",
      "views://main/assets/buddy-milestone-50.gif",
      "views://main/assets/buddy-milestone-85.gif",
      "views://main/assets/buddy-milestone-100.gif",
    ]);
  });

  test("keeps every cropped milestone GIF at the portrait frame size", () => {
    for (const milestone of [30, 50, 85, 100]) {
      const gif = readFileSync(new URL(`../../../../buddy/milestones/milestone-${milestone}.gif`, import.meta.url));
      expect(gif.subarray(0, 3).toString()).toBe("GIF");
      expect(gif.readUInt16LE(6)).toBe(240);
      expect(gif.readUInt16LE(8)).toBe(276);
    }
  });

  test("detects a crossed milestone instead of requiring an exact percentage", () => {
    expect(crossedLearningMilestone(24, 33)).toBe(30);
    expect(crossedLearningMilestone(48, 52)).toBe(50);
    expect(crossedLearningMilestone(84, 86)).toBe(85);
  });

  test("lets completion supersede lower milestones crossed by the same progress update", () => {
    expect(crossedLearningMilestone(82, 100)).toBe(100);
    expect(crossedLearningMilestone(20, 90)).toBe(85);
  });

  test("does not celebrate unchanged or reversed progress", () => {
    expect(crossedLearningMilestone(50, 50)).toBeNull();
    expect(crossedLearningMilestone(85, 30)).toBeNull();
  });
});
