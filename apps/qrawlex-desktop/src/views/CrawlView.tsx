import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CrawlDocument,
  Settings,
  crawlStatus,
  errorToString,
  saveCrawlResults,
  startCrawl,
} from "../api";

interface Props {
  settings: Settings;
  onSettingsChange: (next: Settings) => void;
}

type Phase = "idle" | "starting" | "scraping" | "completed" | "failed" | "cancelled";

const POLL_INTERVAL_MS = 2000;

function docUrl(doc: CrawlDocument, index: number): string {
  return doc.metadata?.sourceURL || doc.metadata?.url || `page-${index + 1}`;
}

export default function CrawlView({ settings, onSettingsChange }: Props) {
  const [url, setUrl] = useState("");
  const [limit, setLimit] = useState("10");
  const [apiKeyDraft, setApiKeyDraft] = useState(settings.apiKey);
  const [phase, setPhase] = useState<Phase>("idle");
  const [crawlId, setCrawlId] = useState<string | null>(null);
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);
  const [docs, setDocs] = useState<CrawlDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollBusy = useRef(false);

  useEffect(() => setApiKeyDraft(settings.apiKey), [settings.apiKey]);
  // Stop polling on unmount.
  useEffect(() => () => stopPolling(), []);

  const stopPolling = () => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const saveApiKey = () => {
    const key = apiKeyDraft.trim();
    if (key !== settings.apiKey) onSettingsChange({ ...settings, apiKey: key });
  };

  /** Follow the paginated `next` links once a crawl is completed. */
  const collectAllDocs = async (
    firstPage: { data?: CrawlDocument[]; next?: string | null },
    apiKey: string,
  ) => {
    const all: CrawlDocument[] = [...(firstPage.data ?? [])];
    let next = firstPage.next;
    while (next) {
      const page = await crawlStatus(next, apiKey);
      const pageDocs = page.data ?? [];
      if (pageDocs.length === 0) break;
      all.push(...pageDocs);
      next = page.next;
    }
    return all;
  };

  const begin = async () => {
    const target = url.trim();
    if (!target) {
      setError("Enter a URL to crawl.");
      return;
    }
    saveApiKey();
    const apiKey = apiKeyDraft.trim();
    const parsedLimit = parseInt(limit, 10);
    const limitValue = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;

    stopPolling();
    setPhase("starting");
    setError(null);
    setSaveMessage(null);
    setDocs([]);
    setCompleted(0);
    setTotal(0);

    let id: string;
    try {
      id = await startCrawl(target, limitValue, apiKey);
    } catch (err) {
      setPhase("failed");
      setError(errorToString(err));
      return;
    }
    setCrawlId(id);
    setPhase("scraping");

    pollTimer.current = setInterval(async () => {
      if (pollBusy.current) return; // don't overlap slow polls
      pollBusy.current = true;
      try {
        const body = await crawlStatus(id, apiKey);
        setCompleted(body.completed ?? 0);
        setTotal(body.total ?? 0);
        const status = body.status;
        if (status === "completed" || status === "failed" || status === "cancelled") {
          stopPolling();
          if (status === "completed") {
            setDocs(await collectAllDocs(body, apiKey));
          } else {
            setError(`Crawl finished with status "${status}".`);
          }
          setPhase(status);
        }
      } catch (err) {
        stopPolling();
        setPhase("failed");
        setError(errorToString(err));
      } finally {
        pollBusy.current = false;
      }
    }, POLL_INTERVAL_MS);
  };

  const saveAll = async () => {
    const dir = await open({
      directory: true,
      title: "Choose a folder for the crawled markdown",
    });
    if (typeof dir !== "string") return;
    const pages = docs
      .map((doc, i) => ({ url: docUrl(doc, i), markdown: doc.markdown }))
      .filter((p): p is { url: string; markdown: string } => p.markdown != null);
    try {
      const written = await saveCrawlResults(dir, pages);
      const skipped = docs.length - pages.length;
      setSaveMessage(
        `Wrote ${written.length} file(s) to ${dir}` +
          (skipped > 0 ? ` (${skipped} page(s) had no markdown and were skipped)` : ""),
      );
    } catch (err) {
      setError(errorToString(err));
    }
  };

  const running = phase === "starting" || phase === "scraping";
  const progressPct = total > 0 ? Math.min(100, (completed / total) * 100) : 0;

  return (
    <section className="view">
      <div className="card">
        <h2>Crawl a website</h2>
        <p className="hint">
          Starts a crawl on the local Qrawlex API (port 3002) and polls until
          it finishes. Each page is scraped to markdown.
        </p>
        <div className="row">
          <input
            type="text"
            value={url}
            placeholder="https://example.com"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !running && begin()}
            spellCheck={false}
            style={{ flex: 3 }}
          />
          <label className="inline-label">
            limit
            <input
              type="number"
              min="1"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              style={{ width: "5.5rem" }}
            />
          </label>
          <button className="primary" disabled={running} onClick={begin}>
            {running ? "Crawling…" : "Start crawl"}
          </button>
        </div>
        <details className="settings-details">
          <summary className="muted">API key (optional — self-host needs none)</summary>
          <div className="row">
            <input
              type="password"
              value={apiKeyDraft}
              placeholder="fc-… (sent as Authorization: Bearer)"
              onChange={(e) => setApiKeyDraft(e.target.value)}
              onBlur={saveApiKey}
              spellCheck={false}
            />
          </div>
        </details>
      </div>

      {(running || phase === "completed" || crawlId) && (
        <div className="card">
          <h2>Progress</h2>
          {crawlId && (
            <p className="muted">
              crawl <code>{crawlId}</code> — {phase}
            </p>
          )}
          <div className="progress-track">
            <div
              className={`progress-fill ${phase === "completed" ? "done" : ""}`}
              style={{ width: `${phase === "completed" ? 100 : progressPct}%` }}
            />
          </div>
          <p className="muted">
            {completed}/{total || "?"} pages
          </p>
        </div>
      )}

      {error && <div className="banner error">{error}</div>}
      {saveMessage && <div className="banner ok">{saveMessage}</div>}

      {phase === "completed" && (
        <div className="card">
          <div className="row space-between">
            <h2>Results ({docs.length} pages)</h2>
            <button className="primary" onClick={saveAll} disabled={docs.length === 0}>
              Save all to folder…
            </button>
          </div>
          <ul className="result-list">
            {docs.map((doc, i) => (
              <li key={i}>
                <span className={doc.markdown != null ? "dot green" : "dot red"} />
                {docUrl(doc, i)}
                {doc.markdown == null && <span className="muted"> (no markdown)</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
