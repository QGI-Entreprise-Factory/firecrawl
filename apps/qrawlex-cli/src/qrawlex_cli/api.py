"""HTTP client for the Qrawlex (firecrawl) v2 API.

Verified against the API source (apps/api/src/routes/v2.ts and
apps/api/src/controllers/v2/*):

- ``POST /v2/scrape``  body ``{"url": ..., "formats": ["markdown", ...]}``
  -> ``{"success": true, "data": {<Document: markdown, html, links, metadata, ...>}}``
  (v2 accepts formats as plain strings; the server normalizes them to
  ``{"type": ...}`` objects).
- ``POST /v2/crawl``   -> ``{"success": true, "id": "<uuid>", "url": ".../v2/crawl/<id>"}``
- ``GET  /v2/crawl/{id}`` -> ``{"success": true, "status": "scraping|completed|failed|cancelled",
  "completed": n, "total": n, "next": "<url>"?, "data": [Document, ...]}``
- ``POST /v2/map``     -> ``{"success": true, "id": ..., "links": [{"url", "title"?, "description"?}]}``
- ``GET  /``           -> ``{"message": "<brand> API", "documentation_url": ...}``
"""

from __future__ import annotations

import time
from typing import Any, Callable, Optional

import requests

DEFAULT_API_URL = "http://localhost:3002"
REQUEST_TIMEOUT = 120
STATUS_PROBE_TIMEOUT = 5


class APIError(Exception):
    """The Qrawlex API returned an error or was unreachable."""


class QrawlexClient:
    def __init__(self, api_url: str = DEFAULT_API_URL, api_key: str = ""):
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.session = requests.Session()

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        # Self-hosted instances may run without auth; omit the header then.
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _request(self, method: str, path_or_url: str, json_body=None) -> dict[str, Any]:
        url = (
            path_or_url
            if path_or_url.startswith(("http://", "https://"))
            else self.api_url + path_or_url
        )
        try:
            response = self.session.request(
                method,
                url,
                json=json_body,
                headers=self._headers(),
                timeout=REQUEST_TIMEOUT,
            )
        except requests.RequestException as err:
            raise APIError(f"could not reach Qrawlex API at {self.api_url}: {err}")

        try:
            body = response.json()
        except ValueError:
            raise APIError(
                f"{method} {url} returned non-JSON response "
                f"(HTTP {response.status_code}): {response.text[:300]}"
            )

        if response.status_code >= 400 or (
            isinstance(body, dict) and body.get("success") is False
        ):
            detail = body.get("error") if isinstance(body, dict) else body
            raise APIError(f"{method} {url} failed (HTTP {response.status_code}): {detail}")
        return body

    # -- scrape --------------------------------------------------------------

    def scrape(self, url: str, formats: Optional[list[str]] = None) -> dict[str, Any]:
        """POST /v2/scrape -> the Document from the {success, data} envelope."""
        body: dict[str, Any] = {"url": url, "formats": formats or ["markdown"]}
        result = self._request("POST", "/v2/scrape", body)
        data = result.get("data")
        if not isinstance(data, dict):
            raise APIError("scrape response is missing 'data'")
        return data

    # -- crawl ---------------------------------------------------------------

    def start_crawl(
        self,
        url: str,
        limit: Optional[int] = None,
        formats: Optional[list[str]] = None,
    ) -> str:
        """POST /v2/crawl -> crawl id."""
        body: dict[str, Any] = {"url": url}
        if limit is not None:
            body["limit"] = limit
        if formats:
            body["scrapeOptions"] = {"formats": formats}
        result = self._request("POST", "/v2/crawl", body)
        crawl_id = result.get("id")
        if not crawl_id:
            raise APIError("crawl response is missing 'id'")
        return crawl_id

    def crawl_status(self, crawl_id_or_url: str) -> dict[str, Any]:
        """GET /v2/crawl/{id} (or an absolute pagination `next` URL)."""
        if crawl_id_or_url.startswith(("http://", "https://")):
            return self._request("GET", crawl_id_or_url)
        return self._request("GET", f"/v2/crawl/{crawl_id_or_url}")

    def wait_for_crawl(
        self,
        crawl_id: str,
        poll_interval: float = 2.0,
        timeout: float = 300.0,
        progress: Optional[Callable[[str], None]] = None,
    ) -> tuple[str, list[dict[str, Any]]]:
        """Poll until the crawl finishes; returns (status, documents).

        Follows the paginated ``next`` field once the crawl is completed.
        """
        deadline = time.monotonic() + timeout
        while True:
            status_body = self.crawl_status(crawl_id)
            status = status_body.get("status", "scraping")
            if progress:
                progress(
                    f"crawl {crawl_id}: {status} "
                    f"({status_body.get('completed', 0)}/{status_body.get('total', 0)})"
                )
            if status in ("completed", "failed", "cancelled"):
                break
            if time.monotonic() >= deadline:
                raise APIError(
                    f"crawl {crawl_id} did not finish within {timeout:g}s "
                    f"(last status: {status})"
                )
            time.sleep(poll_interval)

        documents = list(status_body.get("data") or [])
        next_url = status_body.get("next")
        while status == "completed" and next_url:
            if progress:
                progress(f"crawl {crawl_id}: fetching next page")
            page = self.crawl_status(next_url)
            page_docs = page.get("data") or []
            if not page_docs:
                break
            documents.extend(page_docs)
            next_url = page.get("next")
        return status, documents

    # -- map -----------------------------------------------------------------

    def map(self, url: str, search: Optional[str] = None) -> list[dict[str, Any]]:
        """POST /v2/map -> list of link objects ({url, title?, description?})."""
        body: dict[str, Any] = {"url": url}
        if search:
            body["search"] = search
        result = self._request("POST", "/v2/map", body)
        links = result.get("links") or []
        # Defensive: tolerate plain-string links.
        return [{"url": l} if isinstance(l, str) else l for l in links]

    # -- status --------------------------------------------------------------

    def probe(self) -> str:
        """GET / — returns the hello message (e.g. "Firecrawl API")."""
        try:
            response = self.session.get(
                self.api_url + "/", timeout=STATUS_PROBE_TIMEOUT
            )
            body = response.json()
            return str(body.get("message", f"HTTP {response.status_code}"))
        except (requests.RequestException, ValueError) as err:
            raise APIError(str(err))


def probe_health(service_url: str) -> str:
    """GET {service_url}/health for the PDF / omni-convert services."""
    try:
        response = requests.get(
            service_url.rstrip("/") + "/health", timeout=STATUS_PROBE_TIMEOUT
        )
    except requests.RequestException as err:
        raise APIError(str(err))
    if response.status_code != 200:
        raise APIError(f"HTTP {response.status_code}")
    try:
        body = response.json()
        return str(body.get("status", "ok"))
    except ValueError:
        return "ok"
