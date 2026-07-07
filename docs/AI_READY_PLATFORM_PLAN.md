# AI-Ready Content Platform — Consolidation & Rebrand Plan

> Status: **Phase 0 — analysis & preparation** (this document).
> Scope: three repositories that together become one rebranded platform:
>
> | Repo | Role in the platform | License |
> |---|---|---|
> | `firecrawl` | Crawler / orchestrator — fetches URLs, routes content, produces output formats | AGPL-3.0 |
> | `opendataloader-pdf` | Structure-aware PDF → AI-ready markdown/JSON engine (Java core, Python/Node wrappers) | Apache-2.0 |
> | `markitdown` | Long-tail file converter (Office, images, audio, archives, e-books, …) — fork of `microsoft/markitdown` | MIT (Microsoft copyright) |
>
> This document is committed identically to all three repos so each has full context.
> A repo-specific `REBRAND_CHECKLIST.md` sits next to it in each repo.

---

## 1. Goal

**Every file encountered during a crawl can be turned into AI-ready output** —
clean markdown plus structured, provenance-carrying JSON — under a single new
brand, with one deployment story.

Today the crawler rejects large classes of files outright. The other two repos
already contain the missing converters. The work is (a) wire them in behind
the crawler's existing external-service pattern, and (b) rebrand the combined
surface once a name is chosen.

## 2. Current state — who can convert what

### 2.1 Firecrawl's pipeline (the orchestrator)

One URL is processed by `scrapeURL` (`apps/api/src/scraper/scrapeURL/index.ts`):

1. **Engine selection** — a scored fallback list of engines (`engines/index.ts`):
   `fetch`, `playwright`, `fire-engine;*`, `pdf`, `document`, `index`, …
2. **Content-type dispatch** — after a fetch, `specialtyScrapeCheck`
   (`engines/utils/specialtyHandler.ts`) inspects `Content-Type` (and magic
   bytes) and re-routes to the `pdf` or `document` engine with the prefetched
   file buffer.
3. **Transformers** (`transformers/index.ts`) turn the engine result into the
   requested formats: `markdown`, `html`, `rawHtml`, `links`, `images`,
   `summary`, `json`, `screenshot`, `changeTracking`, `audio`, `video`, …

Non-HTML handling today:

| Type | Handling | Where |
|---|---|---|
| PDF | Waterfall: Rust extractor (`@mendable/firecrawl-rs`) → MinerU/RunPod (`RUNPOD_MU_*`) → **Fire PDF external service** (`FIRE_PDF_BASE_URL`) → local `pdfParse` | `engines/pdf/index.ts` |
| DOCX, DOC, ODT, RTF, XLSX, XLS | Rust `DocumentConverter.convertBufferToHtml` | `engines/document/index.ts` |
| Images, audio/video files, ZIP/TAR/RAR/7Z, executables, **PPTX**, EPUB, MSG, IPYNB … | **Rejected** — `UnsupportedFileError` → `SCRAPE_UNSUPPORTED_FILE_ERROR` | `specialtyHandler.ts:159-177` |

**Key insight:** the *Fire PDF* client (`engines/pdf/fire-pdf/`) is already the
exact template for plugging in an external converter microservice — env-var
configured (`FIRE_PDF_ENABLE/BASE_URL/API_KEY/PERCENT`), base64 submit, poll,
returns `{markdown, html}`.

### 2.2 opendataloader-pdf (the high-fidelity PDF engine)

- Deterministic, rule-based layout analysis in Java (CPU-only, local): headings
  with levels, tables, lists, reading order (XY-Cut++), formulas, captions,
  header/footer detection — **every element carries a bounding box** (RAG
  citations), plus prompt-injection safety filters (hidden/off-page/tiny text).
- Outputs: `markdown`, `markdown-with-html`, `markdown-with-images`, `json`
  (schema in `schema.json`), `html`, `text`, annotated `pdf`.
- Interfaces: Java library/CLI (Maven `org.opendataloader:*`), PyPI
  `opendataloader-pdf` (+`-mcp`), npm `@opendataloader/pdf` — Python/Node are
  thin wrappers that **spawn a JVM per call**.
- Optional **hybrid mode**: Java triages hard pages to a FastAPI backend
  (`opendataloader-pdf-hybrid`, port 5002) running Docling for OCR, formula
  (LaTeX) and picture descriptions. Note: that backend returns Docling JSON for
  the Java client only — it is **not** a general bytes→markdown API.
