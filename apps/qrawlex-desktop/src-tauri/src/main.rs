// Qrawlex Desktop — Tauri v2 backend.
//
// All HTTP calls to the local Qrawlex services and all process work (docker /
// docker compose) happen here, so the webview never fights CORS and never
// shells out. Docker commands are always spawned with an argument array
// (never through a shell) and with the working directory set to the
// user-configured compose project directory.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

const API_BASE: &str = "http://localhost:3002";
const PDF_SERVICE_CONVERT: &str = "http://localhost:5011/v1/convert";
const OMNI_SERVICE_CONVERT: &str = "http://localhost:5012/v1/convert";

/// Conversions (especially audio transcription) can be slow.
const CONVERT_TIMEOUT: Duration = Duration::from_secs(600);
const API_TIMEOUT: Duration = Duration::from_secs(120);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Settings (JSON file in the app config dir)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    /// Path to a checkout containing docker-compose.yaml.
    compose_dir: String,
    /// Optional API key sent as `Authorization: Bearer …` to the Qrawlex API.
    /// Self-hosted stacks usually run without auth, so this defaults to empty.
    api_key: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create config dir {}: {e}", dir.display()))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    if !path.is_file() {
        return Ok(Settings::default());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("settings file is corrupt: {e}"))
}

#[tauri::command]
fn set_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("could not write {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// Docker / compose stack management
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct CmdOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

async fn run_docker(args: &[&str], dir: Option<&Path>) -> Result<CmdOutput, String> {
    let mut cmd = tokio::process::Command::new("docker");
    cmd.args(args);
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW — don't flash a console window.
        cmd.creation_flags(0x0800_0000);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("failed to run docker (is Docker installed and on PATH?): {e}"))?;
    Ok(CmdOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Validate the configured compose project directory and make sure a compose
/// file actually exists in it before running anything.
fn compose_project_dir(compose_dir: &str) -> Result<PathBuf, String> {
    let trimmed = compose_dir.trim();
    if trimmed.is_empty() {
        return Err(
            "No compose project directory configured. In the Stack tab, set it to the path \
             of your qrawlex checkout (the directory containing docker-compose.yaml)."
                .into(),
        );
    }
    let dir = Path::new(trimmed);
    if !dir.is_dir() {
        return Err(format!("{trimmed} is not a directory"));
    }
    const CANDIDATES: [&str; 4] = [
        "docker-compose.yaml",
        "docker-compose.yml",
        "compose.yaml",
        "compose.yml",
    ];
    if CANDIDATES.iter().any(|name| dir.join(name).is_file()) {
        Ok(dir.to_path_buf())
    } else {
        Err(format!(
            "No docker-compose.yaml found in {trimmed}. Point the setting at your qrawlex checkout."
        ))
    }
}

#[tauri::command]
async fn docker_available() -> Result<CmdOutput, String> {
    run_docker(
        &[
            "version",
            "--format",
            "client {{.Client.Version}} / server {{.Server.Version}}",
        ],
        None,
    )
    .await
}

#[derive(Serialize)]
struct ServiceRow {
    name: String,
    state: String,
    health: String,
    status: String,
}

fn value_to_row(v: &Value) -> Option<ServiceRow> {
    let obj = v.as_object()?;
    let get = |k: &str| obj.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let name = {
        let service = get("Service");
        if service.is_empty() { get("Name") } else { service }
    };
    if name.is_empty() {
        return None;
    }
    Some(ServiceRow {
        name,
        state: get("State"),
        health: get("Health"),
        status: get("Status"),
    })
}

#[tauri::command]
async fn stack_status(compose_dir: String) -> Result<Vec<ServiceRow>, String> {
    let dir = compose_project_dir(&compose_dir)?;
    let out = run_docker(
        &["compose", "--profile", "converters", "ps", "-a", "--format", "json"],
        Some(&dir),
    )
    .await?;
    if !out.success {
        return Err(if out.stderr.trim().is_empty() {
            "docker compose ps failed".to_string()
        } else {
            out.stderr.trim().to_string()
        });
    }
    let stdout = out.stdout.trim();
    if stdout.is_empty() {
        return Ok(vec![]);
    }
    // Depending on the compose version, `ps --format json` emits either a JSON
    // array or newline-delimited JSON objects. Handle both.
    let mut rows = Vec::new();
    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(stdout) {
        rows.extend(items.iter().filter_map(value_to_row));
    } else {
        for line in stdout.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let Some(row) = value_to_row(&v) {
                    rows.push(row);
                }
            }
        }
    }
    Ok(rows)
}

