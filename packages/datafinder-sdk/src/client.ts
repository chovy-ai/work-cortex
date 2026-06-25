/**
 * DataFinder OpenAPI module — manifest-driven client (TypeScript).
 *
 * This is the single, complete module for calling 火山引擎 DataFinder OpenAPI.
 * Everything callable is declared in `manifest.json`; this client reads that
 * manifest and exposes:
 *
 *   Discovery (so the agent can see the full interface surface):
 *     - listEndpoints()        → ids + summaries of every declared endpoint
 *     - describe(endpointId)   → full interface definition for one endpoint
 *     - docUrl(endpointId)     → official documentation link
 *
 *   Invocation:
 *     - call(endpointId, params)       → generic, manifest-validated request
 *     - typed wrappers (fetchDashboardList, queryReport, …) for the common ones
 *
 * When an endpoint is NOT in the manifest, call() returns an APIResult with
 * error_code='endpoint_not_in_manifest' pointing at UPDATE.md, so the agent can
 * look up the latest interface from the official docs and extend the manifest.
 *
 * API path reference root: https://www.volcengine.com/docs/84129
 * Signing spec:            https://www.volcengine.com/docs/84129/1261794?lang=zh
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 编译产物 dist/src/client.js → 包根；manifest.json 放包根，运行时读取（tsc 不拷 json）。
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST_PATH = join(PKG_ROOT, "manifest.json");

// ── Config & result types ──────────────────────────────────────────────────────

/**
 * Runtime configuration for DataFinder OpenAPI.
 * Credentials are never stored in skill files; pass them at call time
 * (load from .env.local).
 *
 * base_url:
 *   SaaS cloud-native / domestic non-cloud-native → https://analytics.volcengineapi.com
 *   BytePlus overseas                              → https://analytics.byteplusapi.com
 *   Private deployment                             → private Finder domain
 */
export interface DataFinderConfig {
  base_url: string;
  access_key: string;
  secret_key: string;
  app_id: number;
  /** 分析项目 id（analysis DSL 的 resources 作用域用）。.env.local 的 DATAFINDER_PROJECT_ID。 */
  project_id?: number;
  region?: string;
  service?: string;
  timeout_seconds?: number;
}

/** Normalised result from any DataFinder OpenAPI call. */
export interface APIResult {
  status: "success" | "error";
  data?: unknown;
  error_code?: string | null;
  error_message?: string | null;
  http_status?: number | null;
  endpoint_id?: string | null;
  warnings: string[];
}

export interface ManifestEndpoint {
  id: string;
  summary?: string;
  method?: string;
  path: string;
  path_verified?: boolean;
  doc_url?: string;
  required_params?: Record<string, string>;
  optional_params?: Record<string, string>;
  query_params?: string[];
  header_params?: Record<string, string>;
  [k: string]: unknown;
}

export interface Manifest {
  global?: { doc_root?: string; [k: string]: unknown };
  endpoints: ManifestEndpoint[];
  [k: string]: unknown;
}

export class EndpointNotFound extends Error {}

// ── Manifest loading ───────────────────────────────────────────────────────────

/** Load the complete DataFinder interface manifest. */
export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
}

// ── percent-encode 与 Python urllib.parse.quote(safe="~") 对齐 ─────────────────