- **No Dockerfile, no general HTTP service, no env vars** exist today.

### 2.3 markitdown (the long-tail converter)

Fork of `microsoft/markitdown` @ v0.1.6, tracking upstream. Stream-based
converter registry (`packages/markitdown/src/markitdown/_markitdown.py`) with
magika magic-byte detection and priority-ordered `accepts()/convert()`:

PDF, DOCX (incl. OMML math), XLSX/XLS, **PPTX**, images (exiftool + LLM
captions), audio (transcription), Outlook MSG, ZIP (recursive), EPUB, CSV,
IPYNB, HTML/RSS/Wikipedia/YouTube, plus opt-in Azure Document Intelligence /
Content Understanding, and an OCR plugin (`markitdown-ocr`, PyMuPDF + LLM
vision).

Its PDF converter is word-position heuristics (pdfplumber/pdfminer): no heading
hierarchy, no reading-order guarantees, no scanned-PDF OCR by default — which
is exactly why **opendataloader-pdf owns PDFs** in the combined platform and
markitdown owns everything else.

Best integration API for a crawler holding downloaded bytes:
`MarkItDown().convert_stream(BytesIO(data), stream_info=StreamInfo(mimetype=…,
extension=…, url=…))` — or `convert_response()` for a full HTTP response. The
shipped MCP server accepts only URIs, not bytes, so the platform needs a thin
byte-accepting HTTP wrapper (see §4).

## 3. Gap analysis — coverage after consolidation

| File type crawled | Today (firecrawl alone) | Combined platform |
|---|---|---|
| HTML | ✅ native | ✅ native |
| PDF (digital) | ✅ basic→good (waterfall) | ✅ **structure-aware** (headings, tables, reading order, bboxes) via opendataloader-pdf |
| PDF (scanned) | ⚠️ OCR mode via paid externals | ✅ hybrid backend OCR (80+ langs) |
| DOCX/XLSX/DOC/ODT/RTF | ✅ Rust converter | ✅ Rust or markitdown (richer: math, form fields) |
| **PPTX** | ❌ rejected | ✅ markitdown |
| Images (jpg/png) | ❌ rejected | ✅ markitdown (exiftool metadata + LLM caption) |
| Audio (wav/mp3/m4a) | ❌ rejected (as files) | ✅ markitdown transcription |
| ZIP archives | ❌ rejected | ✅ markitdown (recursive member conversion) |
| EPUB | ❌ rejected | ✅ markitdown |
| Outlook MSG | ❌ rejected | ✅ markitdown |
| IPYNB / CSV | ⚠️ plain text at best | ✅ markitdown (structured) |
| TAR/RAR/7Z, executables | ❌ rejected | ❌ stays rejected (by design; archives beyond ZIP = later) |

## 4. Target architecture

```
                       ┌──────────────────────────────────────────────┐
 crawl/scrape request  │            firecrawl API + workers           │
 ─────────────────────▶│  scrapeURL → engines → transformers → doc    │
                       └──────┬───────────────┬───────────────────────┘
                              │ content-type  │
                              │ dispatch      │
                 ┌────────────▼───┐       ┌───▼────────────────────┐
                 │  PDF service   │       │  Omni-convert service  │
                 │ opendataloader │       │  markitdown HTTP wrap  │
                 │  (Java core,   │       │  (FastAPI, long-lived, │
                 │   HTTP wrap)   │       │   bytes + StreamInfo)  │
                 └────────┬───────┘       └───┬────────────────────┘
                          │ markdown + JSON   │ markdown (+ title)
                          │ (bboxes, order)   │
                          ▼                   ▼
                 unified "AI-ready document" contract (§4.4)
```

### 4.1 New service: `pdf-service` (opendataloader-pdf)

A thin HTTP wrapper (FastAPI or a Java handler around
`OpenDataLoaderPDF.processFile`) exposing:

- `POST /v1/convert` — multipart or base64 PDF bytes → `{markdown, json,
  metadata, processing_time}`; options passthrough for `--format`,
  `--image-output embedded`, safety filters, `--hybrid docling-fast`.
- `GET /health`.
- **Dockerfile required** (none exists) — JRE 21 + shaded CLI jar; optional
  sidecar container for the hybrid Docling backend.