#[tauri::command]
async fn stack_start(compose_dir: String) -> Result<CmdOutput, String> {
    let dir = compose_project_dir(&compose_dir)?;
    run_docker(
        &["compose", "--profile", "converters", "up", "-d"],
        Some(&dir),
    )
    .await
}

#[tauri::command]
async fn stack_stop(compose_dir: String) -> Result<CmdOutput, String> {
    let dir = compose_project_dir(&compose_dir)?;
    run_docker(&["compose", "--profile", "converters", "down"], Some(&dir)).await
}

// ---------------------------------------------------------------------------
// Health probes
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct HealthResult {
    ok: bool,
    detail: String,
}

/// GET a URL with a short timeout. The API root (`/`) answers with
/// `{"message": …}`; the converter services' `/health` answer with
/// `{"status": …}`. Anything HTTP 200 counts as healthy.
#[tauri::command]
async fn service_health(url: String) -> HealthResult {
    let client = match reqwest::Client::builder().timeout(HEALTH_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            return HealthResult { ok: false, detail: e.to_string() };
        }
    };
    match client.get(&url).send().await {
        Ok(resp) => {
            let status = resp.status();
            let detail = match resp.json::<Value>().await {
                Ok(body) => body
                    .get("message")
                    .or_else(|| body.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("ok")
                    .to_string(),
                Err(_) => format!("HTTP {}", status.as_u16()),
            };
            HealthResult { ok: status.is_success(), detail }
        }
        Err(_) => HealthResult { ok: false, detail: "unreachable".into() },
    }
}

// ---------------------------------------------------------------------------
// Convert (PDF service on 5011, omni-convert service on 5012)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ConvertResult {
    markdown: String,
    title: Option<String>,
    converter: Option<String>,
}

fn guess_content_type(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "doc" => "application/msword",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" => "application/vnd.ms-excel",
        "odt" => "application/vnd.oasis.opendocument.text",
        "rtf" => "application/rtf",
        "epub" => "application/epub+zip",
        "zip" => "application/zip",
        "msg" => "application/vnd.ms-outlook",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "ipynb" | "json" => "application/json",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "txt" | "md" | "markdown" => "text/plain",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tiff" | "tif" => "image/tiff",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

fn service_error_detail(status: u16, body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        for key in ["detail", "error", "message"] {
            if let Some(msg) = v.get(key) {
                let msg = msg
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| msg.to_string());
                return format!("HTTP {status}: {msg}");
            }
        }
    }
    let snippet: String = body.chars().take(300).collect();
    if snippet.trim().is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {snippet}")
    }
}

fn unreachable_hint(service: &str, err: &reqwest::Error) -> String {
    if err.is_connect() || err.is_timeout() {
        format!(
            "{service} is unreachable — the converter services don't seem to be running. \
             Start the platform from the Stack tab, then retry."
        )
    } else {
        format!("{service} request failed: {err}")
    }
}

#[tauri::command]
async fn convert_file(path: String) -> Result<ConvertResult, String> {
    let file_path = PathBuf::from(&path);
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| "file".to_string());
    let bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("could not read {path}: {e}"))?;

    let client = reqwest::Client::builder()
        .timeout(CONVERT_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;

    let is_pdf = file_name.to_ascii_lowercase().ends_with(".pdf");
    let response = if is_pdf {
        // PDF service: multipart form (`file`, `include_json`), mirrors the
        // qrawlex CLI's _convert_pdf_service().
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(file_name.clone())
            .mime_str("application/pdf")
            .map_err(|e| e.to_string())?;
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("include_json", "false");
        client
            .post(PDF_SERVICE_CONVERT)
            .multipart(form)
            .send()
            .await
            .map_err(|e| unreachable_hint("PDF service (localhost:5011)", &e))?
    } else {
        // Omni-convert service: raw bytes + Content-Type + X-Filename, mirrors
        // the qrawlex CLI's _convert_other_service().
        let header_name: String = file_name
            .chars()
            .map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { '_' })
            .collect();
        client
            .post(OMNI_SERVICE_CONVERT)
            .header("Content-Type", guess_content_type(&file_name))
            .header("X-Filename", header_name)
            .body(bytes)
            .send()
            .await
            .map_err(|e| unreachable_hint("omni-convert service (localhost:5012)", &e))?
    };

    let status = response.status().as_u16();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(service_error_detail(status, &text));
    }
    let body: Value = serde_json::from_str(&text)
        .map_err(|_| "converter service returned a non-JSON response".to_string())?;
    let markdown = body
        .get("markdown")
        .and_then(Value::as_str)
        .ok_or_else(|| "converter service response is missing 'markdown'".to_string())?
        .to_string();
    Ok(ConvertResult {
        markdown,
        title: body.get("title").and_then(Value::as_str).map(str::to_string),
        converter: if is_pdf {
            Some("pdf-service".to_string())
        } else {
            body.get("converter_used")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or(Some("omni-convert".to_string()))
        },
    })
}

