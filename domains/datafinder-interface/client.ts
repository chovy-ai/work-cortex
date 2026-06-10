import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, "manifest.json");

export interface DataFinderConfig {
  baseUrl: string;
  accessKey: string;
  secretKey: string;
  appId: number;
  region?: string;
  service?: string;
  timeoutSeconds?: number;
}

export interface APIResult {
  status: "success" | "error";
  data?: unknown;
  errorCode?: string;
  errorMessage?: string;
  httpStatus?: number;
  endpointId?: string;
  warnings?: string[];
}

export class EndpointNotFound extends Error {}

interface ManifestEndpoint {
  id: string;
  method?: string;
  path: string;
  summary?: string;
  doc_url?: string;
  path_verified?: boolean;
  required_params?: Record<string, unknown>;
  query_params?: string[];
  header_params?: Record<string, string>;
}

interface Manifest {
  global?: { doc_root?: string };
  endpoints: ManifestEndpoint[];
}

type Params = Record<string, unknown>;

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

function configValue<T extends keyof DataFinderConfig>(config: DataFinderConfig, key: T): DataFinderConfig[T] {
  return config[key];
}

export class DataFinderClient {
  readonly config: Required<DataFinderConfig>;
  readonly manifest: Manifest;
  readonly byId: Map<string, ManifestEndpoint>;

  constructor(config: DataFinderConfig, manifest?: Manifest) {
    this.config = {
      baseUrl: configValue(config, "baseUrl"),
      accessKey: configValue(config, "accessKey"),
      secretKey: configValue(config, "secretKey"),
      appId: configValue(config, "appId"),
      region: config.region ?? "cn-north-1",
      service: config.service ?? "datafinder",
      timeoutSeconds: config.timeoutSeconds ?? 30
    };
    this.manifest = manifest ?? loadManifest();
    this.byId = new Map(this.manifest.endpoints.map((ep) => [ep.id, ep]));
  }

  listEndpoints(): Array<{ id: string; summary: string; doc_url: string; path_verified: boolean }> {
    return this.manifest.endpoints.map((ep) => ({
      id: ep.id,
      summary: ep.summary ?? "",
      doc_url: ep.doc_url ?? "",
      path_verified: ep.path_verified ?? false
    }));
  }

