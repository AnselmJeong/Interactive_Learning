import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  crossedLearningMilestone,
  LEARNING_MILESTONES,
  type LearningMilestone,
} from "../learning-milestones";

export const MILESTONE_CONFETTI_DURATION_MS = 1450;

const PARTICLE_COUNT: Record<LearningMilestone, number> = {
  30: 26,
  50: 32,
  85: 38,
  100: 46,
};

const CONFETTI_PARTICLES = Array.from({ length: PARTICLE_COUNT[100] }, (_, index) => ({
  left: `${(index * 47 + 9) % 101}%`,
  drift: `${((index * 31) % 180) - 90}px`,
  turn: `${(index % 2 ? 1 : -1) * (360 + (index % 7) * 70)}deg`,
  delay: `${(index % 9) * 24}ms`,
  duration: `${820 + (index % 6) * 60}ms`,
  size: `${5 + (index % 4) * 2}px`,
  shape: index % 3 === 0 ? "round" : index % 3 === 1 ? "strip" : "square",
}));

export function confettiParticleCount(milestone: LearningMilestone) {
  return PARTICLE_COUNT[milestone];
}

type Celebration = {
  id: number;
  milestone: LearningMilestone;
};

export function MilestoneConfetti({
  active,
  sessionId,
  progressPercent,
}: {
  active: boolean;
  sessionId: string | null;
  progressPercent: number;
}) {
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const previousRef = useRef({ sessionId, progressPercent });
  const celebratedRef = useRef(new Set<LearningMilestone>(
    LEARNING_MILESTONES.filter((milestone) => milestone <= progressPercent),
  ));
  const celebrationIdRef = useRef(0);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (sessionId !== previousRef.current.sessionId) {
      previousRef.current = { sessionId, progressPercent };
      celebratedRef.current = new Set(
        LEARNING_MILESTONES.filter((milestone) => milestone <= progressPercent),
      );
      if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      setCelebration(null);
      return;
    }

    const previousPercent = previousRef.current.progressPercent;
    previousRef.current.progressPercent = progressPercent;
    if (!active || !sessionId) {
      for (const reached of LEARNING_MILESTONES) {
        if (reached <= progressPercent) celebratedRef.current.add(reached);
      }
      return;
    }

    const milestone = crossedLearningMilestone(previousPercent, progressPercent);
    if (!milestone || celebratedRef.current.has(milestone)) return;

    for (const reached of LEARNING_MILESTONES) {
      if (reached <= progressPercent) celebratedRef.current.add(reached);
    }
    celebrationIdRef.current += 1;
    setCelebration({ id: celebrationIdRef.current, milestone });
    if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setCelebration(null);
    }, MILESTONE_CONFETTI_DURATION_MS);
  }, [active, progressPercent, sessionId]);

  useEffect(() => () => {
    if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
  }, []);

  if (!celebration) return null;

  return (
    <div
      key={celebration.id}
      className="milestone-confetti"
      data-milestone={celebration.milestone}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={`학습 진도 ${celebration.milestone}% 달성`}
    >
      {CONFETTI_PARTICLES.slice(0, confettiParticleCount(celebration.milestone)).map((particle, index) => (
        <span
          key={index}
          className="milestone-confetti-piece"
          data-shape={particle.shape}
          aria-hidden="true"
          style={{
            "--confetti-left": particle.left,
            "--confetti-drift": particle.drift,
            "--confetti-turn": particle.turn,
            "--confetti-delay": particle.delay,
            "--confetti-duration": particle.duration,
            "--confetti-size": particle.size,
          } as CSSProperties}
        />
      ))}
    </div>
  );
}
