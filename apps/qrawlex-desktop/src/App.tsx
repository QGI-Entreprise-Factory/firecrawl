import { useCallback, useEffect, useState } from "react";
import { Settings, errorToString, getSettings, setSettings } from "./api";
import StackView from "./views/StackView";
import ConvertView from "./views/ConvertView";
import CrawlView from "./views/CrawlView";

type Tab = "stack" | "convert" | "crawl";

const TABS: { id: Tab; label: string }[] = [
  { id: "stack", label: "Stack" },
  { id: "convert", label: "Convert" },
  { id: "crawl", label: "Crawl" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("stack");
  const [settings, setSettingsState] = useState<Settings>({
    composeDir: "",
    apiKey: "",
  });
  const [settingsError, setSettingsError] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then(setSettingsState)
      .catch((err) => setSettingsError(errorToString(err)));
  }, []);

  const updateSettings = useCallback(async (next: Settings) => {
    setSettingsState(next);
    try {
      await setSettings(next);
      setSettingsError(null);
    } catch (err) {
      setSettingsError(errorToString(err));
    }
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <svg
            className="brand-mark"
            viewBox="0 0 32 32"
            aria-hidden="true"
            width="28"
            height="28"
          >
            <rect x="1" y="1" width="30" height="30" rx="7" fill="#0f172a" />
            <circle
              cx="15"
              cy="15"
              r="7.5"
              fill="none"
              stroke="#f59e0b"
              strokeWidth="3.2"
            />
            <line
              x1="19.5"
              y1="19.5"
              x2="25"
              y2="25"
              stroke="#f59e0b"
              strokeWidth="3.2"
              strokeLinecap="round"
            />
          </svg>
          <div>
            <h1>Qrawlex Desktop</h1>
            <p className="tagline">Crawl anything. Convert everything.</p>
          </div>
        </div>
        <nav className="tabs" aria-label="Views">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "tab active" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {settingsError && (
        <div className="banner error">Settings error: {settingsError}</div>
      )}

      <main className="app-main">
        {/* Views stay mounted so polling / in-flight work survives tab switches */}
        <div hidden={tab !== "stack"}>
          <StackView settings={settings} onSettingsChange={updateSettings} />
        </div>
        <div hidden={tab !== "convert"}>
          <ConvertView />
        </div>
        <div hidden={tab !== "crawl"}>
          <CrawlView settings={settings} onSettingsChange={updateSettings} />
        </div>
      </main>
    </div>
  );
}
