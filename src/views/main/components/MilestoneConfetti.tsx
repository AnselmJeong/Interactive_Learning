import { useEffect, useRef, useState } from "react";
import {
  crossedLearningMilestone,
  LEARNING_MILESTONES,
  type LearningMilestone,
} from "../learning-milestones";

const PARTICLE_COUNT: Record<LearningMilestone, number> = {
  30: 72,
  50: 96,
  85: 128,
  100: 160,
};

const CONFETTI_COLORS = [
  "#b9434d",
  "#1d8290",
  "#d3a72d",
  "#e67745",
  "#5d6fbc",
  "#2b8b72",
] as const;

type ParticleShape = "circle" | "square" | "strip" | "ribbon";

type ConfettiParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  drag: number;
  rotation: number;
  angularVelocity: number;
  size: number;
  color: string;
  shape: ParticleShape;
  life: number;
  ttl: number;
  opacity: number;
};

type Celebration = {
  id: number;
  milestone: LearningMilestone;
};

export function confettiParticleCount(milestone: LearningMilestone) {
  return PARTICLE_COUNT[milestone];
}

function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function particleShape(random: () => number): ParticleShape {
  const value = random();
  if (value < 0.2) return "circle";
  if (value < 0.48) return "square";
  if (value < 0.76) return "strip";
  return "ribbon";
}

function createBurstParticle(
  side: "left" | "right",
  width: number,
  height: number,
  random: () => number,
): ConfettiParticle {
  const direction = side === "left" ? 1 : -1;
  const speed = 360 + random() * 520;
  return {
    x: width * (side === "left" ? 0.065 : 0.935),
    y: height * (0.48 + random() * 0.2),
    vx: direction * speed * (0.58 + random() * 0.42),
    vy: -(300 + random() * 570),
    gravity: 470 + random() * 300,
    drag: 0.982 + random() * 0.012,
    rotation: random() * Math.PI * 2,
    angularVelocity: (random() - 0.5) * 12,
    size: 5 + random() * 9,
    color: CONFETTI_COLORS[Math.floor(random() * CONFETTI_COLORS.length)]!,
    shape: particleShape(random),
    life: 0,
    ttl: 3.6 + random() * 2.4,
    opacity: 0.82 + random() * 0.18,
  };
}

function createAmbientParticle(width: number, height: number, random: () => number): ConfettiParticle {
  const speed = 62 + random() * 78;
  return {
    x: random() * width,
    y: -24,
    vx: (random() - 0.5) * 68,
    vy: speed,
    gravity: 18 + random() * 36,
    drag: 0.996,
    rotation: random() * Math.PI * 2,
    angularVelocity: (random() - 0.5) * 5,
    size: 5 + random() * 7,
    color: CONFETTI_COLORS[Math.floor(random() * CONFETTI_COLORS.length)]!,
    shape: particleShape(random),
    life: 0,
    ttl: Math.max(7, height / speed + 2.5),
    opacity: 0.56 + random() * 0.3,
  };
}

