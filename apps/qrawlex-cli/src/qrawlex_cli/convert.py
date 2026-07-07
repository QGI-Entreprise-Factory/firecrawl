"""Local + service conversion engines for `qrawlex convert`.

Routing:

- ``.pdf`` files use the PDF engine (structure-aware):
    * service: ``POST {QRAWLEX_PDF_SERVICE_URL}/v1/convert`` (multipart ``file``)
      -> ``{markdown, json, processing_time_ms}``
    * local: the ``opendataloader_pdf`` Python package (spawns the bundled
      Java CLI; requires a JRE).
- everything else uses the omni engine (long-tail converter):
    * service: ``POST {QRAWLEX_CONVERT_SERVICE_URL}/v1/convert`` (raw bytes)
      -> ``{markdown, title, converter_used}``
    * local: the ``markitdown`` Python package.

``--via auto`` (the default) prefers the service when its URL env var is set,
otherwise falls back to the local library.
"""

from __future__ import annotations

import json
import mimetypes
import os
import tempfile
from pathlib import Path
from typing import Any, Optional

import requests

# Timeout (seconds) for conversion service calls. Conversions of big files can
# legitimately take a while; connection establishment fails fast regardless.
SERVICE_TIMEOUT = 300

PDF_ENGINE_HINT = (
    "No PDF conversion engine is available. Either:\n"
    '  - install local support:  pip install "qrawlex[local]"  '
    "(needs a Java runtime for opendataloader-pdf), or\n"
    "  - set QRAWLEX_PDF_SERVICE_URL to a running Qrawlex PDF service."
)

OMNI_ENGINE_HINT = (
    "No document conversion engine is available. Either:\n"
    '  - install local support:  pip install "qrawlex[local]"  (markitdown), or\n'
    "  - set QRAWLEX_CONVERT_SERVICE_URL to a running Qrawlex omni-convert service."
)


class ConversionError(Exception):
    """A file failed to convert."""


class EngineUnavailableError(ConversionError):
    """No engine (service or local library) is available for this file type."""


# Cached MarkItDown instance (building one loads the magika model; reuse it
# across files). Tests reset this via monkeypatch.
_markitdown_instance = None


def _get_markitdown():
    global _markitdown_instance
    if _markitdown_instance is None:
        from markitdown import MarkItDown  # may raise ImportError

        _markitdown_instance = MarkItDown()
    return _markitdown_instance


def _service_error_detail(response: requests.Response) -> str:
    try:
        body = response.json()
        if isinstance(body, dict):
            return str(body.get("detail") or body.get("error") or body)
    except ValueError:
        pass
    return response.text[:500] or f"HTTP {response.status_code}"


# ---------------------------------------------------------------------------
# PDF engine (opendataloader-pdf)
# ---------------------------------------------------------------------------


def _convert_pdf_service(
    path: Path, service_url: str, want_json: bool
) -> dict[str, Any]:
    url = service_url.rstrip("/") + "/v1/convert"
    headers = {}
    api_key = os.environ.get("QRAWLEX_PDF_API_KEY")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    with open(path, "rb") as fh:
        try:
            response = requests.post(
                url,
                files={"file": (path.name, fh, "application/pdf")},
                data={"include_json": "true" if want_json else "false"},
                headers=headers,
                timeout=SERVICE_TIMEOUT,
            )
        except requests.RequestException as err:
            raise ConversionError(f"PDF service at {service_url} unreachable: {err}")

    if response.status_code != 200:
        raise ConversionError(
            f"PDF service returned {response.status_code}: "
            f"{_service_error_detail(response)}"
        )

    try:
        body = response.json()
    except ValueError:
        raise ConversionError("PDF service returned a non-JSON response")
    if "markdown" not in body:
        raise ConversionError("PDF service response is missing 'markdown'")
    return {"markdown": body["markdown"], "json": body.get("json")}


def _find_output(output_dir: Path, stem: str, ext: str) -> Optional[Path]:
    """Find a produced output file, tolerating stem normalization."""
    candidate = output_dir / f"{stem}{ext}"
    if candidate.is_file():
        return candidate
    matching = sorted(
        f for f in output_dir.iterdir() if f.is_file() and f.suffix == ext
    )
    return matching[0] if matching else None


