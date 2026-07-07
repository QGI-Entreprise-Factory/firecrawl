# Rebrand Checklist — firecrawl

> Companion to `docs/AI_READY_PLATFORM_PLAN.md`. Target name is undecided —
> `{{BRAND}}` below. Execute top-to-bottom; items are ordered so nothing
> user-facing breaks before its replacement exists.

## Occurrence inventory (case-insensitive "firecrawl")

| Area | ~Count | Notes |
|---|---|---|
| `examples/` | 1418 | sample code/docs |
| `apps/python-sdk` | 1001 | PyPI `firecrawl-py` |
| `apps/api` | 892 | error strings, config, index keys |
| `apps/js-sdk` | 568 | npm `@mendable/firecrawl-js` |
| `apps/java-sdk` | 495 | |
| `apps/php-sdk` | 281 | |
| `apps/go-sdk` | 229 | module `github.com/firecrawl/firecrawl` |
| `apps/rust-sdk` | 229 | |
| `apps/ruby-sdk` | 225 | gem `firecrawl-sdk` |
| `apps/dot-net-sdk` | 183 | |
| `apps/elixir-sdk` | 145 | |
| `apps/ui` | 53 | playground |
| URLs (`firecrawl.dev`, `api.firecrawl.dev`) | ~623 | across apps |
| `FIRECRAWL_API_KEY` / `FIRECRAWL_API_URL` | ~208 | every SDK |

## 1. Centralize user-facing strings (do first, no name needed)

- [ ] Extract brand name, support emails (`help@firecrawl.com`,
      `support@firecrawl.com`), dashboard/signin URLs from
      `apps/api/src/scraper/scrapeURL/error.ts` (e.g. `UnsupportedFileError`
      :232, `NoEnginesLeftError` :41, proxy messages :126-153,
      `AgentIndexOnlyError` :498) into one branding module.
- [ ] Sweep remaining hardcoded strings in `apps/api/src/controllers/**`.

## 2. Env vars (dual-read shim, no name needed)

- [ ] Server: `FIRECRAWL_APP_HOST/PORT/SCHEME`, `FIRECRAWL_DASHBOARD_URL`,
      `FIRECRAWL_INDEX_WRITE_ONLY`, … (`apps/api/src/config.ts:26-30,
      258-261`) — read `{{BRAND}}_*` first, fall back to `FIRECRAWL_*` with a
      deprecation warning.
- [ ] SDKs: `FIRECRAWL_API_KEY` / `FIRECRAWL_API_URL` (~208 refs) — same
      dual-read in each SDK client constructor.

## 3. Package publishes (needs name; do once, last)

- [ ] npm: `@mendable/firecrawl-js` → `{{BRAND}}` scope
      (`apps/js-sdk/firecrawl/package.json:2`); publish deprecation stub.
- [ ] PyPI: `firecrawl-py` (`apps/python-sdk/pyproject.toml:7`).
- [ ] Go: module path `github.com/firecrawl/firecrawl/apps/go-sdk` (`go.mod`)
      — requires repo/org rename or vanity import.
- [ ] Ruby gem `firecrawl-sdk` (`apps/ruby-sdk/firecrawl-sdk.gemspec`);
      Maven (java-sdk), NuGet (dot-net-sdk), Packagist (php-sdk),
      crates.io (rust-sdk), Hex (elixir-sdk).
- [ ] Native lib `@mendable/firecrawl-rs` (imported in
      `engines/pdf/index.ts:24`, `engines/document/index.ts:4`).

## 4. Infrastructure

- [ ] Docker images `ghcr.io/firecrawl/firecrawl`,
      `ghcr.io/firecrawl/playwright-service`, `ghcr.io/firecrawl/nuq-postgres`
      + compose project name (`docker-compose.yaml:1,6,66,159`).
- [ ] Domains: `firecrawl.dev`, `api.firecrawl.dev`, dashboard — DNS,
      redirects, SDK default base URLs.
- [ ] CI workflow names/badges, `README.md` (~191 refs), `SELF_HOST.md`
      (~33), `CONTRIBUTING.md`, `apps/ui` branding/logos (~53), `img/`.

## 5. Docs & examples (mechanical, after 1–4)

- [ ] `examples/` sweep (~1418 refs) — scripted find/replace after the SDKs
      republish so snippets stay runnable.
