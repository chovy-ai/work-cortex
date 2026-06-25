/**
 * DataFinderSDK —— 对外灵活门面。
 *
 *   发现/自描述：endpoints() / describe() / docUrl() / help()
 *   泛化调用：  call(id, params) → 归一化 DfResult（错误带 docUrl）；raw(id, params) → 原始 APIResult
 *   类型化分组方法：dashboards / reports / analysis / metadata / users / segments / tags / rawEvents / usage
 *
 * 每个分组方法都是 call(id, 强类型参数) 的薄包装，JSDoc 带官方文档链接（@see）。
 * 配置注入：构造传 DataFinderConfig（建客户端）或直接传 DataFinderClient（便于 mock）。
 */
import {
  DataFinderClient,
  type DataFinderConfig,
  type APIResult,
  type ManifestEndpoint,
} from "./client.js";
import { type DfResult, mapErrorCode } from "./errors.js";
import { normalizeOpenApiData, genericResult } from "./normalize.js";
import type * as P from "./types.js";

export class DataFinderSDK {
  readonly client: DataFinderClient;

  constructor(configOrClient: DataFinderConfig | DataFinderClient) {
    this.client = configOrClient instanceof DataFinderClient ? configOrClient : new DataFinderClient(configOrClient);
  }

  // ── 发现 / 自描述（带官方文档链接）─────────────────────────────────────
  endpoints(): { id: string; summary: string; doc_url: string; path_verified: boolean }[] {
    return this.client.listEndpoints();
  }
  describe(endpointId: string): ManifestEndpoint {
    return this.client.describe(endpointId);
  }
  docUrl(endpointId: string): string {
    return this.client.docUrl(endpointId);
  }
  /** 人话帮助：summary + method path + 必填/可选参数 + 官方链接。无 id 则列全部端点一行摘要。 */
  help(endpointId?: string): string {
    if (!endpointId) {
      return this.endpoints()
        .map((e) => `${e.id.padEnd(22)} ${e.summary}  (${e.doc_url})`)
        .join("\n");
    }
    const ep = this.describe(endpointId);
    const req = Object.entries(ep.required_params ?? {}).map(([k, t]) => `${k}:${t}`).join(", ") || "—";
    const opt = Object.keys(ep.optional_params ?? {}).join(", ") || "—";
    return [
      `${ep.id} —— ${ep.summary ?? ""}`,
      `  ${ep.method ?? ""} ${ep.path}`,
      `  必填: ${req}`,
      `  可选: ${opt}`,
      `  文档: ${this.docUrl(endpointId)}`,
    ].join("\n");
  }

  // ── 泛化调用 ───────────────────────────────────────────────────────────
  /** 调一个端点并归一化结果。失败时附该端点 docUrl，便于排查通用错误（如「操作失败请反馈管理员」）。 */
  async call(endpointId: string, params: Record<string, unknown> = {}): Promise<DfResult> {
    const res = await this.client.call(endpointId, params);
    if (res.status !== "success") {
      const code = mapErrorCode(res.error_code);
      return {
        ok: false,
        code,
        message: res.error_message ?? "unknown",
        retryable: code === "openapi_http_error",
        docUrl: safeDocUrl(this.client, endpointId),
        warnings: res.warnings ?? [],
      };
    }
    return { ok: true, result: normalizeOpenApiData(res.data) ?? genericResult(res.data), warnings: res.warnings ?? [] };
  }

  /** 逃生口：返回未归一化的原始 APIResult（要 data 原貌时用）。 */
  raw(endpointId: string, params: Record<string, unknown> = {}): Promise<APIResult> {
    return this.client.call(endpointId, params);
  }

  // ── 类型化分组方法（参数强类型；JSDoc @see 官方文档）────────────────────

  readonly dashboards = {
    /** 列出账号可见的看板与报表。@see https://www.volcengine.com/docs/84129/1285228?lang=zh */
    list: (p: P.DashboardListParams = {}): Promise<DfResult> => this.call("dashboard.list", { ...p }),
    /** 列出某看板下的报表。@see https://www.volcengine.com/docs/84129/1285220?lang=zh */
    reports: (p: P.DashboardReportsParams): Promise<DfResult> => this.call("dashboard.reports", { ...p }),
  };