def _convert_pdf_local(path: Path, want_json: bool) -> dict[str, Any]:
    try:
        import opendataloader_pdf
    except ImportError:
        raise EngineUnavailableError(PDF_ENGINE_HINT)

    formats = ["markdown"] + (["json"] if want_json else [])
    with tempfile.TemporaryDirectory(prefix="qrawlex-convert-") as tmp:
        output_dir = Path(tmp)
        try:
            opendataloader_pdf.convert(
                input_path=str(path),
                output_dir=str(output_dir),
                format=formats,
                quiet=True,
                image_output="embedded",
            )
        except FileNotFoundError as err:
            # The wrapper shells out to `java`.
            raise ConversionError(
                f"opendataloader-pdf could not run (is Java installed?): {err}"
            )
        except Exception as err:  # noqa: BLE001 - map converter errors
            raise ConversionError(f"opendataloader-pdf conversion failed: {err}")

        markdown_file = _find_output(output_dir, path.stem, ".md")
        if markdown_file is None:
            raise ConversionError(
                "opendataloader-pdf produced no markdown output for " + path.name
            )
        result: dict[str, Any] = {
            "markdown": markdown_file.read_text(encoding="utf-8"),
            "json": None,
        }
        if want_json:
            json_file = _find_output(output_dir, path.stem, ".json")
            if json_file is None:
                raise ConversionError(
                    "opendataloader-pdf produced no JSON output for " + path.name
                )
            try:
                result["json"] = json.loads(json_file.read_text(encoding="utf-8"))
            except json.JSONDecodeError as err:
                raise ConversionError(f"opendataloader-pdf produced invalid JSON: {err}")
        return result


def convert_pdf(path: Path, via: str = "auto", want_json: bool = False) -> dict[str, Any]:
    """Convert a PDF. Returns ``{"markdown": str, "json": dict | None}``."""
    service_url = os.environ.get("QRAWLEX_PDF_SERVICE_URL")

    if via == "service":
        if not service_url:
            raise EngineUnavailableError(
                "--via service requires QRAWLEX_PDF_SERVICE_URL to be set"
            )
        return _convert_pdf_service(path, service_url, want_json)
    if via == "local":
        return _convert_pdf_local(path, want_json)
    # auto
    if service_url:
        return _convert_pdf_service(path, service_url, want_json)
    return _convert_pdf_local(path, want_json)


# ---------------------------------------------------------------------------
# Omni engine (markitdown)
# ---------------------------------------------------------------------------


def _convert_other_service(path: Path, service_url: str) -> dict[str, Any]:
    url = service_url.rstrip("/") + "/v1/convert"
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    headers = {"Content-Type": content_type, "X-Filename": path.name}
    api_key = os.environ.get("QRAWLEX_CONVERT_API_KEY")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        response = requests.post(
            url,
            data=path.read_bytes(),
            headers=headers,
            timeout=SERVICE_TIMEOUT,
        )
    except requests.RequestException as err:
        raise ConversionError(f"convert service at {service_url} unreachable: {err}")

    if response.status_code != 200:
        raise ConversionError(
            f"convert service returned {response.status_code}: "
            f"{_service_error_detail(response)}"
        )

    try:
        body = response.json()
    except ValueError:
        raise ConversionError("convert service returned a non-JSON response")
    if "markdown" not in body:
        raise ConversionError("convert service response is missing 'markdown'")
    return {
        "markdown": body["markdown"],
        "title": body.get("title"),
        "converter_used": body.get("converter_used"),
    }


def _convert_other_local(path: Path) -> dict[str, Any]:
    try:
        from markitdown import StreamInfo

        md = _get_markitdown()
    except ImportError:
        raise EngineUnavailableError(OMNI_ENGINE_HINT)

    stream_info = StreamInfo(
        extension=path.suffix.lower() or None,
        filename=path.name,
    )
    try:
        with open(path, "rb") as fh:
            result = md.convert_stream(fh, stream_info=stream_info)
    except Exception as err:  # noqa: BLE001 - markitdown raises many types
        raise ConversionError(f"markitdown conversion failed: {err}")
    return {
        "markdown": result.markdown,
        "title": result.title,
        "converter_used": "markitdown",
    }


def convert_other(path: Path, via: str = "auto") -> dict[str, Any]:
    """Convert a non-PDF file. Returns ``{"markdown", "title", "converter_used"}``."""
    service_url = os.environ.get("QRAWLEX_CONVERT_SERVICE_URL")

    if via == "service":
        if not service_url:
            raise EngineUnavailableError(
                "--via service requires QRAWLEX_CONVERT_SERVICE_URL to be set"
            )
        return _convert_other_service(path, service_url)
    if via == "local":
        return _convert_other_local(path)
    # auto
    if service_url:
        return _convert_other_service(path, service_url)
    return _convert_other_local(path)


def local_markitdown_available() -> bool:
    try:
        import markitdown  # noqa: F401

        return True
    except ImportError:
        return False


def local_opendataloader_available() -> bool:
    try:
        import opendataloader_pdf  # noqa: F401

        return True
    except ImportError:
        return False
