export type ThemeMode = "light" | "dark" | "system";
export type TutorLanguage = "ko" | "en";

export type AppSettings = {
  theme: ThemeMode;
  selectedModel: string;
  ollamaBaseUrl: string;
  projectRootFolder: string;
  tutorLanguage: TutorLanguage;
  autoAdvanceOnMastery: boolean;
  showSourceInspector: boolean;
};

export type PublicAiProviderUpdate = {
  ollamaApiKey?: string;
  clearApiKey?: boolean;
};

export type AiProviderStatus = {
  baseUrl: string;
  hasApiKey: boolean;
  apiKeySource: "settings" | "env" | null;
  selectedModel: string;
  reachable: boolean;
  error?: string;
};

export type ProviderModel = {
  id: string;
  created?: number;
};
