import { useEffect, useRef, useState } from "react";
import { FolderOpen, KeyRound, RefreshCw, Save, Trash2, X } from "lucide-react";
import type { AiProviderStatus, AppSettings, ProviderModel } from "../../../shared/settings-types";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

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
  const [apiKey, setApiKey] = useState("");
  const [statusText, setStatusText] = useState(providerStatus.error || "Ready");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(settings);
    draftRef.current = settings;
  }, [settings]);

  function updateDraft(patch: Partial<AppSettings>) {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
  }

  async function save() {
    setBusy(true);
    try {
      const saved = (await request("settings.updatePublic", draftRef.current)) as AppSettings;
      draftRef.current = saved;
      setDraft(saved);
      await request("aiProvider.updateSettings", { ollamaApiKey: apiKey });
      setApiKey("");
      await onUpdated();
      setStatusText("Saved");
    } finally {
      setBusy(false);
    }
  }

  async function clearKey() {
    await request("aiProvider.updateSettings", { clearApiKey: true });
    await onUpdated();
    setStatusText("Saved key cleared");
  }

  async function refreshModels() {
    setBusy(true);
    try {
      const nextModels = (await request("aiProvider.listModels", {})) as ProviderModel[];
      setModels(nextModels);
      setStatusText(`${nextModels.length} models loaded`);
    } catch (error) {
      setStatusText((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    const next = (await request("aiProvider.testConnection", {})) as AiProviderStatus;
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

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Settings</p>
            <h2>AI Provider and Learning</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="Close settings">
            <X size={18} />
          </button>
        </header>
        <section className="settings-grid">
          <label>
            <span>Base URL</span>
            <input value={draft.ollamaBaseUrl} onChange={(event) => updateDraft({ ollamaBaseUrl: event.target.value })} />
          </label>
          <label>
            <span>API key</span>
            <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Blank keeps existing key" />
          </label>
          <label className="folder-field">
            <span>Project root folder</span>
            <div className="folder-picker-row">
              <input value={draft.projectRootFolder} onChange={(event) => updateDraft({ projectRootFolder: event.target.value })} />
              <button className="icon-button" type="button" onClick={chooseProjectRoot} title="Choose project root folder">
                <FolderOpen size={17} />
              </button>
            </div>
          </label>
          <label>
            <span>Model</span>
            <select value={draft.selectedModel} onChange={(event) => updateDraft({ selectedModel: event.target.value })}>
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
            <KeyRound size={15} /> {providerStatus.hasApiKey ? `Key source: ${providerStatus.apiKeySource}` : "No saved key"} · {statusText}
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
