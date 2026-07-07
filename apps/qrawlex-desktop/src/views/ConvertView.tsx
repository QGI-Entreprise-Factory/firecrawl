import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { convertFile, errorToString, saveTextFile } from "../api";

type ItemStatus = "pending" | "converting" | "done" | "error";

interface Item {
  id: number;
  path: string;
  name: string;
  status: ItemStatus;
  markdown?: string;
  converter?: string | null;
  error?: string;
}

let nextId = 1;

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function stem(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

export default function ConvertView() {
  const [items, setItems] = useState<Item[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const queueRef = useRef<Item[]>([]);
  const runningRef = useRef(false);

  const patch = (id: number, changes: Partial<Item>) =>
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, ...changes } : it)),
    );

  // Convert files one at a time — audio/large docs can take minutes and the
  // services are single-purpose local containers.
  const pump = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    while (queueRef.current.length > 0) {
      const item = queueRef.current.shift()!;
      patch(item.id, { status: "converting" });
      try {
        const result = await convertFile(item.path);
        patch(item.id, {
          status: "done",
          markdown: result.markdown,
          converter: result.converter,
        });
      } catch (err) {
        patch(item.id, { status: "error", error: errorToString(err) });
      }
    }
    runningRef.current = false;
  };

  const addFiles = (paths: string[]) => {
    const fresh = paths.map(
      (path): Item => ({
        id: nextId++,
        path,
        name: baseName(path),
        status: "pending",
      }),
    );
    if (fresh.length === 0) return;
    setItems((prev) => [...prev, ...fresh]);
    queueRef.current.push(...fresh);
    void pump();
  };

  // Native drag & drop: Tauri intercepts OS file drops and reports real paths.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDragOver(true);
      } else if (event.payload.type === "leave") {
        setDragOver(false);
      } else if (event.payload.type === "drop") {
        setDragOver(false);
        addFiles(event.payload.paths);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickFiles = async () => {
    const selection = await open({ multiple: true, title: "Choose files to convert" });
    if (Array.isArray(selection)) addFiles(selection);
    else if (typeof selection === "string") addFiles([selection]);
  };

  const saveMarkdown = async (item: Item) => {
    if (item.markdown === undefined) return;
    const target = await save({
      title: "Save markdown",
      defaultPath: `${stem(item.name)}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!target) return;
    try {
      await saveTextFile(target, item.markdown);
    } catch (err) {
      patch(item.id, { error: errorToString(err) });
    }
  };

  const copyMarkdown = async (item: Item) => {
    if (item.markdown === undefined) return;
    try {
      await navigator.clipboard.writeText(item.markdown);
      setCopied(item.id);
      setTimeout(() => setCopied((c) => (c === item.id ? null : c)), 1500);
    } catch {
      // Clipboard can be restricted in some webviews; fall back silently.
    }
  };

  return (
    <section className="view">
      <div className="card">
        <h2>Convert files to markdown</h2>
        <p className="hint">
          PDFs go to the structure-aware PDF service (port 5011); everything
          else (Office, images, audio, ZIP, EPUB, …) goes to the omni-convert
          service (port 5012). Both must be running — see the Stack tab.
        </p>
        <div
          className={dragOver ? "dropzone active" : "dropzone"}
          onClick={pickFiles}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && pickFiles()}
        >
          <p className="dropzone-title">
            {dragOver ? "Drop to convert" : "Drop files here"}
          </p>
          <p className="muted">or click to choose files</p>
        </div>
      </div>

      {items.length > 0 && (
        <div className="card">
          <h2>Files</h2>
          <ul className="file-list">
            {items.map((item) => (
              <li key={item.id} className="file-item">
                <div className="file-line">
                  <span className={`badge ${item.status}`}>{item.status}</span>
                  <span className="file-name" title={item.path}>
                    {item.name}
                  </span>
                  {item.converter && (
                    <span className="muted">via {item.converter}</span>
                  )}
                  {item.status === "done" && (
                    <span className="file-actions">
                      <button onClick={() => saveMarkdown(item)}>
                        Save markdown…
                      </button>
                      <button className="ghost" onClick={() => copyMarkdown(item)}>
                        {copied === item.id ? "Copied!" : "Copy"}
                      </button>
                    </span>
                  )}
                </div>
                {item.status === "error" && (
                  <p className="error-text">{item.error}</p>
                )}
                {item.status === "done" && item.markdown !== undefined && (
                  <details>
                    <summary className="muted">
                      preview ({item.markdown.length.toLocaleString()} chars)
                    </summary>
                    <pre className="log-box">
                      {item.markdown.slice(0, 4000)}
                      {item.markdown.length > 4000 ? "\n…(truncated)" : ""}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
          <div className="row">
            <button
              className="ghost"
              onClick={() =>
                setItems((prev) =>
                  prev.filter(
                    (it) => it.status === "pending" || it.status === "converting",
                  ),
                )
              }
            >
              Clear finished
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