  describe(endpointId: string): ManifestEndpoint {
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) {
      throw this.notFound(endpointId);
    }
    return endpoint;
  }

  docUrl(endpointId: string): string {
    return this.describe(endpointId).doc_url ?? this.docRoot();
  }

  async call(endpointId: string, params: Params = {}): Promise<APIResult> {
    let endpoint: ManifestEndpoint;
    try {
      endpoint = this.describe(endpointId);
    } catch (error) {
      if (error instanceof EndpointNotFound) {
        return {
          status: "error",
          errorCode: "endpoint_not_in_manifest",
          errorMessage: error.message,
          endpointId
        };
      }
      throw error;
    }

    const body: Params = { ...params };
    if (endpoint.required_params?.app_id !== undefined && body.app_id === undefined) {
      body.app_id = this.config.appId;
    }

    const missing = Object.keys(endpoint.required_params ?? {}).filter((param) => body[param] === undefined);
    if (missing.length > 0) {
      return {
        status: "error",
        errorCode: "missing_required_params",
        errorMessage: `Endpoint '${endpointId}' is missing required params: ${missing.join(", ")}. See ${endpoint.doc_url ?? this.docRoot()}`,
        endpointId
      };
    }

    const warnings: string[] = [];
    if (!endpoint.path_verified) {
      warnings.push(
        `endpoint '${endpointId}' path '${endpoint.path}' is not yet verified against the latest docs (${endpoint.doc_url}). Confirm before trusting an empty/error result.`
      );
    }

    const { path, requestBody, queryParams, extraHeaders } = this.prepareRequest(endpoint, body);
    const result = await this.request(endpoint.method ?? "POST", path, requestBody, queryParams, extraHeaders);
    return {
      ...result,
      endpointId,
      warnings: [...warnings, ...(result.warnings ?? [])]
    };
  }

  prepareRequest(endpoint: ManifestEndpoint, body: Params): {
    path: string;
    requestBody: Params;
    queryParams: Params;
    extraHeaders: Record<string, string>;
  } {
    const requestBody: Params = { ...body };
    const queryParams: Params = {};
    const extraHeaders: Record<string, string> = {};

    for (const [param, headerName] of Object.entries(endpoint.header_params ?? {})) {
      if (requestBody[param] !== undefined) {
        extraHeaders[headerName] = String(requestBody[param]);
        delete requestBody[param];
      }
    }

    for (const param of endpoint.query_params ?? []) {
      if (requestBody[param] !== undefined) {
        queryParams[param] = requestBody[param];
        delete requestBody[param];
      }
    }

    const path = endpoint.path.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
      if (requestBody[name] === undefined) {
        throw new Error(`missing path param '${name}' for ${endpoint.path}`);
      }
      const value = encodeURIComponent(String(requestBody[name]));
      delete requestBody[name];
      return value;
    });

    if ((endpoint.method ?? "POST").toUpperCase() === "GET") {
      Object.assign(queryParams, requestBody);
      for (const key of Object.keys(requestBody)) {
        delete requestBody[key];
      }
    }

    return { path, requestBody, queryParams, extraHeaders };
  }

  canonicalQuery(queryParams: Params = {}): string {
    const entries = Object.entries(queryParams).map(([key, value]) => {
      const normalized = typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : String(value);
      return [key, normalized] as const;
    });
    entries.sort(([a], [b]) => a.localeCompare(b));
    return entries
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value).replace(/%7E/g, "~")}`)
      .join("&");
  }

  sign(method: string, path: string, canonicalQuery: string, bodyBytes: Buffer): Record<string, string> {
    const now = new Date();
    const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const shortDate = iso.slice(0, 8);
    const host = this.config.baseUrl.replace(/^https?:\/\//, "").split("/")[0];
    const bodyHash = createHash("sha256").update(bodyBytes).digest("hex");
    const canonicalHeaders = [
      "content-type:application/json",
      `host:${host}`,
      `x-content-sha256:${bodyHash}`,
      `x-date:${iso}`,
      ""
    ].join("\n");
    const signedHeaders = "content-type;host;x-content-sha256;x-date";
    const canonicalRequest = [
      method.toUpperCase(),
      path,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      bodyHash
    ].join("\n");
    const credentialScope = `${shortDate}/${this.config.region}/${this.config.service}/request`;
    const stringToSign = [
      "HMAC-SHA256",
      iso,
      credentialScope,
      createHash("sha256").update(canonicalRequest).digest("hex")
    ].join("\n");

    const hmac = (key: Buffer | string, message: string): Buffer => createHmac("sha256", key).update(message).digest();
    const signingKey = hmac(hmac(hmac(hmac(this.config.secretKey, shortDate), this.config.region), this.config.service), "request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    return {
      "X-Date": iso,
      "X-Content-Sha256": bodyHash,
      Authorization: `HMAC-SHA256 Credential=${this.config.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    };
  }

  async request(
    method: string,
    path: string,
    body: Params,
    queryParams: Params = {},
    extraHeaders: Record<string, string> = {}
  ): Promise<APIResult> {
    const methodUpper = method.toUpperCase();
    const bodyBytes = methodUpper === "GET" ? Buffer.from("") : Buffer.from(JSON.stringify(body));
    const canonicalQuery = this.canonicalQuery(queryParams);
    const authHeaders = this.sign(methodUpper, path, canonicalQuery, bodyBytes);
    const url = `${this.config.baseUrl}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutSeconds * 1000);
      const response = await fetch(url, {
        method: methodUpper,
        body: methodUpper === "GET" ? undefined : bodyBytes,
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
          ...extraHeaders
        },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) {
        return {
          status: "error",
          errorCode: response.status === 401 ? "openapi_auth_failed" : "openapi_http_error",
          errorMessage: `${response.status} ${response.statusText}`,
          httpStatus: response.status
        };
      }
      const payload = await response.json() as Record<string, unknown>;
      if (payload.code !== 0 && payload.code !== 200) {
        return {
          status: "error",
          errorCode: "openapi_business_error",
          errorMessage: String(payload.message ?? payload.msg ?? "business error"),
          httpStatus: response.status
        };
      }
      return { status: "success", data: payload.data, httpStatus: response.status };
    } catch (error) {
      return {
        status: "error",
        errorCode: "unknown_error",
        errorMessage: error instanceof Error ? error.message : String(error)
      };
    }
  }

  fetchDashboardList(): Promise<APIResult> {
    return this.call("dashboard.list", {});
  }

  listDashboardReports(dashboardId: string): Promise<APIResult> {
    return this.call("dashboard.reports", { dashboard_id: dashboardId });
  }

  queryReport(reportId: string, count = 1000, filterId?: number, globalFilter?: Params): Promise<APIResult> {
    const params: Params = { report_id: reportId, count };
    if (filterId !== undefined) params.filter_id = filterId;
    if (globalFilter !== undefined) params.global_filter = globalFilter;
    return this.call("report.query", params);
  }

  executeAnalysisQuery(compiledBody: Params): Promise<APIResult> {
    return this.call("analysis.query", compiledBody);
  }

  fetchAnalysisResult(resultId: string): Promise<APIResult> {
    return this.call("analysis.result", { result_id: resultId });
  }

  downloadAnalysis(body: Params): Promise<APIResult> {
    return this.call("analysis.download", body);
  }

  fetchMetadata(keyword?: string, eventName?: string, include?: string[]): Promise<APIResult> {
    const params: Params = {};
    const filters: Params = {};
    if (keyword) filters.name = [keyword];
    if (eventName) filters.name = [eventName];
    if (Object.keys(filters).length > 0) params.filter = filters;
    if (include !== undefined) params.with = include;
    return this.call("metadata.query", params);
  }

  queryUserProfile(queryType: string, queryId: string, includeTags = false, includeDeviceInfo = false): Promise<APIResult> {
    return this.call("user.profile", {
      query_type: queryType,
      query_id: queryId,
      include_tags: includeTags,
      include_device_info: includeDeviceInfo
    });
  }

  queryBehaviorFlow(
    queryType: string,
    queryId: string,
    timestamp: number,
    orientation: string,
    count = 20,
    currentEarliestTimestamp?: number
  ): Promise<APIResult> {
    const params: Params = {
      query_type: queryType,
      query_id: queryId,
      timestamp,
      orientation,
      count
    };
    if (currentEarliestTimestamp !== undefined) {
      params.current_earliest_timestamp = currentEarliestTimestamp;
    }
    return this.call("user.behavior_flow", params);
  }

  createUserQuery(
    queryType: string,
    queryBody: Params,
    profileNames?: string[],
    idTypes?: string[],
    limit?: number
  ): Promise<APIResult> {
    const params: Params = { query_type: queryType, [queryType]: queryBody };
    if (profileNames !== undefined) params.profile_names = profileNames;
    if (idTypes !== undefined) params.id_types = idTypes;
    if (limit !== undefined) params.limit = limit;
    return this.call("user.query_create", params);
  }

  fetchUserQueryResult(queryId: string): Promise<APIResult> {
    return this.call("user.query_result", { query_id: queryId });
  }

  querySegment(cohortId: number, count: number): Promise<APIResult> {
    return this.call("segment.query", { cohort_id: cohortId, count });
  }

  queryTagV1(tagName: string, tagType: string, condition: Params, period?: Params): Promise<APIResult> {
    const params: Params = { tag_name: tagName, type: tagType, condition };
    if (period !== undefined) params.period = period;
    return this.call("tag.v1", params);
  }

  queryTagV2(tenantId: string, tagId: number, startDate: string, endDate: string, showNum = 10): Promise<APIResult> {
    return this.call("tag.v2", {
      tenant_id: tenantId,
      id: tagId,
      showNum,
      startDate,
      endDate
    });
  }

  exportRawEvents(beginDate?: string, endDate?: string): Promise<APIResult> {
    const params: Params = {};
    if (beginDate) params.begin_date = beginDate;
    if (endDate) params.end_date = endDate;
    return this.call("raw_event.export", params);
  }

  queryUsageStats(appIds: number[], startTime: number, endTime: number, orgId?: string): Promise<APIResult> {
    const params: Params = { app_ids: appIds, start_time: startTime, end_time: endTime };
    if (orgId) params.org_id = orgId;
    return this.call("usage.stats", params);
  }

  private docRoot(): string {
    return this.manifest.global?.doc_root ?? "https://www.volcengine.com/docs/84129";
  }

  private notFound(endpointId: string): EndpointNotFound {
    const known = [...this.byId.keys()].sort().join(", ") || "(none)";
    return new EndpointNotFound(
      `Endpoint '${endpointId}' is not declared in manifest.json.\n` +
      `Known endpoints: ${known}\n` +
      `To add it: look up the latest interface in the official docs (${this.docRoot()}) and follow domains/datafinder-interface/UPDATE.md to register the endpoint, then retry.`
    );
  }
}

export function loadConfigFromEnv(envPath?: string): DataFinderConfig {
  const path = envPath ?? join(here, "..", "..", ".env.local");
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }

  return {
    baseUrl: values.DATAFINDER_BASE_URL,
    accessKey: values.DATAFINDER_ACCESS_KEY,
    secretKey: values.DATAFINDER_SECRET_KEY,
    appId: Number.parseInt(values.DATAFINDER_APP_ID, 10),
    region: values.DATAFINDER_REGION ?? "cn-north-1",
    service: values.DATAFINDER_SERVICE ?? "datafinder"
  };
}
