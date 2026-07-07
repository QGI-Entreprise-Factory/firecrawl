// Thin typed wrappers around the Rust commands. All HTTP and process work
// happens in Rust (src-tauri/src/main.rs); the frontend only invokes commands.
import { invoke } from "@tauri-apps/api/core";

export interface Settings {
  composeDir: string;
  apiKey: string;
}

export interface CmdOutput {
  success: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ServiceRow {
  name: string;
  state: string;
  health: string;
  status: string;
}

export interface HealthResult {
  ok: boolean;
  detail: string;
}

export interface ConvertResult {
  markdown: string;
  title: string | null;
  converter: string | null;
}

export interface CrawlDocument {
  markdown?: string;
  metadata?: {
    sourceURL?: string;
    url?: string;
    title?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CrawlStatusBody {
  success?: boolean;
  status: "scraping" | "completed" | "failed" | "cancelled";
  completed?: number;
  total?: number;
  next?: string | null;
  data?: CrawlDocument[];
}

export const API_ROOT_URL = "http://localhost:3002/";
export const PDF_HEALTH_URL = "http://localhost:5011/health";
export const OMNI_HEALTH_URL = "http://localhost:5012/health";

export const getSettings = () => invoke<Settings>("get_settings");
export const setSettings = (settings: Settings) =>
  invoke<void>("set_settings", { settings });

export const dockerAvailable = () => invoke<CmdOutput>("docker_available");
export const stackStatus = (composeDir: string) =>
  invoke<ServiceRow[]>("stack_status", { composeDir });
export const stackStart = (composeDir: string) =>
  invoke<CmdOutput>("stack_start", { composeDir });
export const stackStop = (composeDir: string) =>
  invoke<CmdOutput>("stack_stop", { composeDir });
export const serviceHealth = (url: string) =>
  invoke<HealthResult>("service_health", { url });

export const convertFile = (path: string) =>
  invoke<ConvertResult>("convert_file", { path });

export const startCrawl = (url: string, limit: number | null, apiKey: string) =>
  invoke<string>("start_crawl", { url, limit, apiKey });
export const crawlStatus = (idOrUrl: string, apiKey: string) =>
  invoke<CrawlStatusBody>("crawl_status", { idOrUrl, apiKey });

export const saveTextFile = (path: string, content: string) =>
  invoke<void>("save_text_file", { path, content });
export const saveCrawlResults = (
  dir: string,
  pages: { url: string; markdown: string }[],
) => invoke<string[]>("save_crawl_results", { dir, pages });

export function errorToString(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return JSON.stringify(err);
}
