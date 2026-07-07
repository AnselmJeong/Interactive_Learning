import { describe, expect, test } from "bun:test";
import { defaultSettings, mergeSettingsPatch, normalizeSettings } from "./settings-service";

describe("settings provider merge", () => {
  test("defaults imported chapter auto-selection to 1000 characters", () => {
    expect(defaultSettings.sourceImportMinChars).toBe(1000);
  });

  test("enables the learning buddy by default", () => {
    expect(defaultSettings.learningBuddyEnabled).toBe(true);
  });

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

  test("preserves configured Ollama provider base URL", () => {
    const normalized = normalizeSettings({
      providers: {
        ...defaultSettings.providers,
        ollama: { baseUrl: "http://localhost:11434/v1", selectedModel: "llama3.2", selectedVisionModel: "" },
      },
    }, defaultSettings);

    expect(normalized.providers.ollama.baseUrl).toBe("http://localhost:11434/v1");
    expect(normalized.ollamaBaseUrl).toBe("http://localhost:11434/v1");
  });

  test("preserves legacy top-level Ollama base URL when provider settings are absent", () => {
    const normalized = normalizeSettings({ ollamaBaseUrl: "https://ollama.com/v1" }, defaultSettings);

    expect(normalized.providers.ollama.baseUrl).toBe("https://ollama.com/v1");
    expect(normalized.ollamaBaseUrl).toBe("https://ollama.com/v1");
  });
});