- Avoid per-call JVM spawn: keep the JVM resident (wrap the Java library, not
  the CLI) or use a worker pool.

### 4.2 New service: `omni-convert-service` (markitdown)

A small FastAPI app (new package, e.g. `packages/markitdown-serve/`) —
**wrap, don't fork-modify**, so upstream merges stay cheap:

- `POST /v1/convert` — raw bytes + headers (`Content-Type`,
  `X-Source-Url`, `X-Filename`) → build `StreamInfo`, call
  `convert_stream()` → `{markdown, title, converter_used}`.
- One `MarkItDown` instance **per worker** (the class is not thread-safe:
  shared `requests.Session`, magika model, stream seeks) — use uvicorn workers,
  not threads.
- Optional `llm_client` wiring for image captions reuses firecrawl's existing
  `OPENAI_API_KEY`/`OLLAMA_BASE_URL` self-host convention.
- Reuse the existing `markitdown-mcp` Dockerfile as the base image recipe.

### 4.3 Firecrawl integration (mirror the Fire PDF pattern)

1. **Config** (`apps/api/src/config.ts`), brand-neutral names:
   `PDF_SERVICE_URL`, `PDF_SERVICE_API_KEY`, `OMNI_CONVERT_SERVICE_URL`,
   `OMNI_CONVERT_SERVICE_API_KEY` (+ optional `*_PERCENT` rollout knobs).
2. **PDF**: insert the pdf-service as a tier in the `scrapePDF` waterfall
   (`engines/pdf/index.ts`) — modeled 1:1 on `fire-pdf/submit.ts`.
3. **Everything else**: in `specialtyScrapeCheck`
   (`engines/utils/specialtyHandler.ts`), when `OMNI_CONVERT_SERVICE_URL` is
   set, route the currently-rejected types (`image/*`, `audio/*`,
   `application/zip`, PPTX, EPUB, MSG, IPYNB, …) via
   `AddFeatureError(["document"])` (or a new `omniConvert` feature flag +
   engine registered in `engineHandlers`) instead of throwing
   `UnsupportedFileError`. The prefetch plumbing
   (`Meta.documentPrefetch`) already carries the bytes.
4. **Formats**: converted markdown flows into the existing transformer stack
   unchanged, so `summary`, `json` (LLM extract), `changeTracking` etc. work
   on every file type for free. opendataloader's structured JSON surfaces via
   the existing `deterministicJson` format.
5. **Tests**: snips E2E per new type (happy path: PPTX → markdown; failure
   path: service down → graceful fallback/legacy error), gated with
   `!process.env.TEST_SUITE_SELF_HOSTED` where the service isn't in the
   self-host compose, using `scrapeTimeout` from `./lib`.
6. **docker-compose.yaml**: add `pdf-service` and `omni-convert-service`
   entries so self-host gets full coverage out of the box.

### 4.4 Unified "AI-ready document" contract

Every conversion, whatever the source type, resolves to:

```jsonc
{
  "markdown": "…",                    // always present
  "metadata": {
    "sourceUrl": "…", "contentType": "…", "converter": "pdf-service|omni|rust|native",
    "title": "…", "language": "…", "pageCount": 12
  },
  "structured": { /* optional: opendataloader JSON — elements with type,
                     page, bounding box, heading level, table cells */ },
  "warnings": ["hidden-text-filtered", "ocr-used", …]
}
```

This maps onto firecrawl's existing `Document` (markdown + metadata +
`deterministicJson`) without breaking the public API.

## 5. Rebrand strategy

No target name is chosen yet, so all preparation is **name-agnostic**: the
per-repo `REBRAND_CHECKLIST.md` files inventory every touchpoint; execution is
find-replace + republish once `{{BRAND}}` is decided.

### 5.1 Principles

- **Public names last, internals first.** Registry publishes
  (npm/PyPI/Maven/gems/NuGet) are irreversible name-squats — do them once, at
  the end, with deprecation stubs pointing from the old names.
- **Dual-read env vars** during transition: new `{{BRAND}}_*` var read first,
  legacy `FIRECRAWL_*` honored with a deprecation warning for ≥1 release.
