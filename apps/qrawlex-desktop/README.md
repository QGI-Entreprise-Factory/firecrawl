# Qrawlex Desktop

A Tauri v2 desktop app for the Qrawlex platform. Its defining feature: it
**starts and manages the platform's Docker services in the background**, giving
you a local desktop experience for both file conversion and website crawling —
no terminal, no env vars.

Three views:

- **Stack** — checks Docker availability, shows per-service container status
  (`docker compose ps`), starts/stops the whole platform with the
  `converters` profile (`docker compose --profile converters up -d` / `down`),
  and live-polls service health: the API (`:3002`), the PDF service
  (`:5011/health`), and the omni-convert service (`:5012/health`).
- **Convert** — drag & drop (or pick) local files. PDFs go to the
  structure-aware PDF service (`POST :5011/v1/convert`, multipart); everything
  else (Office, images, audio, ZIP, EPUB, …) goes to the omni-convert service
  (`POST :5012/v1/convert`, raw bytes + `X-Filename`). Save or copy the
  resulting markdown per file.
- **Crawl** — enter a URL and page limit; the app starts a crawl on the local
  Qrawlex API (`POST :3002/v2/crawl`), polls progress every 2 s, and on
  completion saves one `.md` per page into a folder you pick (URL-derived
  file names, same scheme as the `qrawlex` CLI).

All HTTP requests and process spawning happen in the Rust backend
(`src-tauri/src/main.rs`), so the webview never deals with CORS. Docker
commands are spawned with argument arrays (never a shell) and run with the
working directory set to your configured compose project directory.

## Configuration (all through the UI — env-free by design)

Settings are stored as JSON in the OS app-config directory (e.g.
`~/.config/com.qrawlex.desktop/settings.json` on Linux):

- **Compose project directory** (Stack tab) — the path to your qrawlex
  checkout, i.e. the directory containing `docker-compose.yaml`. The app
  validates the file exists before running any compose command.
- **API key** (Crawl tab, optional) — sent as `Authorization: Bearer …`.
  Self-hosted stacks usually run without auth; leave it empty.

## Prerequisites

- **Docker Desktop** (or Docker Engine + the compose plugin) — the app shells
  out to `docker` / `docker compose`.
- **Node.js** ≥ 20 and npm.
- **Rust toolchain** (stable, via [rustup](https://rustup.rs)).
- **Linux only** — Tauri's system deps:

  ```sh
  sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
    build-essential curl wget file libxdo-dev libssl-dev \
    libayatana-appindicator3-dev pkg-config
  ```

  (See [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)
  for other distros; macOS needs Xcode CLT, Windows needs the MSVC build
  tools + WebView2.)

This app is intentionally **not** part of the repo's pnpm/knip tooling — it
has its own `package-lock.json`. Always run npm commands inside
`apps/qrawlex-desktop/`.

## Develop

```sh
cd apps/qrawlex-desktop
npm install
npm run tauri dev
```

`tauri dev` starts the Vite dev server on port 1420 and opens the app window.

## Build a distributable

```sh
cd apps/qrawlex-desktop
npm install
npm run tauri build
```

Bundles land in `src-tauri/target/release/bundle/`.

### Icons

`src-tauri/icons/` ships small generated placeholder icons (PNG + ICO) so dev
and Linux builds work out of the box. Before packaging for macOS (which needs
an `.icns`) — or to install a real icon set — run once:

```sh
npm run tauri icon path/to/source-icon.png
```

and add `icons/icon.icns` to the `bundle.icon` list in
`src-tauri/tauri.conf.json`.

## Notes

- The app talks to fixed local ports (3002 / 5011 / 5012), matching the repo's
  `docker-compose.yaml` and its `converters` profile.
- Convert requests use a 10-minute timeout — audio transcription can be slow.
- CI packaging (GitHub Actions matrix builds for macOS / Windows / Linux) is
  future work; build locally for now.
