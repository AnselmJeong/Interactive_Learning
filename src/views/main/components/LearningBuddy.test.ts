import { describe, expect, test } from "bun:test";
import { resolveLearningBuddyLayout } from "./LearningBuddy";

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
});
