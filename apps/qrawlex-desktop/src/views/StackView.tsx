import { useCallback, useEffect, useRef, useState } from "react";
import {
  API_ROOT_URL,
  CmdOutput,
  HealthResult,
  OMNI_HEALTH_URL,
  PDF_HEALTH_URL,
  ServiceRow,
  Settings,
  dockerAvailable,
  errorToString,
  serviceHealth,
  stackStart,
  stackStatus,
  stackStop,
} from "../api";

interface Props {
  settings: Settings;
  onSettingsChange: (next: Settings) => void;
}

interface HealthTarget {
  key: string;
  label: string;
  url: string;
  port: string;
}

const HEALTH_TARGETS: HealthTarget[] = [
  { key: "api", label: "Qrawlex API", url: API_ROOT_URL, port: "3002" },
  { key: "pdf", label: "PDF service", url: PDF_HEALTH_URL, port: "5011" },
  { key: "omni", label: "Omni-convert", url: OMNI_HEALTH_URL, port: "5012" },
];

function formatCmdOutput(label: string, out: CmdOutput): string {
  const parts = [
    `$ ${label}`,
    out.stdout.trim(),
    out.stderr.trim(),
    out.success ? "(exit 0)" : `(exit ${out.code ?? "?"})`,
  ];
  return parts.filter(Boolean).join("\n");
}

export default function StackView({ settings, onSettingsChange }: Props) {
  const [composeDirDraft, setComposeDirDraft] = useState(settings.composeDir);
  const [docker, setDocker] = useState<{ ok: boolean; detail: string } | null>(
    null,
  );
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, HealthResult>>({});
  const [log, setLog] = useState("");
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const composeDirRef = useRef(settings.composeDir);
  composeDirRef.current = settings.composeDir;

  // Keep the draft in sync when settings load from disk.
  useEffect(() => setComposeDirDraft(settings.composeDir), [settings.composeDir]);

  const refreshDocker = useCallback(async () => {
    try {
      const out = await dockerAvailable();
      setDocker({
        ok: out.success,
        detail: out.success
          ? out.stdout.trim() || "available"
          : out.stderr.trim() || out.stdout.trim() || "docker not available",
      });
    } catch (err) {
      setDocker({ ok: false, detail: errorToString(err) });
    }
  }, []);

  const refreshServices = useCallback(async () => {
    const dir = composeDirRef.current;
    if (!dir.trim()) {
      setServices([]);
      setStatusError(null);
      return;
    }
    try {
      setServices(await stackStatus(dir));
      setStatusError(null);
    } catch (err) {
      setServices([]);
      setStatusError(errorToString(err));
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    const results = await Promise.all(
      HEALTH_TARGETS.map((t) => serviceHealth(t.url)),
    );
    setHealth(
      Object.fromEntries(HEALTH_TARGETS.map((t, i) => [t.key, results[i]])),
    );
  }, []);

  // Initial load + background polling (health every 5s, compose ps every 15s).
  useEffect(() => {
    refreshDocker();
    refreshServices();
    refreshHealth();
    const healthTimer = setInterval(refreshHealth, 5000);
    const psTimer = setInterval(refreshServices, 15000);
    return () => {
      clearInterval(healthTimer);
      clearInterval(psTimer);
    };
  }, [refreshDocker, refreshServices, refreshHealth]);

  const saveComposeDir = () =>
    onSettingsChange({ ...settings, composeDir: composeDirDraft.trim() });

  const run = async (kind: "start" | "stop") => {
    // Persist the draft first so the Rust side uses what the user sees.
    const dir = composeDirDraft.trim();
    if (dir !== settings.composeDir) {
      onSettingsChange({ ...settings, composeDir: dir });
    }
    composeDirRef.current = dir;
    setBusy(kind);
    const label =
      kind === "start"
        ? "docker compose --profile converters up -d"
        : "docker compose --profile converters down";
    setLog(`$ ${label}\n… running …`);
    try {
      const out = kind === "start" ? await stackStart(dir) : await stackStop(dir);
      setLog(formatCmdOutput(label, out));
    } catch (err) {
      setLog(`$ ${label}\n${errorToString(err)}`);
    } finally {
      setBusy(null);
      refreshServices();
      refreshHealth();
    }
  };

  return (
    <section className="view">
      <div className="card">
        <h2>Docker</h2>
        <p className="status-line">
          <span className={docker?.ok ? "dot green" : "dot red"} />
          {docker === null ? "checking…" : docker.detail}
          <button className="ghost" onClick={refreshDocker}>
            Recheck
          </button>
        </p>
      </div>

      <div className="card">
        <h2>Compose project</h2>
        <p className="hint">
          Directory of your qrawlex checkout — the one containing{" "}
          <code>docker-compose.yaml</code>. Start launches the full platform
          (API, workers, Redis, Playwright) plus the <code>converters</code>{" "}
          profile (PDF + omni-convert services).
        </p>
        <div className="row">
          <input
            type="text"
            value={composeDirDraft}
            placeholder="path to your qrawlex checkout containing docker-compose.yaml"
            onChange={(e) => setComposeDirDraft(e.target.value)}
            onBlur={saveComposeDir}
            spellCheck={false}
          />
        </div>
        <div className="row">
          <button
            className="primary"
            disabled={busy !== null}
            onClick={() => run("start")}
          >
            {busy === "start" ? "Starting…" : "Start stack"}
          </button>
          <button disabled={busy !== null} onClick={() => run("stop")}>
            {busy === "stop" ? "Stopping…" : "Stop stack"}
          </button>
          <button className="ghost" onClick={refreshServices}>
            Refresh status
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Service health</h2>
        <ul className="health-list">
          {HEALTH_TARGETS.map((t) => {
            const h = health[t.key];
            return (
              <li key={t.key}>
                <span className={h?.ok ? "dot green" : "dot red"} />
                <span className="health-label">{t.label}</span>
                <span className="muted">:{t.port}</span>
                <span className="health-detail">
                  {h ? h.detail : "checking…"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="card">
        <h2>Compose services</h2>
        {statusError ? (
          <p className="error-text">{statusError}</p>
        ) : services.length === 0 ? (
          <p className="muted">
            {settings.composeDir.trim()
              ? "No containers found for this project (stack not started?)."
              : "Set the compose project directory above to see container status."}
          </p>
        ) : (
          <table className="service-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>State</th>
                <th>Health</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>
                    <span
                      className={
                        s.state === "running" ? "dot green" : "dot red"
                      }
                    />
                    {s.state || "?"}
                  </td>
                  <td>{s.health || "—"}</td>
                  <td className="muted">{s.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Last run output</h2>
        <pre className="log-box">{log || "No commands run yet."}</pre>
      </div>
    </section>
  );
}