  readonly reports = {
    /** 查询某个已存在报表算好的数据。@see https://www.volcengine.com/docs/84129/1285240?lang=zh */
    query: (p: P.ReportQueryParams): Promise<DfResult> => this.call("report.query", { ...p }),
  };

  readonly analysis = {
    /**
     * 事件分析 DSL 查询。火山要求：DSL 字段铺在请求体顶层 + app_ids|project_ids 限定范围。
     * 本方法自动铺平 p.dsl 并注入范围（不要把 dsl 包成 {dsl:{...}}）。
     * @see https://www.volcengine.com/docs/84129/1285239?lang=zh
     */
    query: (p: P.AnalysisQueryParams): Promise<DfResult> =>
      this.call("analysis.query", {
        ...p.dsl,
        ...(p.app_ids ? { app_ids: p.app_ids } : {}),
        ...(p.project_ids ? { project_ids: p.project_ids } : {}),
        ...(p.timezone ? { timezone: p.timezone } : {}),
      }),
    /** 按 result_id 取异步分析结果。@see https://www.volcengine.com/docs/84129/1285232?lang=zh */
    result: (p: P.AnalysisResultParams): Promise<DfResult> => this.call("analysis.result", { ...p }),
    /** 导出大规模分组结果。@see https://www.volcengine.com/docs/84129/1285237?lang=zh */
    download: (p: P.AnalysisDownloadParams): Promise<DfResult> => this.call("analysis.download", { ...p }),
  };

  readonly metadata = {
    /** 查元数据（事件/属性等）。@see https://www.volcengine.com/docs/84129/1285285?lang=zh */
    query: (p: P.MetadataQueryParams = {}): Promise<DfResult> => this.call("metadata.query", { ...p }),
  };

  readonly users = {
    /** 用户/设备画像。@see https://www.volcengine.com/docs/84129/1285261?lang=zh */
    profile: (p: P.UserProfileParams): Promise<DfResult> => this.call("user.profile", { ...p }),
    /** 用户行为流。@see https://www.volcengine.com/docs/84129/1285271?lang=zh */
    behaviorFlow: (p: P.UserBehaviorFlowParams): Promise<DfResult> => this.call("user.behavior_flow", { ...p }),
    /** 创建用户名单查询。@see https://www.volcengine.com/docs/84129/1285287?lang=zh */
    createQuery: (p: P.UserQueryCreateParams): Promise<DfResult> => this.call("user.query_create", { ...p }),
    /** 取用户名单结果。@see https://www.volcengine.com/docs/84129/1285291?lang=zh */
    queryResult: (p: P.UserQueryResultParams): Promise<DfResult> => this.call("user.query_result", { ...p }),
  };

  readonly segments = {
    /** 取分群样本用户。@see https://www.volcengine.com/docs/6285/1738909?lang=zh */
    sample: (p: P.SegmentQueryParams): Promise<DfResult> => this.call("segment.query", { ...p }),
  };

  readonly tags = {
    /** 用户标签 V1.0。@see https://www.volcengine.com/docs/84129/1285265?lang=zh */
    v1: (p: P.TagV1Params): Promise<DfResult> => this.call("tag.v1", { ...p }),
    /** 用户标签 V2.0。@see https://www.volcengine.com/docs/84129/1285263?lang=zh */
    v2: (p: P.TagV2Params): Promise<DfResult> => this.call("tag.v2", { ...p }),
  };

  readonly rawEvents = {
    /** 原始事件离线导出。@see https://www.volcengine.com/docs/84129/1285221?lang=zh */
    exports: (p: P.RawEventExportParams = {}): Promise<DfResult> => this.call("raw_event.export", { ...p }),
  };

  readonly usage = {
    /** 用量/计费统计。@see https://www.volcengine.com/docs/84129/1285274?lang=zh */
    stats: (p: P.UsageStatsParams): Promise<DfResult> => this.call("usage.stats", { ...p }),
  };
}

/** 由配置（或注入的客户端）创建 SDK 实例。 */
export function createDataFinderSDK(configOrClient: DataFinderConfig | DataFinderClient): DataFinderSDK {
  return new DataFinderSDK(configOrClient);
}

function safeDocUrl(client: DataFinderClient, endpointId: string): string | undefined {
  try {
    return client.docUrl(endpointId);
  } catch {
    return undefined;
  }
}
