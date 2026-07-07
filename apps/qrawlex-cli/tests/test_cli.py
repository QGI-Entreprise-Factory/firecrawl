"""End-to-end tests for the qrawlex CLI against a stdlib stub HTTP server.

No network access is required: every HTTP interaction is served by a local
``http.server`` instance, and the CLI is invoked in-process via
``qrawlex_cli.cli.main()``.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import qrawlex_cli.convert as convert_mod
from qrawlex_cli.cli import main

MARKITDOWN_AVAILABLE = importlib.util.find_spec("markitdown") is not None

ENV_VARS = [
    "QRAWLEX_API_URL",
    "QRAWLEX_API_KEY",
    "FIRECRAWL_API_URL",
    "FIRECRAWL_API_KEY",
    "QRAWLEX_PDF_SERVICE_URL",
    "QRAWLEX_PDF_API_KEY",
    "QRAWLEX_CONVERT_SERVICE_URL",
    "QRAWLEX_CONVERT_API_KEY",
]


# ---------------------------------------------------------------------------
# stub HTTP server
# ---------------------------------------------------------------------------


class StubHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence request logging
        pass

    def _respond(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        path = self.path.split("?")[0]
        self.server.requests.append(
            {
                "method": self.command,
                "path": path,
                "headers": dict(self.headers),
                "body": body,
            }
        )

        route = self.server.routes.get((self.command, path))
        if route is None:
            status, payload = 404, {"success": False, "error": "not found"}
        elif isinstance(route, list):
            # Sequenced responses (e.g. crawl polling); last one repeats.
            status, payload = route.pop(0) if len(route) > 1 else route[0]
        elif callable(route):
            status, payload = route(self, body)
        else:
            status, payload = route

        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = _respond
    do_POST = _respond


class Stub:
    def __init__(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
        self.server.routes = {}
        self.server.requests = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    @property
    def routes(self):
        return self.server.routes

    @property
    def requests(self):
        return self.server.requests

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def stub():
    s = Stub()
    yield s
    s.close()


@pytest.fixture
def clean_env(monkeypatch):
    for var in ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    return monkeypatch


# ---------------------------------------------------------------------------
# convert: services
# ---------------------------------------------------------------------------


def test_convert_via_omni_service(stub, clean_env, tmp_path):
    stub.routes[("POST", "/v1/convert")] = (
        200,
        {"markdown": "# Converted", "title": "Doc", "converter_used": "stub"},
    )
    clean_env.setenv("QRAWLEX_CONVERT_SERVICE_URL", stub.url)
    clean_env.setenv("QRAWLEX_CONVERT_API_KEY", "omni-secret")

    source = tmp_path / "notes.txt"
    source.write_bytes(b"hello world")
    out_dir = tmp_path / "out"

    rc = main(["convert", str(source), "--out-dir", str(out_dir)])

    assert rc == 0
    assert (out_dir / "notes.md").read_text() == "# Converted"

    request = stub.requests[0]
    assert request["method"] == "POST"
    assert request["path"] == "/v1/convert"
    assert request["body"] == b"hello world"
    assert request["headers"]["X-Filename"] == "notes.txt"
    assert request["headers"]["Content-Type"] == "text/plain"
    assert request["headers"]["Authorization"] == "Bearer omni-secret"


def test_convert_pdf_via_service(stub, clean_env, tmp_path, capsys):
    stub.routes[("POST", "/v1/convert")] = (
        200,
        {
            "markdown": "# PDF markdown",
            "json": {"type": "document", "kids": []},
            "processing_time_ms": 12.5,
        },
    )
    clean_env.setenv("QRAWLEX_PDF_SERVICE_URL", stub.url)

    source = tmp_path / "report.pdf"
    source.write_bytes(b"%PDF-1.7 fake")

    # single file, no -o -> markdown to stdout
    rc = main(["convert", str(source)])
    assert rc == 0
    assert capsys.readouterr().out.strip() == "# PDF markdown"

    request = stub.requests[0]
    assert request["method"] == "POST"
    assert request["path"] == "/v1/convert"
    assert request["headers"]["Content-Type"].startswith("multipart/form-data")
    assert b"%PDF-1.7 fake" in request["body"]
    assert b'filename="report.pdf"' in request["body"]

    # --format json writes both .md and .json into --out-dir
    out_dir = tmp_path / "out"
    rc = main(["convert", str(source), "--format", "json", "--out-dir", str(out_dir)])
    assert rc == 0
    assert (out_dir / "report.md").read_text() == "# PDF markdown"
    assert json.loads((out_dir / "report.json").read_text()) == {
        "type": "document",
        "kids": [],
    }


def test_convert_format_json_rejected_for_non_pdf(clean_env, tmp_path, capsys):
    source = tmp_path / "notes.txt"
    source.write_text("hi")
    rc = main(["convert", str(source), "--format", "json"])
    assert rc == 2
    assert "only supported for PDFs" in capsys.readouterr().err


def test_convert_no_engines_available(clean_env, monkeypatch, tmp_path, capsys):
    # Block local imports (setting sys.modules[name] = None makes `import name`
    # raise ImportError) and leave service URLs unset.
    monkeypatch.setitem(sys.modules, "markitdown", None)
    monkeypatch.setitem(sys.modules, "opendataloader_pdf", None)
    monkeypatch.setattr(convert_mod, "_markitdown_instance", None)

    doc = tmp_path / "deck.pptx"
    doc.write_bytes(b"fake")
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF- fake")

    rc = main(["convert", str(doc), str(pdf), "--out-dir", str(tmp_path / "out")])
    err = capsys.readouterr().err

    assert rc == 1
    assert 'pip install "qrawlex[local]"' in err
    assert "QRAWLEX_CONVERT_SERVICE_URL" in err
    assert "QRAWLEX_PDF_SERVICE_URL" in err


def test_convert_multi_file_continues_on_error(stub, clean_env, tmp_path, capsys):
    def route(handler, body):
        if handler.headers.get("X-Filename") == "bad.txt":
            return 500, {"detail": "converter exploded"}
        return 200, {"markdown": "ok md", "title": None, "converter_used": "stub"}

    stub.routes[("POST", "/v1/convert")] = route
    clean_env.setenv("QRAWLEX_CONVERT_SERVICE_URL", stub.url)

    good = tmp_path / "good.txt"
    good.write_text("good")
    bad = tmp_path / "bad.txt"
    bad.write_text("bad")
    out_dir = tmp_path / "out"

    rc = main(["convert", str(bad), str(good), "--out-dir", str(out_dir)])
    err = capsys.readouterr().err

    assert rc == 1  # one failure -> exit 1
    assert (out_dir / "good.md").read_text() == "ok md"  # but the rest converted
    assert not (out_dir / "bad.md").exists()
    assert "converter exploded" in err


# ---------------------------------------------------------------------------
# convert: local markitdown (only when installed)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not MARKITDOWN_AVAILABLE, reason="markitdown not installed")
def test_convert_local_markitdown_csv(clean_env, tmp_path, capsys):
    source = tmp_path / "table.csv"
    source.write_text("name,age\nalice,30\nbob,25\n")

    rc = main(["convert", str(source)])
    out = capsys.readouterr().out

    assert rc == 0
    assert "| name | age |" in out
    assert "| alice | 30 |" in out


# ---------------------------------------------------------------------------
# scrape
# ---------------------------------------------------------------------------


def test_scrape_happy_path(stub, clean_env, capsys):
    # Envelope exactly as apps/api/src/controllers/v2/scrape.ts returns it.
    stub.routes[("POST", "/v2/scrape")] = (
        200,
        {
            "success": True,
            "data": {
                "markdown": "# Example Domain\n\nSome text.",
                "metadata": {
                    "sourceURL": "https://example.com",
                    "statusCode": 200,
                    "title": "Example Domain",
                },
            },
        },
    )

    rc = main(
        [
            "scrape",
            "https://example.com",
            "--api-url",
            stub.url,
            "--api-key",
            "test-key",
        ]
    )

    assert rc == 0
    assert capsys.readouterr().out.strip() == "# Example Domain\n\nSome text."

    request = stub.requests[0]
    assert request["path"] == "/v2/scrape"
    assert request["headers"]["Authorization"] == "Bearer test-key"
    assert json.loads(request["body"]) == {
        "url": "https://example.com",
        "formats": ["markdown"],
    }


def test_scrape_api_error(stub, clean_env, capsys):
    stub.routes[("POST", "/v2/scrape")] = (
        408,
        {"success": False, "code": "SCRAPE_TIMEOUT", "error": "Scrape timed out"},
    )
    rc = main(["scrape", "https://example.com", "--api-url", stub.url])
    assert rc == 1
    assert "Scrape timed out" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# crawl
# ---------------------------------------------------------------------------


def test_crawl_happy_path(stub, clean_env, tmp_path, capsys):
    crawl_id = "0198c0de-1111-2222-3333-444455556666"
    stub.routes[("POST", "/v2/crawl")] = (
        200,
        {"success": True, "id": crawl_id, "url": f"{stub.url}/v2/crawl/{crawl_id}"},
    )
    stub.routes[("GET", f"/v2/crawl/{crawl_id}")] = [
        (
            200,
            {
                "success": True,
                "status": "scraping",
                "completed": 0,
                "total": 1,
                "data": [],
            },
        ),
        (
            200,
            {
                "success": True,
                "status": "completed",
                "completed": 1,
                "total": 1,
                "data": [
                    {
                        "markdown": "# Page one",
                        "metadata": {
                            "sourceURL": "https://example.com/docs/page-one",
                            "url": "https://example.com/docs/page-one",
                            "statusCode": 200,
                        },
                    }
                ],
            },
        ),
    ]

    out_dir = tmp_path / "crawl-out"
    rc = main(
        [
            "crawl",
            "https://example.com",
            "--limit",
            "1",
            "--api-url",
            stub.url,
            "--out-dir",
            str(out_dir),
            "--poll-interval",
            "0.01",
            "--timeout",
            "10",
        ]
    )
    err = capsys.readouterr().err

    assert rc == 0
    files = list(out_dir.glob("*.md"))
    assert len(files) == 1
    assert files[0].read_text() == "# Page one"
    assert "example.com" in files[0].name

    start_request = stub.requests[0]
    assert start_request["path"] == "/v2/crawl"
    assert json.loads(start_request["body"]) == {
        "url": "https://example.com",
        "limit": 1,
    }
    poll_paths = [r["path"] for r in stub.requests[1:]]
    assert poll_paths == [f"/v2/crawl/{crawl_id}"] * 2
    assert "completed" in err


def test_crawl_failed_status(stub, clean_env, tmp_path, capsys):
    crawl_id = "dead-beef"
    stub.routes[("POST", "/v2/crawl")] = (200, {"success": True, "id": crawl_id})
    stub.routes[("GET", f"/v2/crawl/{crawl_id}")] = (
        200,
        {
            "success": True,
            "status": "failed",
            "completed": 0,
            "total": 0,
            "error": "boom",
            "data": [],
        },
    )
    rc = main(
        [
            "crawl",
            "https://example.com",
            "--api-url",
            stub.url,
            "--out-dir",
            str(tmp_path / "o"),
            "--poll-interval",
            "0.01",
        ]
    )
    assert rc == 1
    assert "failed" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# map
# ---------------------------------------------------------------------------


def test_map(stub, clean_env, capsys):
    stub.routes[("POST", "/v2/map")] = (
        200,
        {
            "success": True,
            "id": "map-job-1",
            "links": [
                {"url": "https://example.com/", "title": "Home"},
                {"url": "https://example.com/about", "description": "About us"},
            ],
        },
    )
    rc = main(
        ["map", "https://example.com", "--search", "about", "--api-url", stub.url]
    )
    out = capsys.readouterr().out

    assert rc == 0
    assert out.splitlines() == ["https://example.com/", "https://example.com/about"]
    assert json.loads(stub.requests[0]["body"]) == {
        "url": "https://example.com",
        "search": "about",
    }


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def test_status_nothing_configured(clean_env, capsys):
    # Point the API at a closed port; services unset. Must never crash.
    rc = main(["status", "--api-url", "http://127.0.0.1:9"])
    out = capsys.readouterr().out

    assert rc == 0
    assert "API http://127.0.0.1:9: unreachable" in out
    assert "PDF service: not configured (set QRAWLEX_PDF_SERVICE_URL)" in out
    assert (
        "omni-convert service: not configured (set QRAWLEX_CONVERT_SERVICE_URL)" in out
    )
    assert "local markitdown:" in out
    assert "local opendataloader-pdf:" in out


def test_status_with_services(stub, clean_env, capsys):
    stub.routes[("GET", "/")] = (
        200,
        {"message": "Firecrawl API", "documentation_url": "https://docs"},
    )
    stub.routes[("GET", "/health")] = (200, {"status": "ok", "java": True})
    clean_env.setenv("QRAWLEX_PDF_SERVICE_URL", stub.url)

    rc = main(["status", "--api-url", stub.url])
    out = capsys.readouterr().out

    assert rc == 0
    assert f"API {stub.url}: ok (Firecrawl API)" in out
    assert f"PDF service {stub.url}: ok" in out
