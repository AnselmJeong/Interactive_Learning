import { useEffect, useRef, useState } from "react";
import { FolderOpen, KeyRound, RefreshCw, Save, Trash2, X } from "lucide-react";
import type { AiProviderId, AiProviderStatus, AppSettings, ProviderModel } from "../../../shared/settings-types";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;
const PROVIDERS: Array<{ id: AiProviderId; label: string; keyLabel: string }> = [
  { id: "ollama", label: "Ollama", keyLabel: "Ollama API key" },
  { id: "openai", label: "OpenAI", keyLabel: "OpenAI API key" },
  { id: "anthropic", label: "Claude", keyLabel: "Claude API key" },
  { id: "gemini", label: "Gemini", keyLabel: "Gemini API key" },
];

const EMPTY_KEYS: Record<AiProviderId, string> = { ollama: "", openai: "", anthropic: "", gemini: "" };

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
  const [apiKeys, setApiKeys] = useState<Record<AiProviderId, string>>(EMPTY_KEYS);
  const [statusText, setStatusText] = useState(providerStatus.error || "Ready");
  const [busy, setBusy] = useState(false);
  const activeProvider = draft.providers[draft.aiProvider];

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
    setModels([]);
  }

  async function save() {
    setBusy(true);
    try {
      const saved = (await request("settings.updatePublic", draftRef.current)) as AppSettings;
      draftRef.current = saved;
      setDraft(saved);
      await request("aiProvider.updateSettings", { provider: saved.aiProvider, apiKeys });
      setApiKeys(EMPTY_KEYS);
      await onUpdated();
      setStatusText("Saved");
    } finally {
      setBusy(false);
    }
  }

  async function clearKey() {
    await request("aiProvider.updateSettings", { clearApiKeyFor: draftRef.current.aiProvider });
    await onUpdated();
    setStatusText(`${PROVIDERS.find((provider) => provider.id === draftRef.current.aiProvider)?.label || "Provider"} key cleared`);
  }

  async function refreshModels() {
    setBusy(true);
    try {
      const nextModels = (await request("aiProvider.listModels", { settings: draftRef.current, apiKeys })) as ProviderModel[];
      setModels(nextModels);
      setStatusText(`${nextModels.length} models loaded`);
    } catch (error) {
      setStatusText((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    const next = (await request("aiProvider.testConnection", { settings: draftRef.current, apiKeys })) as AiProviderStatus;
    setStatusText(next.reachable ? next.error || "Connection OK" : next.error || "Connection failed");
  }

  async function chooseProjectRoot() {
    setBusy(true);
    try {
      const next = (await request("settings.chooseProjectRootFolder", {})) as AppSettings;
      if (next.projectRootFolder !== draftRef.current.projectRootFolder) {
        updateDraft({ projectRootFolder: next.projectRootFolder });
        setStatusText(`Project root folder updated`);
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

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Settings</p>
            <h2>AI Providers and Learning</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="Close settings">
            <X size={18} />
          </button>
        </header>
        <section className="settings-grid">
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
          {draft.aiProvider !== "ollama" ? (
            <label>
              <span>Base URL</span>
              <input value={activeProvider.baseUrl} onChange={(event) => updateProvider(draft.aiProvider, { baseUrl: event.target.value })} />
            </label>
          ) : null}
          <div className="provider-key-grid">
            {PROVIDERS.map((provider) => (
              <label key={provider.id}>
                <span>
                  {provider.keyLabel}
                  <small>{providerStatus.keyStates[provider.id]?.hasApiKey ? `Saved via ${providerStatus.keyStates[provider.id]?.apiKeySource}` : "Not saved"}</small>
                </span>
                <input
                  type="password"
                  value={apiKeys[provider.id]}
                  onChange={(event) => setApiKeys((current) => ({ ...current, [provider.id]: event.target.value }))}
                  placeholder="Blank keeps existing key"
                />
              </label>
            ))}
          </div>
          <label className="folder-field">
            <span>Project root folder</span>
            <div className="folder-picker-row">
              <input value={draft.projectRootFolder} onChange={(event) => updateDraft({ projectRootFolder: event.target.value })} />
              <button className="icon-button" type="button" onClick={chooseProjectRoot} title="Choose project root folder">
                <FolderOpen size={17} />
              </button>
            </div>
          </label>
          <label className="folder-field">
            <span>Default download folder</span>
            <div className="folder-picker-row">
              <input value={draft.defaultDownloadFolder} onChange={(event) => updateDraft({ defaultDownloadFolder: event.target.value })} />
              <button className="icon-button" type="button" onClick={chooseDownloadFolder} title="Choose default download folder">
                <FolderOpen size={17} />
              </button>
            </div>
          </label>
          <label>
            <span>Model</span>
            <select value={activeProvider.selectedModel} onChange={(event) => updateProvider(draft.aiProvider, { selectedModel: event.target.value })}>
              <option value="">{providerStatus.selectedModel ? "Model unavailable" : "Select model"}</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
          </label>
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
          <label className="toggle-row">
            <input type="checkbox" checked={draft.autoAdvanceOnMastery} onChange={(event) => updateDraft({ autoAdvanceOnMastery: event.target.checked })} />
            <span>Auto advance on mastery</span>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={draft.showSourceInspector} onChange={(event) => updateDraft({ showSourceInspector: event.target.checked })} />
            <span>Show source inspector</span>
          </label>
        </section>
        <footer className="modal-actions">
          <span>
            <KeyRound size={15} /> {PROVIDERS.find((provider) => provider.id === draft.aiProvider)?.label}:{" "}
            {providerStatus.keyStates[draft.aiProvider]?.hasApiKey ? `key source ${providerStatus.keyStates[draft.aiProvider]?.apiKeySource}` : "no key"} · {statusText}
          </span>
          <button className="wide-button" onClick={refreshModels} disabled={busy}>
            <RefreshCw size={16} /> Models
          </button>
          <button className="wide-button" onClick={testConnection} disabled={busy}>
            <RefreshCw size={16} /> Test
          </button>
          <button className="wide-button danger" onClick={clearKey}>
            <Trash2 size={16} /> Clear key
          </button>
          <button className="wide-button primary" onClick={save} disabled={busy}>
            <Save size={16} /> Save
          </button>
        </footer>
      </div>
    </div>
  );
}
