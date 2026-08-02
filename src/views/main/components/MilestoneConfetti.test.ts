import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { confettiParticleCount, MILESTONE_CONFETTI_DURATION_MS } from "./MilestoneConfetti";
import { crossedLearningMilestone } from "../learning-milestones";

const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");

describe("milestone confetti", () => {
  test("fires only when progress crosses a learning milestone", () => {
    expect(crossedLearningMilestone(29, 30)).toBe(30);
    expect(crossedLearningMilestone(30, 49)).toBeNull();
    expect(crossedLearningMilestone(49, 50)).toBe(50);
    expect(crossedLearningMilestone(50, 86)).toBe(85);
    expect(crossedLearningMilestone(99, 100)).toBe(100);
    expect(crossedLearningMilestone(85, 70)).toBeNull();
  });

  test("makes later milestones progressively more celebratory without lingering", () => {
    expect(confettiParticleCount(30)).toBeLessThan(confettiParticleCount(50));
    expect(confettiParticleCount(50)).toBeLessThan(confettiParticleCount(85));
    expect(confettiParticleCount(85)).toBeLessThan(confettiParticleCount(100));
    expect(MILESTONE_CONFETTI_DURATION_MS).toBeLessThan(1600);
  });

  test("never blocks the learning pane and hides particles for reduced motion", () => {
    expect(appCss).toContain(".milestone-confetti {");
    expect(appCss).toContain("pointer-events: none;");
    expect(appCss).toContain(".milestone-confetti-piece { display: none; }");
  });
});