function pyQuote(s: string): string {
  let out = "";
  for (const ch of s) {
    if (/[A-Za-z0-9_.\-~]/.test(ch)) out += ch;
    else out += Array.from(new TextEncoder().encode(ch), (b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
  }
  return out;
}

// ── Client ─────────────────────────────────────────────────────────────────────

export class DataFinderClient {
  static readonly SIGN_EXPIRE_SECONDS = 1800;

  // region/service/timeout 由构造器兜底故必有；project_id 可缺省（非所有接入都需要分析项目作用域）
  readonly config: Required<Omit<DataFinderConfig, "project_id">> & { project_id?: number };
  readonly manifest: Manifest;
  private byId: Map<string, ManifestEndpoint>;

  constructor(config: DataFinderConfig, manifest?: Manifest) {
    this.config = {
      region: "cn-north-1",
      service: "datafinder",
      timeout_seconds: 30,
      ...config,
    };
    this.manifest = manifest ?? loadManifest();
    this.byId = new Map(this.manifest.endpoints.map((ep) => [ep.id, ep]));
  }

  // ── Discovery interface ────────────────────────────────────────────────

  /** Return [{id, summary, doc_url, path_verified}] for every endpoint. */
  listEndpoints(): { id: string; summary: string; doc_url: string; path_verified: boolean }[] {
    return this.manifest.endpoints.map((ep) => ({
      id: ep.id,
      summary: ep.summary ?? "",
      doc_url: ep.doc_url ?? "",
      path_verified: ep.path_verified ?? false,
    }));
  }

  /** Return the full manifest entry for one endpoint, or throw EndpointNotFound. */
  describe(endpointId: string): ManifestEndpoint {
    const ep = this.byId.get(endpointId);
    if (!ep) throw this.notFound(endpointId);
    return ep;
  }

  /** Return the official documentation URL for one endpoint. */
  docUrl(endpointId: string): string {
    return this.describe(endpointId).doc_url ?? this.docRoot();
  }

  private docRoot(): string {
    return this.manifest.global?.doc_root ?? "https://www.volcengine.com/docs/84129";
  }

  private notFound(endpointId: string): EndpointNotFound {
    const known = [...this.byId.keys()].sort().join(", ") || "(none)";
    return new EndpointNotFound(
      `Endpoint '${endpointId}' is not declared in manifest.json.\n` +
        `Known endpoints: ${known}\n` +
        `To add it: look up the latest interface in the official docs ` +
        `(${this.docRoot()}) and follow domains/datafinder-interface/UPDATE.md to ` +
        `register the endpoint, then retry.`,
    );
  }

  // ── Generic invocation ─────────────────────────────────────────────────

  /**
   * Manifest-driven request. Looks up endpointId, validates required params,
   * injects app_id default, signs, and sends.
   */
  async call(endpointId: string, params?: Record<string, unknown>): Promise<APIResult> {
    let ep: ManifestEndpoint;
    try {
      ep = this.describe(endpointId);
    } catch (exc) {
      return {
        status: "error",
        error_code: "endpoint_not_in_manifest",
        error_message: String((exc as Error).message),
        endpoint_id: endpointId,
        warnings: [],
      };
    }

    const body: Record<string, unknown> = { ...(params ?? {}) };
    // Inject app_id default when the endpoint requires it and caller omitted it.
    if ("app_id" in (ep.required_params ?? {}) && !("app_id" in body)) {
      body["app_id"] = this.config.app_id;
    }

    const missing = Object.keys(ep.required_params ?? {}).filter((p) => !(p in body));
    if (missing.length > 0) {
      return {
        status: "error",
        error_code: "missing_required_params",
        error_message:
          `Endpoint '${endpointId}' is missing required params: ` +
          `${missing.join(", ")}. See ${ep.doc_url ?? this.docRoot()}`,
        endpoint_id: endpointId,
        warnings: [],
      };
    }

    const warnings: string[] = [];
    if (!(ep.path_verified ?? false)) {
      warnings.push(
        `endpoint '${endpointId}' path '${ep.path}' is not yet verified ` +
          `against the latest docs (${ep.doc_url}). Confirm before ` +
          `trusting an empty/error result.`,
      );
    }

    const method = (ep.method ?? "POST").toUpperCase();
    let prepared: { path: string; requestBody: Record<string, unknown>; queryParams: Record<string, unknown>; extraHeaders: Record<string, string> };
    try {
      prepared = this.prepareRequest(ep, body);
    } catch (exc) {
      return {
        status: "error",
        error_code: "missing_required_params",
        error_message: String((exc as Error).message),
        endpoint_id: endpointId,
        warnings,
      };
    }
    const result = await this.request(method, prepared.path, prepared.requestBody, prepared.queryParams, prepared.extraHeaders);
    result.endpoint_id = endpointId;
    result.warnings = [...warnings, ...result.warnings];
    return result;
  }

  /**
   * Fill official OpenAPI path/header/query placeholders from request params.
   *
   * Manifest entries keep the documented path shape, e.g.
   * /datafinder/openapi/v1/{app_id}/reports/{report_id}. Placeholder
   * params belong in the URL path and are removed from the JSON body. GET
   * endpoints carry remaining params as query params; POST endpoints carry
   * them as JSON body unless the manifest explicitly lists query_params.
   */
  private prepareRequest(ep: ManifestEndpoint, body: Record<string, unknown>) {
    const pathTemplate = ep.path;
    const method = (ep.method ?? "POST").toUpperCase();
    const requestBody: Record<string, unknown> = { ...body };
    const queryParams: Record<string, unknown> = {};
    const extraHeaders: Record<string, string> = {};

    for (const [param, headerName] of Object.entries(ep.header_params ?? {})) {
      if (param in requestBody) {
        extraHeaders[headerName] = String(requestBody[param]);
        delete requestBody[param];
      }
    }

    for (const param of ep.query_params ?? []) {
      if (param in requestBody) {
        queryParams[param] = requestBody[param];
        delete requestBody[param];
      }
    }

    const path = pathTemplate.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, name: string) => {
      if (!(name in requestBody)) {
        throw new Error(`missing path param '${name}' for ${pathTemplate}`);
      }
      const v = pyQuote(String(requestBody[name]));
      delete requestBody[name];
      return v;
    });

    if (method === "GET") {
      Object.assign(queryParams, requestBody);
      for (const k of Object.keys(requestBody)) delete requestBody[k];
    }

    return { path, requestBody, queryParams, extraHeaders };
  }

  private canonicalQuery(queryParams?: Record<string, unknown>): string {
    if (!queryParams || Object.keys(queryParams).length === 0) return "";
    const normalized: [string, string][] = Object.entries(queryParams).map(([key, value]) => {
      const v = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      return [String(key), v];
    });
    normalized.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return normalized.map(([k, v]) => `${pyQuote(k)}=${pyQuote(v)}`).join("&");
  }

  // ── DataFinder ak-v1 signing ────────────────────────────────────────────
  // 注意：DataFinder OpenAPI 用自有 ak-v1 方案，不是火山 IAM v4 签名。
  // 已于 2026-06-12 实测验证（dashboard.list / report.query 返回 200）。

  /**
   * Authorization: ak-v1/{ak}/{timestamp}/{expire}/{signature}
   *   sign_key  = hex( HMAC-SHA256(key=SK, msg="ak-v1/{ak}/{ts}/{expire}") )
   *   canonical = "HTTPMethod:{M}\nCanonicalURI:{path}\nCanonicalQueryString:{q}\nCanonicalBody:{body}"
   *   signature = hex( HMAC-SHA256(key=sign_key, msg=canonical) )
   */
  private sign(method: string, path: string, canonicalQuery: string, bodyText: string): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const prefix = `ak-v1/${this.config.access_key}/${timestamp}/${DataFinderClient.SIGN_EXPIRE_SECONDS}`;
    const canonical =
      `HTTPMethod:${method.toUpperCase()}\n` +
      `CanonicalURI:${path}\n` +
      `CanonicalQueryString:${canonicalQuery}\n` +
      `CanonicalBody:${bodyText}`;
    const signKey = createHmac("sha256", this.config.secret_key).update(prefix).digest("hex");
    const signature = createHmac("sha256", signKey).update(canonical).digest("hex");
    return { Authorization: `${prefix}/${signature}` };
  }

  /** Sign and send; normalise the DataFinder envelope into APIResult. */
  private async request(
    method: string,
    path: string,
    body: Record<string, unknown>,
    queryParams?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<APIResult> {
    const methodUpper = method.toUpperCase();
    const bodyText = methodUpper === "GET" ? "" : JSON.stringify(body);
    const canonicalQuery = this.canonicalQuery(queryParams);
    const authHeaders = this.sign(methodUpper, path, canonicalQuery, bodyText);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...authHeaders,
      ...(extraHeaders ?? {}),
    };
    let url = `${this.config.base_url}${path}`;
    if (canonicalQuery) url = `${url}?${canonicalQuery}`;

    try {
      const resp = await fetch(url, {
        method: methodUpper,
        headers,
        body: methodUpper === "GET" ? undefined : bodyText,
        signal: AbortSignal.timeout(this.config.timeout_seconds * 1000),
      });
      if (!resp.ok) {
        const ec = resp.status === 401 ? "openapi_auth_failed" : "openapi_http_error";
        return {
          status: "error",
          error_code: ec,
          error_message: `${resp.status} ${resp.statusText} for url: ${url}`,
          http_status: resp.status,
          warnings: [],
        };
      }
      const payload = (await resp.json()) as Record<string, unknown>;
      const code = payload["code"];
      if (code !== 0 && code !== 200) {
        // 保留真实 code 与 log_id/request_id —— 「操作失败，请反馈给管理员」这类通用文案
        // 不带它们根本没法排查（提工单也要 log_id）。
        const logId = payload["log_id"] ?? payload["request_id"] ?? (payload["data"] as any)?.["log_id"];
        const msg = String(payload["message"] ?? payload["msg"] ?? "business error");
        return {
          status: "error",
          error_code: "openapi_business_error",
          error_message: `${msg}（code=${String(code)}${logId ? `, log_id=${String(logId)}` : ""}）`,
          http_status: resp.status,
          warnings: [],
        };
      }
      return { status: "success", data: payload["data"], http_status: resp.status, warnings: [] };
    } catch (exc) {
      return { status: "error", error_code: "unknown_error", error_message: String(exc), warnings: [] };
    }
  }

  // ── Typed wrappers (thin sugar over call) ──────────────────────────────
  // Each wrapper maps 1:1 to a manifest endpoint id. They exist for ergonomics
  // and discoverability; call() remains the universal path.

  fetchDashboardList(): Promise<APIResult> {
    return this.call("dashboard.list", {});
  }

  listDashboardReports(dashboardId: string): Promise<APIResult> {
    return this.call("dashboard.reports", { dashboard_id: dashboardId });
  }

  queryReport(reportId: string, count = 1000, filterId?: number, globalFilter?: Record<string, unknown>): Promise<APIResult> {
    const params: Record<string, unknown> = { report_id: reportId, count };
    if (filterId !== undefined) params["filter_id"] = filterId;
    if (globalFilter !== undefined) params["global_filter"] = globalFilter;
    return this.call("report.query", params);
  }

  executeAnalysisQuery(compiledBody: Record<string, unknown>): Promise<APIResult> {
    return this.call("analysis.query", compiledBody);
  }

  fetchAnalysisResult(resultId: string): Promise<APIResult> {
    return this.call("analysis.result", { result_id: resultId });
  }

  downloadAnalysis(body: Record<string, unknown>): Promise<APIResult> {
    return this.call("analysis.download", body);
  }

  fetchMetadata(keyword?: string, eventName?: string, include?: string[]): Promise<APIResult> {
    const params: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    if (keyword) filters["name"] = [keyword];
    if (eventName) filters["name"] = [eventName];
    if (Object.keys(filters).length > 0) params["filter"] = filters;
    if (include !== undefined) params["with"] = include;
    return this.call("metadata.query", params);
  }

  queryUserProfile(queryType: string, queryId: string, includeTags = false, includeDeviceInfo = false): Promise<APIResult> {
    return this.call("user.profile", {
      query_type: queryType,
      query_id: queryId,
      include_tags: includeTags,
      include_device_info: includeDeviceInfo,
    });
  }

  queryBehaviorFlow(
    queryType: string,
    queryId: string,
    timestamp: number,
    orientation: string,
    count = 20,
    currentEarliestTimestamp?: number,
  ): Promise<APIResult> {
    const params: Record<string, unknown> = {
      query_type: queryType,
      query_id: queryId,
      timestamp,
      orientation,
      count,
    };
    if (currentEarliestTimestamp !== undefined) params["current_earliest_timestamp"] = currentEarliestTimestamp;
    return this.call("user.behavior_flow", params);
  }

  createUserQuery(
    queryType: string,
    queryBody: Record<string, unknown>,
    profileNames?: string[],
    idTypes?: string[],
    limit?: number,
  ): Promise<APIResult> {
    const params: Record<string, unknown> = { query_type: queryType, [queryType]: queryBody };
    if (profileNames !== undefined) params["profile_names"] = profileNames;
    if (idTypes !== undefined) params["id_types"] = idTypes;
    if (limit !== undefined) params["limit"] = limit;
    return this.call("user.query_create", params);
  }

  fetchUserQueryResult(queryId: string): Promise<APIResult> {
    return this.call("user.query_result", { query_id: queryId });
  }

  querySegment(cohortId: number, count: number): Promise<APIResult> {
    return this.call("segment.query", { cohort_id: cohortId, count });
  }

  queryTagV1(tagName: string, tagType: string, condition: Record<string, unknown>, period?: Record<string, unknown>): Promise<APIResult> {
    const params: Record<string, unknown> = { tag_name: tagName, type: tagType, condition };
    if (period !== undefined) params["period"] = period;
    return this.call("tag.v1", params);
  }

  queryTagV2(tenantId: string, tagId: number, startDate: string, endDate: string, showNum = 10): Promise<APIResult> {
    return this.call("tag.v2", {
      tenant_id: tenantId,
      id: tagId,
      showNum,
      startDate,
      endDate,
    });
  }

  exportRawEvents(beginDate?: string, endDate?: string): Promise<APIResult> {
    const params: Record<string, unknown> = {};
    if (beginDate) params["begin_date"] = beginDate;
    if (endDate) params["end_date"] = endDate;
    return this.call("raw_event.export", params);
  }

  queryUsageStats(appIds: number[], startTime: number, endTime: number, orgId?: string): Promise<APIResult> {
    const params: Record<string, unknown> = {
      app_ids: appIds,
      start_time: startTime,
      end_time: endTime,
    };
    if (orgId) params["org_id"] = orgId;
    return this.call("usage.stats", params);
  }
}

