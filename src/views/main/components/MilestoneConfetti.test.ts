import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { confettiParticleCount } from "./MilestoneConfetti";
import { crossedLearningMilestone } from "../learning-milestones";

const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
const componentSource = readFileSync(new URL("./MilestoneConfetti.tsx", import.meta.url), "utf8");

describe("milestone confetti", () => {
  test("fires only when progress crosses a learning milestone", () => {
    expect(crossedLearningMilestone(29, 30)).toBe(30);
    expect(crossedLearningMilestone(30, 49)).toBeNull();
    expect(crossedLearningMilestone(49, 50)).toBe(50);
    expect(crossedLearningMilestone(50, 86)).toBe(85);
    expect(crossedLearningMilestone(99, 100)).toBe(100);
    expect(crossedLearningMilestone(85, 70)).toBeNull();
  });

  test("makes every milestone substantial and later milestones progressively more celebratory", () => {
    expect(confettiParticleCount(30)).toBeGreaterThanOrEqual(72);
    expect(confettiParticleCount(30)).toBeLessThan(confettiParticleCount(50));
    expect(confettiParticleCount(50)).toBeLessThan(confettiParticleCount(85));
    expect(confettiParticleCount(85)).toBeLessThan(confettiParticleCount(100));
  });

  test("fills the learning workspace with a side burst and continuing ambient confetti", () => {
    expect(appCss).toContain(".milestone-confetti {");
    expect(appCss).toContain("inset: 0;");
    expect(componentSource).toContain('createBurstParticle(index % 2 === 0 ? "left" : "right"');
    expect(componentSource).toContain("particles.push(createAmbientParticle(width, height, random));");
    expect(componentSource).toContain("Congratulations!");
  });

  test("absorbs the dismissal click and cleans up the canvas animation", () => {
    expect(componentSource).toContain("onClick={() => setCelebration(null)}");
    expect(componentSource).not.toContain("window.addEventListener");
    expect(componentSource).toContain("new ResizeObserver(resizeCanvas)");
    expect(componentSource).toContain("window.cancelAnimationFrame(animationFrame)");
    expect(componentSource).toContain("resizeObserver.disconnect()");
  });

  test("keeps static celebration copy but hides motion for reduced motion", () => {
    expect(componentSource).toContain('window.matchMedia("(prefers-reduced-motion: reduce)").matches');
    expect(appCss).toContain(".milestone-confetti-canvas,");
    expect(appCss).toContain(".milestone-confetti-garlands { display: none; }");
  });
});