- **Wrap forks, don't rename them.** markitdown tracks
  `microsoft/markitdown`; renaming its import path/entry-point group
  (`markitdown.plugin`) forfeits cheap upstream merges and breaks the plugin
  ecosystem. Brand the *service layer* (§4.2) and keep the fork as a vendored
  dependency. Same logic applies to `org.opendataloader` Java packages
  (~317 refs, 100+ files): rebrand the published artifact IDs and docs first;
  the internal Java namespace can follow later or never.
- **Centralize user-facing strings first.** Firecrawl error messages hardcode
  "Firecrawl", `help@firecrawl.com`, `firecrawl.dev/signin` throughout
  `scrapeURL/error.ts` — extract to a single branding module so the rename is
  one file.
- **License hygiene**: firecrawl core is AGPL-3.0 — the combined platform's
  service composition keeps components in separate processes/services, which
  is the clean pattern. markitdown's MIT notice (Microsoft copyright) and
  opendataloader's Apache-2.0 NOTICE must survive the rebrand verbatim.

### 5.2 Effort ranking (highest-impact touchpoints)

| Rank | Touchpoint | Repo | Scale |
|---|---|---|---|
| 1 | SDK package names across 10 registries (`firecrawl-py`, `@mendable/firecrawl-js`, gems, NuGet, Maven, Go module path…) | firecrawl | ~10 publishes + deprecation stubs |
| 2 | `FIRECRAWL_API_KEY` / `FIRECRAWL_API_URL` in every SDK (~208 refs) + `FIRECRAWL_*` server env | firecrawl | dual-read shim |
| 3 | Default URLs `api.firecrawl.dev`, dashboard, docs domain; `opendataloader.org` + release-time docs sync | firecrawl, odl-pdf | DNS + redirects |
| 4 | Docker images `ghcr.io/firecrawl/*`; compose project name | firecrawl | re-tag + mirror |
| 5 | Maven `org.opendataloader` coordinates + Java namespace | odl-pdf | publish new coords; namespace optional |
| 6 | PyPI/npm `opendataloader-pdf*`, `@opendataloader/pdf` | odl-pdf | republish + stubs |
| 7 | User-facing error strings / support emails | firecrawl | centralize then rename |
| 8 | `@mendable/firecrawl-rs` native dep + `@mendable` npm scope | firecrawl | republish |
| 9 | markitdown service-layer branding only (fork stays) | markitdown | small |

## 6. Phased roadmap

- **Phase 0 (this branch)** — analysis, this plan, per-repo rebrand
  checklists. ✅
- **Phase 1 — Omni-convert service**: `markitdown-serve` FastAPI wrapper +
  Dockerfile; firecrawl `OMNI_CONVERT_SERVICE_URL` engine + routing for
  currently-rejected types; snips E2E; compose entry. *Unlocks the headline:
  no more `SCRAPE_UNSUPPORTED_FILE_ERROR` for common formats.*
- **Phase 2 — PDF service**: HTTP wrapper + Dockerfile for opendataloader-pdf
  (resident JVM); tier in firecrawl's PDF waterfall; `deterministicJson`
  carries bounding-box JSON; optional hybrid/Docling sidecar for OCR.
- **Phase 3 — Rebrand execution** (needs the chosen name): run the three
  checklists — strings module, dual-read env vars, registry publishes with
  deprecation stubs, domains/redirects, docker retags.
- **Phase 4 — Platform polish**: unified docker-compose profile, one docs
  site, SDK examples updated, benchmark page (opendataloader's bench harness)
  extended to crawl-to-markdown quality.

## 7. Risks & open questions

1. **AGPL boundary** — keep converters as separate network services (as
   designed) and confirm distribution posture with counsel before shipping a
   single binary/image bundling AGPL + MIT + Apache components.
2. **Fork drift** — markitdown must keep merging upstream; every fork-local
   change should live in `packages/markitdown-serve/` (new) rather than in
   `packages/markitdown/`.
3. **JVM latency** — opendataloader per-call JVM spawn is ~seconds; the HTTP
   wrapper must keep the JVM resident before it can sit in the scrape hot
   path.
4. **Media cost controls** — image captioning and audio transcription call
   LLM/speech APIs; needs per-team-flag gating and `*_PERCENT` style rollout
   like Fire PDF.
5. **Name** — `{{BRAND}}` is undecided; Phase 3 is fully blocked on it, but
   Phases 1–2 are not.
