# qrawlex

Unified command-line interface for the **Qrawlex** AI-ready content platform:

- **scrape / crawl / map** — talk to a Qrawlex (firecrawl) API server (`/v2` endpoints)
- **convert** — turn local files into AI-ready markdown, either fully locally or
  via the platform's converter services:
  - PDFs go through the structure-aware PDF engine
    ([opendataloader-pdf](https://github.com/opendataloader-project/opendataloader-pdf):
    headings, tables, reading order, bounding-box JSON)
  - everything else (PPTX, DOCX, XLSX, images, audio, EPUB, ZIP, CSV, IPYNB, ...)
    goes through the omni engine (markitdown)

## Install

```bash
pip install qrawlex                 # CLI + service clients (requests only)
pip install "qrawlex[local]"        # + fully-local conversion:
                                    #   markitdown[all] and opendataloader-pdf
                                    #   (opendataloader-pdf needs a Java runtime)
```

## Commands

### `qrawlex convert` — files to AI-ready markdown

```bash
qrawlex convert report.pdf                          # markdown to stdout
qrawlex convert report.pdf -o report.md             # markdown to a file
qrawlex convert report.pdf --format json            # structured JSON (PDF only)
qrawlex convert slides.pptx notes.docx --out-dir md/  # batch; continues on errors
qrawlex convert big.pdf --via service               # force the PDF service
qrawlex convert data.csv --via local                # force local conversion
```

- Routing: `.pdf` files use the PDF engine, everything else the omni engine.
- `--via auto` (default): uses the service when its `QRAWLEX_*_SERVICE_URL`
  env var is set, otherwise the local library.
- `--format json` is PDF-only — it emits opendataloader's structured JSON
  (elements with types, pages, bounding boxes). With `--out-dir`, both
  `<stem>.md` and `<stem>.json` are written.
- Multiple files (or `--out-dir`): writes `<stem>.md` into the directory
  (default `.`), prints one summary line per file to stderr, and exits with
  code 1 if any file failed (remaining files are still converted).

### `qrawlex scrape` — one URL through the Qrawlex API

```bash
qrawlex scrape https://example.com                       # markdown to stdout
qrawlex scrape https://example.com --formats markdown,html,links --json
qrawlex scrape https://example.com -o page.md
```

Calls `POST /v2/scrape` with `{"url": ..., "formats": [...]}` and prints the
returned document's markdown (or the whole document with `--json`).

### `qrawlex crawl` — whole-site crawl to a folder of markdown

```bash
qrawlex crawl https://docs.example.com --limit 50 --out-dir docs-md/
qrawlex crawl https://example.com --poll-interval 5 --timeout 600
```

Starts a crawl (`POST /v2/crawl`), polls `GET /v2/crawl/{id}` until it
completes (following the paginated `next` field), then writes each page's
markdown to `--out-dir` (default `./crawl-<id>/`) with filenames derived from
the page URL. Progress goes to stderr.

### `qrawlex map` — discover a site's URLs

```bash
qrawlex map https://example.com
qrawlex map https://example.com --search changelog
```

Calls `POST /v2/map` and prints one URL per line.

### `qrawlex status` — health check everything

```bash
qrawlex status
```

Prints one line each for: the Qrawlex API, the PDF service, the omni-convert
service, and local `markitdown` / `opendataloader-pdf` availability. Prints
"not configured" for services whose env vars are unset; never crashes.

## Configuration

Flags beat environment variables; new `QRAWLEX_*` names beat legacy
`FIRECRAWL_*` names.

| Setting | Resolution order |
|---|---|
| API URL | `--api-url` > `QRAWLEX_API_URL` > `FIRECRAWL_API_URL` > `http://localhost:3002` |
| API key | `--api-key` > `QRAWLEX_API_KEY` > `FIRECRAWL_API_KEY` > _(none — header omitted for keyless self-host)_ |

| Environment variable | Purpose |
|---|---|
| `QRAWLEX_API_URL` | Qrawlex API base URL |
| `QRAWLEX_API_KEY` | Qrawlex API key (sent as `Authorization: Bearer ...`) |
| `FIRECRAWL_API_URL` / `FIRECRAWL_API_KEY` | Legacy fallbacks for the two above |
| `QRAWLEX_PDF_SERVICE_URL` | Qrawlex PDF service (opendataloader-pdf) base URL |
| `QRAWLEX_PDF_API_KEY` | Bearer key for the PDF service (optional) |
| `QRAWLEX_CONVERT_SERVICE_URL` | Omni-convert service (markitdown) base URL |
| `QRAWLEX_CONVERT_API_KEY` | Bearer key for the omni-convert service (optional) |

## Development

```bash
pip install -e ".[dev]"      # pytest
pytest
```

Tests are fully offline: the HTTP APIs are mocked with a stdlib
`http.server` stub.
