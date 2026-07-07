export const LEARNING_LEVELS = ["casual", "medium", "hard"] as const;

export type LearningLevel = (typeof LEARNING_LEVELS)[number];

export type LearningLevelOption = {
  value: LearningLevel;
  label: string;
  description: string;
};

export const LEARNING_LEVEL_OPTIONS: LearningLevelOption[] = [
  {
    value: "casual",
    label: "Casual",
    description: "즐기며 읽기",
  },
  {
    value: "medium",
    label: "Medium",
    description: "균형 잡힌 학습",
  },
  {
    value: "hard",
    label: "Hard",
    description: "진지하게 공부하기",
  },
];

export function normalizeLearningLevel(value: unknown): LearningLevel {
  return value === "casual" || value === "hard" || value === "medium" ? value : "medium";
}

export function tutorLevelInstruction(value: unknown) {
  const level = normalizeLearningLevel(value);
  const invariantGuard = [
    "This profile governs depth, register, vocabulary, pace, question style, and visual style ONLY.",
    "It never overrides the invariants: answer the learner, do not grade, teach one source chunk at a time, stay grounded, and return the required schema.",
    "If this profile conflicts with a fixed style line, the profile wins on depth/length/register; the invariants win over everything.",
  ].join("\n");

  const profile = level === "hard"
    ? [
      "LEARNER LEVEL - HARD (rigorous; the learner wants to study this seriously)",
      "- Assume a motivated, capable learner willing to do real cognitive work; assume undergraduate-level background when the field makes that useful.",
      "- Use technical and original-language terms freely; define a term once, then use it without re-explaining every time.",
      "- Preserve nuance, tension, and scholarly disagreement. Name positions, thinkers, and contested points when genuinely useful.",
      "- Draw on secondary literature and adjacent theory when it illuminates the source; distinguish source-grounded claims from broader background.",
      "- When precision and accessibility conflict, choose precision, then give a compact restatement if needed.",
      "- Ask probing reflection questions: reconstruct an argument, weigh an objection, or identify a hidden premise.",
      "- Prefer density to superficial brevity, but stay structured. Depth is not length for its own sake.",
    ].join("\n")
    : level === "casual"
      ? [
        "LEARNER LEVEL - CASUAL (relaxed; the learner is reading for pleasure)",
        "- Assume a curious reader who wants the ideas, not the apparatus; assume no prior background.",
        "- Minimize jargon. When a technical term is unavoidable, translate it into everyday language immediately and move on.",
        "- Go for the big picture and memorable core. It is fine to simplify and drop fine distinctions; say so briefly when simplification matters.",
        "- Lean on vivid analogy, story, and real-world hooks; treat the source as a light anchor, not a syllabus.",
        "- Favor warmth and momentum over precision, without inventing facts or dodging questions.",
        "- Keep questions light, low-stakes, and easy to answer.",
        "- Keep turns short and breezy. Prefer plain-sentence, bullets, bridge, and reflection blocks over dense tables unless a table genuinely clarifies.",
      ].join("\n")
      : [
        "LEARNER LEVEL - MEDIUM (balanced; default)",
        "- Assume an intelligent adult with no specialist background.",
        "- Introduce technical terms, but gloss each in plain words on first mention; keep original terms visible when useful.",
        "- Convey main nuances and one or two central debates without chasing every scholarly qualification.",
        "- Use outside knowledge for intuition, examples, and context, then return to the source.",
        "- Balance rigor and accessibility. When they conflict, give the accurate version and then a plain restatement.",
        "- Ask reflective questions that invite connection and interpretation, never recall.",
        "- Keep the current concise guided-lecture style: clear beats dense.",
      ].join("\n");

  return `LEARNER LEVEL PROFILE\n${profile}\n\n${invariantGuard}`;
}