function drawParticle(context: CanvasRenderingContext2D, particle: ConfettiParticle) {
  const fadeIn = Math.min(1, particle.life / 0.16);
  const fadeOut = Math.min(1, (particle.ttl - particle.life) / 0.52);
  context.save();
  context.globalAlpha = particle.opacity * fadeIn * fadeOut;
  context.translate(particle.x, particle.y);
  context.rotate(particle.rotation);
  context.fillStyle = particle.color;
  context.strokeStyle = particle.color;

  if (particle.shape === "circle") {
    context.beginPath();
    context.arc(0, 0, particle.size * 0.45, 0, Math.PI * 2);
    context.fill();
  } else if (particle.shape === "strip") {
    context.fillRect(-particle.size * 1.35, -particle.size * 0.24, particle.size * 2.7, particle.size * 0.48);
  } else if (particle.shape === "ribbon") {
    context.lineWidth = Math.max(1.7, particle.size * 0.22);
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(-particle.size * 1.5, 0);
    context.bezierCurveTo(
      -particle.size * 0.7,
      -particle.size,
      particle.size * 0.45,
      particle.size,
      particle.size * 1.5,
      0,
    );
    context.stroke();
  } else {
    context.fillRect(-particle.size * 0.48, -particle.size * 0.48, particle.size * 0.96, particle.size * 0.96);
  }
  context.restore();
}

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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLButtonElement | null>(null);
  const previousRef = useRef({ sessionId, progressPercent });
  const celebratedRef = useRef(new Set<LearningMilestone>(
    LEARNING_MILESTONES.filter((milestone) => milestone <= progressPercent),
  ));
  const celebrationIdRef = useRef(0);

  useEffect(() => {
    if (sessionId !== previousRef.current.sessionId) {
      previousRef.current = { sessionId, progressPercent };
      celebratedRef.current = new Set(
        LEARNING_MILESTONES.filter((milestone) => milestone <= progressPercent),
      );
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
  }, [active, progressPercent, sessionId]);

  useEffect(() => {
    if (!celebration) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayRef.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [celebration]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!celebration || !canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const random = seededRandom(celebration.id * 104729 + celebration.milestone * 811);
    const particles: ConfettiParticle[] = [];
    let width = 0;
    let height = 0;
    let initialized = false;
    let animationFrame = 0;
    let previousTime = performance.now();
    const startedAt = previousTime;
    let ambientBudget = 0;

    const resizeCanvas = () => {
      const bounds = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, bounds.width);
      const nextHeight = Math.max(1, bounds.height);
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(nextWidth * pixelRatio) || canvas.height !== Math.round(nextHeight * pixelRatio)) {
        canvas.width = Math.round(nextWidth * pixelRatio);
        canvas.height = Math.round(nextHeight * pixelRatio);
      }
      width = nextWidth;
      height = nextHeight;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      if (!initialized && width > 1 && height > 1) {
        initialized = true;
        const areaScale = Math.max(0.58, Math.min(1, (width * height) / (920 * 700)));
        const burstCount = Math.round(confettiParticleCount(celebration.milestone) * areaScale);
        for (let index = 0; index < burstCount; index += 1) {
          particles.push(createBurstParticle(index % 2 === 0 ? "left" : "right", width, height, random));
        }
      }
    };

    const resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(canvas);
    resizeCanvas();

    const renderFrame = (now: number) => {
      const deltaSeconds = Math.min(0.034, Math.max(0.001, (now - previousTime) / 1000));
      previousTime = now;
      const elapsedSeconds = (now - startedAt) / 1000;
      context.clearRect(0, 0, width, height);

      if (elapsedSeconds > 0.72) {
        const ambientRate = 5 + celebration.milestone / 15;
        ambientBudget += ambientRate * deltaSeconds;
        while (ambientBudget >= 1) {
          particles.push(createAmbientParticle(width, height, random));
          ambientBudget -= 1;
        }
      }

      for (const particle of particles) {
        particle.life += deltaSeconds;
        particle.vx *= Math.pow(particle.drag, deltaSeconds * 60);
        particle.vy += particle.gravity * deltaSeconds;
        particle.x += particle.vx * deltaSeconds;
        particle.y += particle.vy * deltaSeconds;
        particle.rotation += particle.angularVelocity * deltaSeconds;
        drawParticle(context, particle);
      }

      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index]!;
        if (
          particle.life >= particle.ttl
          || particle.y > height + 100
          || particle.x < -220
          || particle.x > width + 220
        ) {
          particles.splice(index, 1);
        }
      }
      animationFrame = window.requestAnimationFrame(renderFrame);
    };

    animationFrame = window.requestAnimationFrame(renderFrame);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
    };
  }, [celebration]);

  if (!celebration) return null;

  const milestoneCopy = `학습 진도 ${celebration.milestone}%를 달성했어요.`;

  return (
    <button
      ref={overlayRef}
      key={celebration.id}
      type="button"
      className="milestone-confetti"
      data-milestone={celebration.milestone}
      onClick={() => setCelebration(null)}
      aria-live="polite"
      aria-label={`Congratulations. ${milestoneCopy} 클릭하여 학습공간으로 돌아가기`}
    >
      <canvas ref={canvasRef} className="milestone-confetti-canvas" aria-hidden="true" />
      <svg className="milestone-confetti-garlands" viewBox="0 0 1000 620" preserveAspectRatio="none" aria-hidden="true">
        <path className="garland-red garland-left" d="M 18 350 C 62 306, 118 326, 88 365 C 68 392, 112 410, 148 382" />
        <path className="garland-blue garland-left" d="M 22 260 C 62 226, 108 242, 82 276 C 65 298, 101 312, 132 288" />
        <path className="garland-red garland-right" d="M 982 350 C 938 306, 882 326, 912 365 C 932 392, 888 410, 852 382" />
        <path className="garland-blue garland-right" d="M 978 260 C 938 226, 892 242, 918 276 C 935 298, 899 312, 868 288" />
      </svg>
      <span className="milestone-confetti-copy" aria-hidden="true">
        <span className="milestone-confetti-kicker">Learning milestone</span>
        <strong>Congratulations!</strong>
        <span className="milestone-confetti-underline" />
        <span className="milestone-confetti-message">{milestoneCopy}</span>
        <small>클릭하여 계속</small>
      </span>
    </button>
  );
}
