"""
DataFinder OpenAPI module — manifest-driven client.

This is the single, complete module for calling 火山引擎 DataFinder OpenAPI.
Everything callable is declared in `manifest.json`; this client reads that
manifest and exposes:

  Discovery (so the agent can see the full interface surface):
    - list_endpoints()        → ids + summaries of every declared endpoint
    - describe(endpoint_id)    → full interface definition for one endpoint
    - doc_url(endpoint_id)     → official documentation link

  Invocation:
    - call(endpoint_id, params)        → generic, manifest-validated request
    - typed wrappers (fetch_dashboard_list, query_report, …) for the common ones

When an endpoint is NOT in the manifest, call() raises EndpointNotFound with
the documentation root and a pointer to UPDATE.md, so the agent can look up the
latest interface from the official docs and extend the manifest.

API path reference root: https://www.volcengine.com/docs/84129
Signing spec:            https://www.volcengine.com/docs/84129/1261794?lang=zh
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote, urlencode

import requests

MANIFEST_PATH = Path(__file__).parent / "manifest.json"


# ── Config & result types ──────────────────────────────────────────────────────

@dataclass
class DataFinderConfig:
    """
    Runtime configuration for DataFinder OpenAPI.
    Credentials are never stored in skill files; pass them at call time
    (load from .env.local).

    base_url:
      SaaS cloud-native / domestic non-cloud-native → https://analytics.volcengineapi.com
      BytePlus overseas                              → https://analytics.byteplusapi.com
      Private deployment                             → private Finder domain
    """
    base_url: str
    access_key: str
    secret_key: str
    app_id: int
    region: str = "cn-north-1"
    service: str = "datafinder"
    timeout_seconds: int = 30


@dataclass
class APIResult:
    """Normalised result from any DataFinder OpenAPI call."""
    status: str                          # "success" | "error"
    data: Any = None
    error_code: Optional[str] = None     # see references/.../execution-result-protocol.md
    error_message: Optional[str] = None
    http_status: Optional[int] = None
    endpoint_id: Optional[str] = None
    warnings: list[str] = field(default_factory=list)


class EndpointNotFound(Exception):
    """Raised when an endpoint id is not declared in manifest.json."""


# ── Manifest loading ───────────────────────────────────────────────────────────

def load_manifest() -> dict:
    """Load the complete DataFinder interface manifest."""
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


# ── Client ─────────────────────────────────────────────────────────────────────

class DataFinderClient:

    def __init__(self, config: DataFinderConfig, manifest: Optional[dict] = None) -> None:
        self.config = config
        self.manifest = manifest or load_manifest()
        self._by_id = {ep["id"]: ep for ep in self.manifest.get("endpoints", [])}
        self._session = requests.Session()
        self._session.headers["Content-Type"] = "application/json"

    # ── Discovery interface ────────────────────────────────────────────────

    def list_endpoints(self) -> list[dict[str, str]]:
        """Return [{id, summary, doc_url, path_verified}] for every endpoint."""
        return [
            {
                "id": ep["id"],
                "summary": ep.get("summary", ""),
                "doc_url": ep.get("doc_url", ""),
                "path_verified": ep.get("path_verified", False),
            }
            for ep in self.manifest.get("endpoints", [])
        ]

    def describe(self, endpoint_id: str) -> dict:
        """Return the full manifest entry for one endpoint, or raise."""
        ep = self._by_id.get(endpoint_id)
        if ep is None:
            raise self._not_found(endpoint_id)
        return ep

    def doc_url(self, endpoint_id: str) -> str:
        """Return the official documentation URL for one endpoint."""
        return self.describe(endpoint_id).get("doc_url", self._doc_root())

    def _doc_root(self) -> str:
        return self.manifest.get("global", {}).get(
            "doc_root", "https://www.volcengine.com/docs/84129"
        )

    def _not_found(self, endpoint_id: str) -> EndpointNotFound:
        known = ", ".join(sorted(self._by_id)) or "(none)"
        return EndpointNotFound(
            f"Endpoint '{endpoint_id}' is not declared in manifest.json.\n"
            f"Known endpoints: {known}\n"
            f"To add it: look up the latest interface in the official docs "
            f"({self._doc_root()}) and follow domains/datafinder-interface/UPDATE.md to "
            f"register the endpoint, then retry."
        )

    # ── Generic invocation ─────────────────────────────────────────────────

    def call(self, endpoint_id: str, params: Optional[dict] = None) -> APIResult:
        """
        Manifest-driven request. Looks up endpoint_id, validates required
        params, injects app_id default, signs, and POSTs.

        Unknown endpoint_id → EndpointNotFound (caught and returned as an
        APIResult with error_code='endpoint_not_in_manifest' for callers that
        prefer not to handle exceptions).
        """
        try:
            ep = self.describe(endpoint_id)
        except EndpointNotFound as exc:
            return APIResult(
                status="error",
                error_code="endpoint_not_in_manifest",
                error_message=str(exc),
                endpoint_id=endpoint_id,
            )

        body = dict(params or {})
        # Inject app_id default when the endpoint requires it and caller omitted it.
        if "app_id" in ep.get("required_params", {}) and "app_id" not in body:
            body["app_id"] = self.config.app_id

        missing = [
            p for p in ep.get("required_params", {})
            if p not in body
        ]
        if missing:
            return APIResult(
                status="error",
                error_code="missing_required_params",
                error_message=(
                    f"Endpoint '{endpoint_id}' is missing required params: "
                    f"{', '.join(missing)}. See {ep.get('doc_url', self._doc_root())}"
                ),
                endpoint_id=endpoint_id,
            )

        warnings: list[str] = []
        if not ep.get("path_verified", False):
            warnings.append(
                f"endpoint '{endpoint_id}' path '{ep['path']}' is not yet verified "
                f"against the latest docs ({ep.get('doc_url')}). Confirm before "
                "trusting an empty/error result."
            )

        method = ep.get("method", "POST")
        path, request_body, query_params, extra_headers = self._prepare_request(ep, body)
        result = self._request(method, path, request_body, query_params, extra_headers)
        result.endpoint_id = endpoint_id
        result.warnings = warnings + result.warnings
        return result

    def _prepare_request(self, ep: dict, body: dict) -> tuple[str, dict, dict, dict]:
        """
        Fill official OpenAPI path/header/query placeholders from request params.

        Manifest entries keep the documented path shape, e.g.
        /datafinder/openapi/v1/{app_id}/reports/{report_id}. Placeholder
        params belong in the URL path and are removed from the JSON body. GET
        endpoints carry remaining params as query params; POST endpoints carry
        them as JSON body unless the manifest explicitly lists query_params.
        """
        path_template = ep["path"]
        method = ep.get("method", "POST").upper()
        request_body = dict(body)
        query_params: dict[str, Any] = {}
        extra_headers: dict[str, str] = {}

        for param, header_name in ep.get("header_params", {}).items():
            if param in request_body:
                extra_headers[header_name] = str(request_body.pop(param))

        def replace(match: re.Match[str]) -> str:
            name = match.group(1)
            if name not in request_body:
                raise ValueError(f"missing path param '{name}' for {path_template}")
            return quote(str(request_body.pop(name)), safe="")

        for param in ep.get("query_params", []):
            if param in request_body:
                query_params[param] = request_body.pop(param)

        path = re.sub(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}", replace, path_template)
        if method == "GET":
            query_params.update(request_body)
            request_body = {}

        return path, request_body, query_params, extra_headers

    def _canonical_query(self, query_params: Optional[dict]) -> str:
        if not query_params:
            return ""
        normalized: list[tuple[str, str]] = []
        for key, value in query_params.items():
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            normalized.append((str(key), str(value)))
        normalized.sort(key=lambda item: item[0])
        return urlencode(normalized, doseq=True, quote_via=quote, safe="~")

    # ── Volcengine HMAC-SHA256 signing ─────────────────────────────────────

    def _sign(self, method: str, path: str, canonical_query: str, body_bytes: bytes) -> dict[str, str]:
        """
        Produce signed headers for one Volcengine OpenAPI request.
        Spec: https://www.volcengine.com/docs/84129/1261794?lang=zh
        """
        now = datetime.now(timezone.utc)
        x_date = now.strftime("%Y%m%dT%H%M%SZ")
        short_date = now.strftime("%Y%m%d")

        host = self.config.base_url.removeprefix("https://").removeprefix("http://").split("/")[0]
        body_hash = hashlib.sha256(body_bytes).hexdigest()

        canonical_headers = (
            "content-type:application/json\n"
            f"host:{host}\n"
            f"x-content-sha256:{body_hash}\n"
            f"x-date:{x_date}\n"
        )
        signed_headers = "content-type;host;x-content-sha256;x-date"

        canonical_request = "\n".join([
            method.upper(),
            path,
            canonical_query,
            canonical_headers,
            signed_headers,
            body_hash,
        ])

        credential_scope = f"{short_date}/{self.config.region}/{self.config.service}/request"
        string_to_sign = "\n".join([
            "HMAC-SHA256",
            x_date,
            credential_scope,
            hashlib.sha256(canonical_request.encode()).hexdigest(),
        ])

        def _hmac(key: bytes, msg: str) -> bytes:
            return hmac.new(key, msg.encode(), hashlib.sha256).digest()

        signing_key = _hmac(
            _hmac(
                _hmac(
                    _hmac(self.config.secret_key.encode(), short_date),
                    self.config.region,
                ),
                self.config.service,
            ),
            "request",
        )
        signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()

        return {
            "X-Date": x_date,
            "X-Content-Sha256": body_hash,
            "Authorization": (
                f"HMAC-SHA256 Credential={self.config.access_key}/{credential_scope}, "
                f"SignedHeaders={signed_headers}, Signature={signature}"
            ),
        }

    def _request(
        self,
        method: str,
        path: str,
        body: dict,
        query_params: Optional[dict] = None,
        extra_headers: Optional[dict[str, str]] = None,
    ) -> APIResult:
        """Sign and send; normalise the DataFinder envelope into APIResult."""
        method_upper = method.upper()
        body_bytes = b"" if method_upper == "GET" else json.dumps(body, ensure_ascii=False).encode()
        canonical_query = self._canonical_query(query_params)
        auth_headers = self._sign(method_upper, path, canonical_query, body_bytes)
        headers = {**auth_headers, **(extra_headers or {})}
        url = f"{self.config.base_url}{path}"
        if canonical_query:
            url = f"{url}?{canonical_query}"

        try:
            resp = self._session.request(
                method_upper,
                url,
                data=body_bytes,
                headers=headers,
                timeout=self.config.timeout_seconds,
            )
            resp.raise_for_status()
            payload = resp.json()

            if payload.get("code") not in (0, 200):
                return APIResult(
                    status="error",
                    error_code="openapi_business_error",
                    error_message=payload.get("message") or payload.get("msg") or "business error",
                    http_status=resp.status_code,
                )
            return APIResult(status="success", data=payload.get("data"), http_status=resp.status_code)

        except requests.HTTPError as exc:
            code = exc.response.status_code if exc.response is not None else None
            ec = "openapi_auth_failed" if code == 401 else "openapi_http_error"
            return APIResult(status="error", error_code=ec, error_message=str(exc), http_status=code)
        except Exception as exc:
            return APIResult(status="error", error_code="unknown_error", error_message=str(exc))

    # ── Typed wrappers (thin sugar over call) ──────────────────────────────
    # Each wrapper maps 1:1 to a manifest endpoint id. They exist for ergonomics
    # and discoverability; call() remains the universal path.

    def fetch_dashboard_list(self) -> APIResult:
        return self.call("dashboard.list", {})

    def list_dashboard_reports(self, dashboard_id: str) -> APIResult:
        return self.call("dashboard.reports", {"dashboard_id": dashboard_id})

    def query_report(self, report_id: str, count: int = 1000,
                     filter_id: Optional[int] = None,
                     global_filter: Optional[dict] = None) -> APIResult:
        params: dict[str, Any] = {"report_id": report_id, "count": count}
        if filter_id is not None:
            params["filter_id"] = filter_id
        if global_filter is not None:
            params["global_filter"] = global_filter
        return self.call("report.query", params)

    def execute_analysis_query(self, compiled_body: dict) -> APIResult:
        return self.call("analysis.query", compiled_body)

    def fetch_analysis_result(self, result_id: str) -> APIResult:
        return self.call("analysis.result", {"result_id": result_id})

    def download_analysis(self, body: dict) -> APIResult:
        return self.call("analysis.download", body)

    def fetch_metadata(self, keyword: Optional[str] = None,
                       event_name: Optional[str] = None,
                       include: Optional[list[str]] = None) -> APIResult:
        params: dict[str, Any] = {}
        filters: dict[str, Any] = {}
        if keyword:
            filters["name"] = [keyword]
        if event_name:
            filters["name"] = [event_name]
        if filters:
            params["filter"] = filters
        if include is not None:
            params["with"] = include
        return self.call("metadata.query", params)

    def query_user_profile(self, query_type: str, query_id: str,
                           include_tags: bool = False, include_device_info: bool = False) -> APIResult:
        return self.call("user.profile", {
            "query_type": query_type,
            "query_id": query_id,
            "include_tags": include_tags,
            "include_device_info": include_device_info,
        })

    def query_behavior_flow(self, query_type: str, query_id: str, timestamp: int,
                            orientation: str, count: int = 20,
                            current_earliest_timestamp: Optional[int] = None) -> APIResult:
        params: dict[str, Any] = {
            "query_type": query_type,
            "query_id": query_id,
            "timestamp": timestamp,
            "orientation": orientation,
            "count": count,
        }
        if current_earliest_timestamp is not None:
            params["current_earliest_timestamp"] = current_earliest_timestamp
        return self.call("user.behavior_flow", params)

    def create_user_query(self, query_type: str, query_body: dict,
                          profile_names: Optional[list[str]] = None,
                          id_types: Optional[list[str]] = None,
                          limit: Optional[int] = None) -> APIResult:
        params: dict[str, Any] = {"query_type": query_type, query_type: query_body}
        if profile_names is not None:
            params["profile_names"] = profile_names
        if id_types is not None:
            params["id_types"] = id_types
        if limit is not None:
            params["limit"] = limit
        return self.call("user.query_create", params)

    def fetch_user_query_result(self, query_id: str) -> APIResult:
        return self.call("user.query_result", {"query_id": query_id})

    def query_segment(self, cohort_id: int, count: int) -> APIResult:
        return self.call("segment.query", {"cohort_id": cohort_id, "count": count})

    def query_tag_v1(self, tag_name: str, tag_type: str, condition: dict,
                     period: Optional[dict] = None) -> APIResult:
        params: dict[str, Any] = {"tag_name": tag_name, "type": tag_type, "condition": condition}
        if period is not None:
            params["period"] = period
        return self.call("tag.v1", params)

    def query_tag_v2(self, tenant_id: str, tag_id: int, start_date: str,
                     end_date: str, show_num: int = 10) -> APIResult:
        params: dict[str, Any] = {
            "tenant_id": tenant_id,
            "id": tag_id,
            "showNum": show_num,
            "startDate": start_date,
            "endDate": end_date,
        }
        return self.call("tag.v2", params)

    def export_raw_events(self, begin_date: Optional[str] = None,
                          end_date: Optional[str] = None) -> APIResult:
        params: dict[str, Any] = {}
        if begin_date:
            params["begin_date"] = begin_date
        if end_date:
            params["end_date"] = end_date
        return self.call("raw_event.export", params)

    def query_usage_stats(self, app_ids: list[int], start_time: int, end_time: int,
                          org_id: Optional[str] = None) -> APIResult:
        params: dict[str, Any] = {
            "app_ids": app_ids,
            "start_time": start_time,
            "end_time": end_time,
        }
        if org_id:
            params["org_id"] = org_id
        return self.call("usage.stats", params)


# ── Config loader from .env.local ───────────────────────────────────────────────

def load_config_from_env(env_path: Optional[str] = None) -> DataFinderConfig:
    """
    Build a DataFinderConfig from a .env.local file (project root by default).
    Reads DATAFINDER_BASE_URL / ACCESS_KEY / SECRET_KEY / APP_ID / REGION / SERVICE.
    """
    path = Path(env_path) if env_path else (Path(__file__).parents[2] / ".env.local")
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip()

    return DataFinderConfig(
        base_url=values["DATAFINDER_BASE_URL"],
        access_key=values["DATAFINDER_ACCESS_KEY"],
        secret_key=values["DATAFINDER_SECRET_KEY"],
        app_id=int(values["DATAFINDER_APP_ID"]),
        region=values.get("DATAFINDER_REGION", "cn-north-1"),
        service=values.get("DATAFINDER_SERVICE", "datafinder"),
    )
