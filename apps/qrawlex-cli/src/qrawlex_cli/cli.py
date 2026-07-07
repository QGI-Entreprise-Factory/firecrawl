"""argparse wiring + main() for the `qrawlex` CLI."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from . import __version__
from .api import DEFAULT_API_URL, APIError, QrawlexClient, probe_health
from .convert import (
    ConversionError,
    convert_other,
    convert_pdf,
    local_markitdown_available,
    local_opendataloader_available,
)

CONFIG_EPILOG = """\
configuration:
  api_url   --api-url  >  QRAWLEX_API_URL  >  FIRECRAWL_API_URL  >  http://localhost:3002
  api_key   --api-key  >  QRAWLEX_API_KEY  >  FIRECRAWL_API_KEY  >  (none; header omitted)

  QRAWLEX_PDF_SERVICE_URL / QRAWLEX_PDF_API_KEY          PDF conversion service
  QRAWLEX_CONVERT_SERVICE_URL / QRAWLEX_CONVERT_API_KEY  omni-convert (markitdown) service

  `qrawlex convert` works fully locally with no services:
      pip install "qrawlex[local]"
"""


def eprint(*args) -> None:
    print(*args, file=sys.stderr)


def resolve_api_url(args: argparse.Namespace) -> str:
    return (
        getattr(args, "api_url", None)
        or os.environ.get("QRAWLEX_API_URL")
        or os.environ.get("FIRECRAWL_API_URL")
        or DEFAULT_API_URL
    )


def resolve_api_key(args: argparse.Namespace) -> str:
    return (
        getattr(args, "api_key", None)
        or os.environ.get("QRAWLEX_API_KEY")
        or os.environ.get("FIRECRAWL_API_KEY")
        or ""
    )


def make_client(args: argparse.Namespace) -> QrawlexClient:
    return QrawlexClient(api_url=resolve_api_url(args), api_key=resolve_api_key(args))


def add_api_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--api-url",
        help="Qrawlex API base URL (default: $QRAWLEX_API_URL, $FIRECRAWL_API_URL, "
        "then http://localhost:3002)",
    )
    parser.add_argument(
        "--api-key",
        help="Qrawlex API key (default: $QRAWLEX_API_KEY, then $FIRECRAWL_API_KEY)",
    )


def parse_formats(raw: str) -> list[str]:
    formats = [f.strip() for f in raw.split(",") if f.strip()]
    if not formats:
        raise argparse.ArgumentTypeError("at least one format is required")
    return formats


def write_or_print(content: str, output: Optional[str]) -> None:
    if output:
        Path(output).write_text(content, encoding="utf-8")
    else:
        print(content)


# ---------------------------------------------------------------------------
# convert
# ---------------------------------------------------------------------------


def cmd_convert(args: argparse.Namespace) -> int:
    files = [Path(f) for f in args.files]

    if args.format == "json":
        non_pdf = [f for f in files if f.suffix.lower() != ".pdf"]
        if non_pdf:
            eprint(
                "error: --format json is only supported for PDFs "
                "(opendataloader structured JSON); got: "
                + ", ".join(str(f) for f in non_pdf)
            )
            return 2

    if args.output and (len(files) > 1 or args.out_dir):
        eprint("error: -o/--output only works with a single input file; use --out-dir")
        return 2

    to_dir = len(files) > 1 or args.out_dir is not None
    out_dir = Path(args.out_dir or ".")
    if to_dir:
        out_dir.mkdir(parents=True, exist_ok=True)

    failures = 0
    for path in files:
        try:
            if not path.is_file():
                raise ConversionError("no such file")
            if path.suffix.lower() == ".pdf":
                result = convert_pdf(
                    path, via=args.via, want_json=(args.format == "json")
                )
            else:
                result = convert_other(path, via=args.via)
        except ConversionError as err:
            eprint(f"error: {path}: {err}")
            failures += 1
            continue

        markdown = result.get("markdown") or ""
        if not to_dir:
            content = (
                json.dumps(result.get("json"), indent=2, ensure_ascii=False)
                if args.format == "json"
                else markdown
            )
            write_or_print(content, args.output)
            if args.output:
                eprint(f"{path} -> {args.output}")
        else:
            md_path = out_dir / (path.stem + ".md")
            md_path.write_text(markdown, encoding="utf-8")
            written = [str(md_path)]
            if args.format == "json":
                json_path = out_dir / (path.stem + ".json")
                json_path.write_text(
                    json.dumps(result.get("json"), indent=2, ensure_ascii=False),
                    encoding="utf-8",
                )
                written.append(str(json_path))
            eprint(f"{path} -> {', '.join(written)}")

    return 1 if failures else 0


# ---------------------------------------------------------------------------
# scrape
# ---------------------------------------------------------------------------


def cmd_scrape(args: argparse.Namespace) -> int:
    client = make_client(args)
    try:
        document = client.scrape(args.url, formats=args.formats)
    except APIError as err:
        eprint(f"error: {err}")
        return 1

    if args.json:
        content = json.dumps(document, indent=2, ensure_ascii=False)
    else:
        markdown = document.get("markdown")
        content = (
            markdown
            if markdown is not None
            else json.dumps(document, indent=2, ensure_ascii=False)
        )
    write_or_print(content, args.output)
    return 0


# ---------------------------------------------------------------------------
# crawl
# ---------------------------------------------------------------------------


def sanitize_url_to_filename(url: str, used: set[str]) -> str:
    parsed = urlparse(url)
    base = (parsed.netloc + parsed.path).rstrip("/")
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", base).strip("-.") or "document"
    slug = slug[:150]
    name = slug
    counter = 2
    while name in used:
        name = f"{slug}-{counter}"
        counter += 1
    used.add(name)
    return name + ".md"


def cmd_crawl(args: argparse.Namespace) -> int:
    client = make_client(args)
    try:
        crawl_id = client.start_crawl(args.url, limit=args.limit, formats=args.formats)
        eprint(f"crawl started: {crawl_id}")
        status, documents = client.wait_for_crawl(
            crawl_id,
            poll_interval=args.poll_interval,
            timeout=args.timeout,
            progress=eprint,
        )
    except APIError as err:
        eprint(f"error: {err}")
        return 1

    if status != "completed":
        eprint(f"error: crawl finished with status '{status}'")
        return 1

    out_dir = Path(args.out_dir or f"./crawl-{crawl_id}")
    out_dir.mkdir(parents=True, exist_ok=True)

    used: set[str] = set()
    written = 0
    for doc in documents:
        metadata = doc.get("metadata") or {}
        source_url = (
            metadata.get("sourceURL") or metadata.get("url") or f"page-{written + 1}"
        )
        markdown = doc.get("markdown")
        if markdown is None:
            eprint(f"skipping {source_url} (no markdown in document)")
            continue
        file_path = out_dir / sanitize_url_to_filename(source_url, used)
        file_path.write_text(markdown, encoding="utf-8")
        eprint(f"{source_url} -> {file_path}")
        written += 1

    eprint(f"crawl {crawl_id} completed: {written} document(s) written to {out_dir}")
    return 0


# ---------------------------------------------------------------------------
# map
# ---------------------------------------------------------------------------


def cmd_map(args: argparse.Namespace) -> int:
    client = make_client(args)
    try:
        links = client.map(args.url, search=args.search)
    except APIError as err:
        eprint(f"error: {err}")
        return 1
    for link in links:
        url = link.get("url")
        if url:
            print(url)
    return 0


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def cmd_status(args: argparse.Namespace) -> int:
    api_url = resolve_api_url(args)
    client = make_client(args)
    try:
        message = client.probe()
        print(f"API {api_url}: ok ({message})")
    except APIError as err:
        print(f"API {api_url}: unreachable ({err})")

    for label, env_var in (
        ("PDF service", "QRAWLEX_PDF_SERVICE_URL"),
        ("omni-convert service", "QRAWLEX_CONVERT_SERVICE_URL"),
    ):
        service_url = os.environ.get(env_var)
        if not service_url:
            print(f"{label}: not configured (set {env_var})")
            continue
        try:
            health = probe_health(service_url)
            print(f"{label} {service_url}: {health}")
        except APIError as err:
            print(f"{label} {service_url}: unreachable ({err})")

    print(
        "local markitdown: "
        + ("available" if local_markitdown_available() else 'not installed (pip install "qrawlex[local]")')
    )
    print(
        "local opendataloader-pdf: "
        + ("available" if local_opendataloader_available() else 'not installed (pip install "qrawlex[local]")')
    )
    return 0


# ---------------------------------------------------------------------------
# parser
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="qrawlex",
        description="Qrawlex: scrape, crawl, map, and convert anything to AI-ready markdown.",
        epilog=CONFIG_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--version", action="version", version=f"qrawlex {__version__}"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # convert
    p_convert = subparsers.add_parser(
        "convert",
        help="convert local files to AI-ready markdown (PDF: opendataloader; other: markitdown)",
        epilog=CONFIG_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_convert.add_argument("files", nargs="+", help="file(s) to convert")
    p_convert.add_argument("-o", "--output", help="output file (single input only)")
    p_convert.add_argument(
        "--out-dir", help="write <stem>.md (and <stem>.json) files into this directory"
    )
    p_convert.add_argument(
        "--format",
        choices=["markdown", "json"],
        default="markdown",
        help="output format; json is PDF-only (opendataloader structured JSON)",
    )
    p_convert.add_argument(
        "--via",
        choices=["auto", "local", "service"],
        default="auto",
        help="engine selection: auto (service if configured, else local), local, or service",
    )
    p_convert.set_defaults(func=cmd_convert)

    # scrape
    p_scrape = subparsers.add_parser(
        "scrape", help="scrape a URL via the Qrawlex API (POST /v2/scrape)"
    )
    p_scrape.add_argument("url")
    p_scrape.add_argument(
        "--formats",
        type=parse_formats,
        default=["markdown"],
        help="comma-separated formats (markdown,html,rawHtml,links,images,summary,screenshot,...)",
    )
    p_scrape.add_argument("-o", "--output", help="write output to this file")
    p_scrape.add_argument(
        "--json", action="store_true", help="print the full document JSON"
    )
    add_api_options(p_scrape)
    p_scrape.set_defaults(func=cmd_scrape)

    # crawl
    p_crawl = subparsers.add_parser(
        "crawl", help="crawl a site and save each page's markdown (POST /v2/crawl + poll)"
    )
    p_crawl.add_argument("url")
    p_crawl.add_argument("--limit", type=int, help="max pages to crawl")
    p_crawl.add_argument(
        "--formats",
        type=parse_formats,
        default=None,
        help="comma-separated scrape formats for each page (default: markdown)",
    )
    p_crawl.add_argument(
        "--out-dir", help="directory for output files (default: ./crawl-<id>/)"
    )
    p_crawl.add_argument(
        "--poll-interval", type=float, default=2.0, help="seconds between polls (default 2)"
    )
    p_crawl.add_argument(
        "--timeout", type=float, default=300.0, help="max seconds to wait (default 300)"
    )
    add_api_options(p_crawl)
    p_crawl.set_defaults(func=cmd_crawl)

    # map
    p_map = subparsers.add_parser(
        "map", help="discover a site's URLs (POST /v2/map), one per line"
    )
    p_map.add_argument("url")
    p_map.add_argument("--search", help="filter/rank discovered URLs by this query")
    add_api_options(p_map)
    p_map.set_defaults(func=cmd_map)

    # status
    p_status = subparsers.add_parser(
        "status", help="check API, converter services, and local engine availability"
    )
    add_api_options(p_status)
    p_status.set_defaults(func=cmd_status)

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        eprint("interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
