import { describe, expect, test } from "bun:test";
import { defaultSettings, mergeSettingsPatch } from "./settings-service";

describe("settings provider merge", () => {
  test("merges provider updates by provider id without dropping saved models", () => {
    const current = {
      ...defaultSettings,
      aiProvider: "openai" as const,
      providers: {
        ...defaultSettings.providers,
        openai: { ...defaultSettings.providers.openai, selectedModel: "gpt-5", selectedVisionModel: "gpt-5" },
      },
    };
    const merged = mergeSettingsPatch(current, {
      providers: {
        gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", selectedModel: "gemini-2.5-pro", selectedVisionModel: "" },
      },
    });
    expect(merged.providers?.openai.selectedModel).toBe("gpt-5");
    expect(merged.providers?.gemini.selectedModel).toBe("gemini-2.5-pro");
  });
});
