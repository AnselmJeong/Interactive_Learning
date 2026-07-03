export type ThemeMode = "light" | "dark" | "system";
export type TutorLanguage = "ko" | "en";
export type AiProviderId = "ollama" | "openai" | "anthropic" | "gemini";
export type ChatSubmitShortcut = "enter" | "cmd-enter";

export type AiProviderPublicSettings = {
  baseUrl: string;
  selectedModel: string;
  selectedVisionModel: string;
};

export type AiProviderKeyState = {
  hasApiKey: boolean;
  apiKeySource: "settings" | "env" | null;
};

export type AppSettings = {
  theme: ThemeMode;
  aiProvider: AiProviderId;
  visionProvider: AiProviderId;
  selectedModel: string;
  ollamaBaseUrl: string;
  providers: Record<AiProviderId, AiProviderPublicSettings>;
  projectRootFolder: string;
  defaultDownloadFolder: string;
  tutorLanguage: TutorLanguage;
  chatSubmitShortcut: ChatSubmitShortcut;
  autoAdvanceOnMastery: boolean;
  showSourceInspector: boolean;
  answerReadySound: boolean;
};

export type PublicAiProviderUpdate = {
  provider?: AiProviderId;
  ollamaApiKey?: string;
  apiKeys?: Partial<Record<AiProviderId, string>>;
  clearApiKey?: boolean;
  clearApiKeyFor?: AiProviderId;
};

export type AiProviderStatus = {
  provider: AiProviderId;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeySource: "settings" | "env" | null;
  keyStates: Record<AiProviderId, AiProviderKeyState>;
  selectedModel: string;
  reachable: boolean;
  error?: string;
};

export type ProviderModel = {
  id: string;
  created?: number;
  supportsVision?: boolean;
};
