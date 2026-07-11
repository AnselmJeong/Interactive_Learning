import { useEffect, useRef, useState } from "react";
import { Brain, FolderOpen, ImageIcon, KeyRound, RefreshCw, Save, SlidersHorizontal, Trash2, X } from "lucide-react";
import { SOURCE_IMPORT_MIN_CHARS_OPTIONS, type AiProviderId, type AiProviderStatus, type AppSettings, type ProviderModel } from "../../../shared/settings-types";
import { modelSupportsVision } from "../../../shared/vision-models";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;
type ModelTarget = "learning" | "vision";
type SettingsSectionId = "models" | "access" | "folders" | "preferences";

const PROVIDERS: Array<{ id: AiProviderId; label: string; keyLabel: string }> = [
  { id: "ollama", label: "Ollama", keyLabel: "Ollama API key (remote)" },
  { id: "openai", label: "OpenAI", keyLabel: "OpenAI API key" },
  { id: "anthropic", label: "Claude", keyLabel: "Claude API key" },
  { id: "gemini", label: "Gemini", keyLabel: "Gemini API key" },
];

const EMPTY_KEYS: Record<AiProviderId, string> = { ollama: "", openai: "", anthropic: "", gemini: "" };
const SETTINGS_NAV: Array<{
  id: SettingsSectionId;
  title: string;
  subtitle: string;
  icon: typeof Brain;
}> = [
  { id: "models", title: "Models & Routing", subtitle: "학습 · 비전 모델", icon: Brain },
  { id: "access", title: "Provider Access", subtitle: "API 키", icon: KeyRound },
  { id: "folders", title: "Folders", subtitle: "경로", icon: FolderOpen },
  { id: "preferences", title: "Preferences", subtitle: "테마 · 언어", icon: SlidersHorizontal },
];

function providerLabel(providerId: AiProviderId) {
  return PROVIDERS.find((provider) => provider.id === providerId)?.label || "Provider";
}

function modelOptionLabel(model: ProviderModel, target: ModelTarget) {
  return target === "vision" && model.supportsVision ? `${model.id} · vision` : model.id;
}

function isLoopbackOllamaBaseUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]");
  } catch {
    return false;
  }
}