// ---------------------------------------------------------------------------
// Crawl (Qrawlex API v2 on 3002)
// ---------------------------------------------------------------------------

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(API_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

fn with_auth(req: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
    // Self-hosted instances may run without auth; omit the header then.
    if api_key.trim().is_empty() {
        req
    } else {
        req.bearer_auth(api_key.trim())
    }
}

async fn api_json(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let body: Value = serde_json::from_str(&text).map_err(|_| {
        format!(
            "API returned a non-JSON response (HTTP {status}): {}",
            text.chars().take(300).collect::<String>()
        )
    })?;
    let failed = body.get("success").and_then(Value::as_bool) == Some(false);
    if status >= 400 || failed {
        let detail = body
            .get("error")
            .map(|e| e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string()))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(detail);
    }
    Ok(body)
}

/// POST /v2/crawl {url, limit, scrapeOptions:{formats:["markdown"]}} -> crawl id.
#[tauri::command]
async fn start_crawl(url: String, limit: Option<u32>, api_key: String) -> Result<String, String> {
    let mut body = serde_json::json!({
        "url": url,
        "scrapeOptions": { "formats": ["markdown"] },
    });
    if let Some(limit) = limit {
        body["limit"] = serde_json::json!(limit);
    }
    let client = api_client()?;
    let resp = with_auth(client.post(format!("{API_BASE}/v2/crawl")), &api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| unreachable_hint("Qrawlex API (localhost:3002)", &e))?;
    let body = api_json(resp).await?;
    body.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "crawl response is missing 'id'".to_string())
}

/// GET /v2/crawl/{id} — or an absolute pagination `next` URL. Returns the raw
/// envelope: {success, status, completed, total, next?, data:[Document…]}.
#[tauri::command]
async fn crawl_status(id_or_url: String, api_key: String) -> Result<Value, String> {
    let url = if id_or_url.starts_with("http://") || id_or_url.starts_with("https://") {
        id_or_url
    } else {
        format!("{API_BASE}/v2/crawl/{id_or_url}")
    };
    let client = api_client()?;
    let resp = with_auth(client.get(url), &api_key)
        .send()
        .await
        .map_err(|e| unreachable_hint("Qrawlex API (localhost:3002)", &e))?;
    api_json(resp).await
}

// ---------------------------------------------------------------------------
// Saving results
// ---------------------------------------------------------------------------

#[tauri::command]
fn save_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("could not write {path}: {e}"))
}

/// Mirror of the qrawlex CLI's sanitize_url_to_filename(): netloc + path,
/// invalid runs collapsed to '-', trimmed of '-'/'.', capped at 150 chars,
/// deduplicated with a -2/-3/… suffix.
fn sanitize_url_to_filename(url: &str, used: &mut HashSet<String>) -> String {
    let without_scheme = match url.find("://") {
        Some(idx) => &url[idx + 3..],
        None => url,
    };
    let base = without_scheme
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    let mut slug = String::new();
    let mut last_was_dash = false;
    for c in base.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            slug.push(c);
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }
    let mut slug: String = slug.trim_matches(|c| c == '-' || c == '.').to_string();
    if slug.is_empty() {
        slug = "document".to_string();
    }
    slug.truncate(150); // slug is ASCII-only by construction
    let mut name = slug.clone();
    let mut counter = 2;
    while used.contains(&name) {
        name = format!("{slug}-{counter}");
        counter += 1;
    }
    used.insert(name.clone());
    format!("{name}.md")
}

#[derive(Deserialize)]
struct CrawlPage {
    url: String,
    markdown: String,
}

/// Write one .md file per crawled page into `dir`. Returns the file names written.
#[tauri::command]
fn save_crawl_results(dir: String, pages: Vec<CrawlPage>) -> Result<Vec<String>, String> {
    let out_dir = PathBuf::from(&dir);
    if !out_dir.is_dir() {
        return Err(format!("{dir} is not a directory"));
    }
    let mut used = HashSet::new();
    let mut written = Vec::with_capacity(pages.len());
    for page in &pages {
        let file_name = sanitize_url_to_filename(&page.url, &mut used);
        let path = out_dir.join(&file_name);
        std::fs::write(&path, &page.markdown)
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;
        written.push(file_name);
    }
    Ok(written)
}

// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            docker_available,
            stack_status,
            stack_start,
            stack_stop,
            service_health,
            convert_file,
            start_crawl,
            crawl_status,
            save_text_file,
            save_crawl_results,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Qrawlex Desktop");
}
