# Test Learning System

This is an adaptive tutor prototype for validating the learning-system strategy in `../plan.md` using `../example/017-section.md`.

The course plan is prepared in advance, but the visible tutor messages are generated dynamically from the current module, source chunks, conversation history, and the learner's latest response.

## Files

- `course_artifacts.json`: source chunks, concept map, visuals, course plan, and tutor policy for the Timaeus section.
- `index.html`: browser runtime that reads the artifacts and runs the learning UI.
- `server.mjs`: local tutor server. It serves the UI and calls the LLM through `/api/tutor`.

## Run

From the repository root:

```bash
OPENAI_API_KEY=... node test-learning-system/server.mjs
```

Then open:

```text
http://localhost:4173/
```

The browser never receives the API key. The local server owns model calls, which is the same boundary we should later use in an Electrobun Bun-main/RPC app.

## What This Tests

- artifact-driven course structure
- module navigation
- AI-led tutor loop constrained by the course plan
- choice chips and free-form answers
- dynamic feedback, follow-up questions, and remediation
- source references per tutor turn
- visual registry rendering
- localStorage session persistence

## Design Note

The prepared material is the lesson plan, not the spoken lesson. `course_artifacts.json` supplies source chunks, concepts, learning objectives, misconception hints, and visual candidates. The tutor server uses those as guardrails so it does not lose the learning objective, but it generates the actual explanation and next question in response to the learner.