// ── Config loader from .env.local ───────────────────────────────────────────────

/**
 * Build a DataFinderConfig from a .env.local file. SDK 配置无关：调用方传入路径
 * （不传则取 process.cwd()/.env.local）。Reads DATAFINDER_BASE_URL / ACCESS_KEY /
 * SECRET_KEY / APP_ID / PROJECT_ID / REGION / SERVICE.
 */
export function loadConfigFromEnv(envPath?: string): DataFinderConfig {
  const path = envPath ?? join(process.cwd(), ".env.local");
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf-8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    values[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  for (const k of ["DATAFINDER_BASE_URL", "DATAFINDER_ACCESS_KEY", "DATAFINDER_SECRET_KEY", "DATAFINDER_APP_ID"]) {
    if (!(k in values)) throw new Error(`missing ${k} in ${path}`);
  }
  return {
    base_url: values["DATAFINDER_BASE_URL"],
    access_key: values["DATAFINDER_ACCESS_KEY"],
    secret_key: values["DATAFINDER_SECRET_KEY"],
    app_id: Number(values["DATAFINDER_APP_ID"]),
    project_id: values["DATAFINDER_PROJECT_ID"] ? Number(values["DATAFINDER_PROJECT_ID"]) : undefined,
    region: values["DATAFINDER_REGION"] ?? "cn-north-1",
    service: values["DATAFINDER_SERVICE"] ?? "datafinder",
  };
}