export function SettingsModal({
  request,
  settings,
  providerStatus,
  models,
  setModels,
  onClose,
  onUpdated,
}: {
  request: RpcRequest;
  settings: AppSettings;
  providerStatus: AiProviderStatus;
  models: ProviderModel[];
  setModels: (models: ProviderModel[]) => void;
  onClose: () => void;
  onUpdated: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const draftRef = useRef(settings);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("models");
  const [apiKeys, setApiKeys] = useState<Record<AiProviderId, string>>(EMPTY_KEYS);
  const [braveSearchApiKey, setBraveSearchApiKey] = useState("");
  const [statusText, setStatusText] = useState(providerStatus.error || "Ready");
  const [busy, setBusy] = useState(false);
  const [visionModels, setVisionModels] = useState<ProviderModel[]>([]);
  const activeVisionProvider = draft.providers[draft.visionProvider];
  const currentVisionModels = draft.visionProvider === draft.aiProvider && models.length ? models : visionModels;
  const selectedVisionModel = activeVisionProvider.selectedVisionModel;
  const selectedVisionLooksUnsupported = Boolean(selectedVisionModel && !modelSupportsVision(draft.visionProvider, selectedVisionModel));

  useEffect(() => {
    setDraft(settings);
    draftRef.current = settings;
  }, [settings]);

  function updateDraft(patch: Partial<AppSettings>) {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
  }

  function updateProvider(provider: AiProviderId, patch: Partial<AppSettings["providers"][AiProviderId]>) {
    const providers = {
      ...draftRef.current.providers,
      [provider]: { ...draftRef.current.providers[provider], ...patch },
    };
    updateDraft({
      providers,
      ollamaBaseUrl: providers.ollama.baseUrl,
      selectedModel: provider === draftRef.current.aiProvider ? providers[provider].selectedModel : draftRef.current.selectedModel,
    });
  }

  function chooseProvider(provider: AiProviderId) {
    updateDraft({
      aiProvider: provider,
      selectedModel: draftRef.current.providers[provider].selectedModel,
    });
    setModels(provider === draftRef.current.visionProvider ? visionModels : []);
  }

  function chooseVisionProvider(provider: AiProviderId) {
    const current = draftRef.current;
    updateDraft({ visionProvider: provider });
    setVisionModels(provider === current.aiProvider ? models : []);
  }

  async function save() {
    setBusy(true);
    try {
      const saved = (await request("settings.updatePublic", draftRef.current)) as AppSettings;
      draftRef.current = saved;
      setDraft(saved);
      await request("aiProvider.updateSettings", { provider: saved.aiProvider, apiKeys, braveSearchApiKey });
      setApiKeys(EMPTY_KEYS);
      setBraveSearchApiKey("");
      await onUpdated();
      setStatusText("Saved");
    } finally {
      setBusy(false);
    }
  }

  async function clearLearningKey() {
    await request("aiProvider.updateSettings", { clearApiKeyFor: draftRef.current.aiProvider });
    await onUpdated();
    setStatusText(`${providerLabel(draftRef.current.aiProvider)} key cleared`);
  }

  async function clearBraveSearchKey() {
    await request("aiProvider.updateSettings", { clearBraveSearchApiKey: true });
    await onUpdated();
    setStatusText("Brave Search key cleared");
  }

  async function refreshModels(target: ModelTarget) {
    setBusy(true);
    try {
      const current = draftRef.current;
      const provider = target === "vision" ? current.visionProvider : current.aiProvider;
      const nextModels = (await request("aiProvider.listModels", { settings: current, apiKeys, provider, modelPurpose: target })) as ProviderModel[];
      if (target === "vision") {
        setVisionModels(nextModels);
        if (provider === current.aiProvider) setModels(nextModels);
      } else {
        setModels(nextModels);
        if (provider === current.visionProvider) setVisionModels(nextModels);
      }
      setStatusText(`${providerLabel(provider)} ${target === "vision" ? "vision" : "learning"} models loaded: ${nextModels.length}`);
    } catch (error) {
      setStatusText((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(target: ModelTarget) {
    setBusy(true);
    try {
      const current = draftRef.current;
      const provider = target === "vision" ? current.visionProvider : current.aiProvider;
      const next = (await request("aiProvider.testConnection", { settings: current, apiKeys, provider, modelPurpose: target })) as AiProviderStatus;
      const label = `${providerLabel(provider)} ${target === "vision" ? "vision" : "learning"}`;
      setStatusText(next.reachable ? next.error || `${label} OK` : next.error || `${label} failed`);
    } catch (error) {
      setStatusText((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function chooseProjectRoot() {
    setBusy(true);
    try {
      const next = (await request("settings.chooseProjectRootFolder", {})) as AppSettings;
      if (next.projectRootFolder !== draftRef.current.projectRootFolder) {
        updateDraft({ projectRootFolder: next.projectRootFolder });
        setStatusText("Project root folder updated");
      } else {
        setStatusText("Project root folder unchanged");
      }
      await onUpdated();
    } finally {
      setBusy(false);
    }
  }

  async function chooseDownloadFolder() {
    setBusy(true);
    try {
      const next = (await request("settings.chooseDownloadFolder", {})) as AppSettings;
      if (next.defaultDownloadFolder !== draftRef.current.defaultDownloadFolder) {
        updateDraft({ defaultDownloadFolder: next.defaultDownloadFolder });
        setStatusText("Download folder updated");
      } else {
        setStatusText("Download folder unchanged");
      }
      await onUpdated();
    } finally {
      setBusy(false);
    }
  }

  function keySummary(provider: AiProviderId) {
    const state = providerStatus.keyStates[provider];
    if (provider === "ollama" && isLoopbackOllamaBaseUrl(draft.providers.ollama.baseUrl) && !state?.hasApiKey) {
      return "Ollama key: optional for local";
    }
    return state?.hasApiKey ? `${providerLabel(provider)} key: ${state.apiKeySource}` : `${providerLabel(provider)} key: missing`;
  }

  function renderBaseUrl(provider: AiProviderId, target: ModelTarget) {
    if (target === "vision" && provider === draft.aiProvider) return null;
    return (
      <label className="route-full">
        <span>Base URL</span>
        <input value={draft.providers[provider].baseUrl} onChange={(event) => updateProvider(provider, { baseUrl: event.target.value })} />
      </label>
    );
  }

  function renderModelSelect(target: ModelTarget) {
    const provider = target === "vision" ? draft.visionProvider : draft.aiProvider;
    const providerSettings = draft.providers[provider];
    const value = target === "vision" ? providerSettings.selectedVisionModel : providerSettings.selectedModel;
    const options = target === "vision" ? currentVisionModels : models;
    const placeholder = value ? "Model unavailable" : "Select model";
    return (
      <label className="route-model-field">
        <span>{target === "vision" ? "Vision model" : "Model"}</span>
        <select
          value={value}
          onChange={(event) =>
            updateProvider(provider, target === "vision" ? { selectedVisionModel: event.target.value } : { selectedModel: event.target.value })
          }
        >
          <option value="">{placeholder}</option>
          {options.map((model) => (
            <option key={`${target}-${provider}-${model.id}`} value={model.id}>
              {modelOptionLabel(model, target)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const accessSummary = draft.aiProvider === draft.visionProvider
    ? keySummary(draft.aiProvider)
    : `${keySummary(draft.aiProvider)} · ${keySummary(draft.visionProvider)}`;
  const braveKeySaved = providerStatus.braveSearchKeyState.hasApiKey;
  const activeNavTitle = SETTINGS_NAV.find((item) => item.id === activeSection)?.title || "Settings";

  function renderModelRouting() {
    return (
      <section className="settings-panel" aria-labelledby="settings-models-title">
        <div className="settings-section-intro">
          <h3 id="settings-models-title">Models & Routing</h3>
          <p>학습 응답과 도형·이미지 해석에 사용할 모델을 각각 지정합니다.</p>
        </div>
        <div className="settings-route-grid">
          <fieldset className="settings-route-panel">
            <legend>
              <Brain size={15} /> Learning model
            </legend>
            <div className="route-fields">
              <label>
                <span>Provider</span>
                <select value={draft.aiProvider} onChange={(event) => chooseProvider(event.target.value as AiProviderId)}>
                  {PROVIDERS.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </label>
              {renderBaseUrl(draft.aiProvider, "learning")}
              <div className="route-model-row">
                {renderModelSelect("learning")}
                <button className="wide-button compact" type="button" onClick={() => void refreshModels("learning")} disabled={busy}>
                  <RefreshCw size={15} /> Models
                </button>
                <button className="wide-button compact" type="button" onClick={() => void testConnection("learning")} disabled={busy}>
                  <RefreshCw size={15} /> Test
                </button>
              </div>
            </div>
          </fieldset>

          <fieldset className="settings-route-panel">
            <legend>
              <ImageIcon size={15} /> Figure vision model
            </legend>
            <div className="route-fields">
              <label>
                <span>Provider</span>
                <select value={draft.visionProvider} onChange={(event) => chooseVisionProvider(event.target.value as AiProviderId)}>
                  {PROVIDERS.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </label>
              {renderBaseUrl(draft.visionProvider, "vision")}
              <div className="route-model-row">
                {renderModelSelect("vision")}
                <button className="wide-button compact" type="button" onClick={() => void refreshModels("vision")} disabled={busy}>
                  <RefreshCw size={15} /> Models
                </button>
                <button className="wide-button compact" type="button" onClick={() => void testConnection("vision")} disabled={busy}>
                  <RefreshCw size={15} /> Test
                </button>
              </div>
              {selectedVisionLooksUnsupported ? <p className="settings-warning">Selected model is not known to support image input.</p> : null}
            </div>
          </fieldset>
        </div>
      </section>
    );
  }

  function renderProviderAccess() {
    return (
      <section className="settings-panel" aria-labelledby="settings-access-title">
        <div className="settings-section-intro">
          <h3 id="settings-access-title">Provider Access</h3>
          <p>API 키를 저장합니다. 비워 두면 기존 키가 유지됩니다.</p>
        </div>
        <div className="provider-key-grid">
          {PROVIDERS.map((provider) => (
            <label key={provider.id}>
              <span>
                {provider.keyLabel}
                <small className={providerStatus.keyStates[provider.id]?.hasApiKey ? "" : "missing"}>
                  {providerStatus.keyStates[provider.id]?.hasApiKey ? `Saved via ${providerStatus.keyStates[provider.id]?.apiKeySource}` : "Not saved"}
                </small>
              </span>
              <input
                type="password"
                value={apiKeys[provider.id]}
                onChange={(event) => setApiKeys((current) => ({ ...current, [provider.id]: event.target.value }))}
                placeholder="Blank keeps existing key"
              />
            </label>
          ))}
          <label>
            <span>
              Brave Search API key
              <small className={braveKeySaved ? "" : "missing"}>
                {braveKeySaved ? `Saved via ${providerStatus.braveSearchKeyState.apiKeySource}` : "Not saved"}
              </small>
            </span>
            <input
              type="password"
              value={braveSearchApiKey}
              onChange={(event) => setBraveSearchApiKey(event.target.value)}
              placeholder="Blank keeps existing key"
            />
          </label>
        </div>
        {braveKeySaved ? (
          <button className="wide-button danger compact" type="button" onClick={() => void clearBraveSearchKey()}>
            <Trash2 size={15} /> Clear Brave Search key
          </button>
        ) : null}
      </section>
    );
  }

  function renderFolders() {
    return (
      <section className="settings-panel" aria-labelledby="settings-folders-title">
        <div className="settings-section-intro">
          <h3 id="settings-folders-title">Folders</h3>
          <p>데이터베이스에 등록된 프로젝트와 다운로드 파일이 저장될 위치입니다. 기존 폴더를 자동으로 가져오지는 않습니다.</p>
        </div>
        <div className="settings-grid folder-settings-grid">
          <label className="folder-field">
            <span>Project root folder</span>
            <div className="folder-picker-row">
              <input value={draft.projectRootFolder} onChange={(event) => updateDraft({ projectRootFolder: event.target.value })} />
              <button className="icon-button" type="button" onClick={() => void chooseProjectRoot()} title="Choose project root folder">
                <FolderOpen size={20} />
              </button>
            </div>
          </label>
          <label className="folder-field">
            <span>Default download folder</span>
            <div className="folder-picker-row">
              <input value={draft.defaultDownloadFolder} onChange={(event) => updateDraft({ defaultDownloadFolder: event.target.value })} />
              <button className="icon-button" type="button" onClick={() => void chooseDownloadFolder()} title="Choose default download folder">
                <FolderOpen size={20} />
              </button>
            </div>
          </label>
        </div>
      </section>
    );
  }

  function renderPreferences() {
    return (
      <section className="settings-panel" aria-labelledby="settings-preferences-title">
        <div className="settings-section-intro">
          <h3 id="settings-preferences-title">Learning Preferences</h3>
          <p>인터페이스 테마와 튜터의 응답 언어를 설정합니다.</p>
        </div>
        <div className="settings-grid preferences-grid">
          <label>
            <span>Theme</span>
            <select value={draft.theme} onChange={(event) => updateDraft({ theme: event.target.value as AppSettings["theme"] })}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            <span>Tutor language</span>
            <select value={draft.tutorLanguage} onChange={(event) => updateDraft({ tutorLanguage: event.target.value as AppSettings["tutorLanguage"] })}>
              <option value="ko">Korean</option>
              <option value="en">English</option>
            </select>
          </label>
          <label>
            <span>Chat edit submit</span>
            <select
              value={draft.chatSubmitShortcut}
              onChange={(event) => updateDraft({ chatSubmitShortcut: event.target.value as AppSettings["chatSubmitShortcut"] })}
            >
              <option value="cmd-enter">Cmd-Enter</option>
              <option value="enter">Enter</option>
            </select>
          </label>
          <label>
            <span>Auto-select import items</span>
            <select
              value={draft.sourceImportMinChars}
              onChange={(event) => updateDraft({ sourceImportMinChars: Number(event.target.value) as AppSettings["sourceImportMinChars"] })}
            >
              {SOURCE_IMPORT_MIN_CHARS_OPTIONS.map((chars) => (
                <option key={chars} value={chars}>
                  {chars.toLocaleString()}+ chars
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="settings-toggle-grid">
          <label className="toggle-row">
            <input type="checkbox" checked={draft.autoAdvanceOnMastery} onChange={(event) => updateDraft({ autoAdvanceOnMastery: event.target.checked })} />
            <span>Auto advance on mastery</span>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={draft.tutorPrefetchEnabled} onChange={(event) => updateDraft({ tutorPrefetchEnabled: event.target.checked })} />
            <span>Prepare next response</span>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={draft.learningBuddyEnabled} onChange={(event) => updateDraft({ learningBuddyEnabled: event.target.checked })} />
            <span>Learning buddy</span>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={draft.answerReadySound} onChange={(event) => updateDraft({ answerReadySound: event.target.checked })} />
            <span>Answer ready sound</span>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={draft.showSourceInspector} onChange={(event) => updateDraft({ showSourceInspector: event.target.checked })} />
            <span>Show source inspector</span>
          </label>
        </div>
      </section>
    );
  }

  function renderActiveSection() {
    if (activeSection === "access") return renderProviderAccess();
    if (activeSection === "folders") return renderFolders();
    if (activeSection === "preferences") return renderPreferences();
    return renderModelRouting();
  }

  return (
    <div className="modal-backdrop settings-backdrop">
      <div className="modal settings-modal">
        <header className="modal-header settings-hero">
          <div>
            <p className="eyebrow">Settings</p>
            <h2>AI Providers & Learning</h2>
          </div>
          <button className="icon-button settings-close-button" onClick={onClose} title="Close settings">
            <X size={26} />
          </button>
        </header>

        <div className="settings-shell">
          <nav className="settings-sidebar" aria-label="Settings sections">
            {SETTINGS_NAV.map((item) => {
              const Icon = item.icon;
              const active = item.id === activeSection;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`settings-nav-item${active ? " active" : ""}`}
                  onClick={() => setActiveSection(item.id)}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="settings-nav-icon" aria-hidden="true">
                    <Icon size={19} />
                  </span>
                  <span className="settings-nav-copy">
                    <strong>{item.title}</strong>
                    <small>{item.subtitle}</small>
                  </span>
                </button>
              );
            })}
          </nav>

          <main className="settings-content" aria-label={activeNavTitle}>
            {renderActiveSection()}
          </main>
        </div>

        <footer className="modal-actions settings-footer">
          <span>
            <KeyRound size={15} /> {accessSummary} · {statusText}
          </span>
          <button className="wide-button danger" type="button" onClick={() => void clearLearningKey()}>
            <Trash2 size={16} /> Clear learning key
          </button>
          <button className="wide-button primary" type="button" onClick={() => void save()} disabled={busy}>
            <Save size={16} /> Save
          </button>
        </footer>
      </div>
    </div>
  );
}
