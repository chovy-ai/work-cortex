/**
 * 各 DataFinder 端点的强类型入参（你要的"参数强类型"）。
 *
 * 约定：
 *   - `app_id?` 普遍可选——SDK/client 会按 manifest 在缺省时从配置注入；显式传则覆盖。
 *   - 复杂结构（DSL、condition、analysis、global_filter 等）保持 Record，由调用方按官方文档构造。
 * 每组对应 manifest 里的一个端点，doc_url 见 registry/README。
 */

/** dashboard.list —— 列出账号可见的看板与报表。 */
export interface DashboardListParams {
  app_id?: number;
}

/** dashboard.reports —— 列出某看板下的报表（解析 report_id）。 */
export interface DashboardReportsParams {
  dashboard_id: string;
  app_id?: number;
}

/** report.query —— 查询某个已存在报表算好的数据。 */
export interface ReportQueryParams {
  report_id: string;
  count?: number;
  filter_id?: number;
  global_filter?: Record<string, unknown>;
  app_id?: number;
}

/**
 * analysis.query —— 事件分析 DSL 查询（趋势/分布/留存等）。
 * 注意：火山要求 DSL 字段铺在请求体顶层、并带 app_ids 或 project_ids 限定范围。
 * 这里用结构化入参，SDK 方法会自动铺平 dsl 并注入范围（不要自己包成 {dsl:{...}}）。
 */
export interface AnalysisQueryParams {
  /** 分析 DSL（periods/content/resources/version…）。 */
  dsl: Record<string, unknown>;
  /** 范围：app_ids 或 project_ids 至少给一个。 */
  app_ids?: number[];
  project_ids?: number[];
  timezone?: string;
}

/** analysis.result —— 按 result_id 取异步分析结果（私有化部署）。 */
export interface AnalysisResultParams {
  result_id: string;
}

/** analysis.download —— 导出大规模分组结果（CSV/zip）。 */
export interface AnalysisDownloadParams {
  result_id?: string;
  dsl?: Record<string, unknown>;
  app_id?: number;
}

/** metadata.query —— 查元数据：事件/事件属性/用户属性/虚拟事件等。 */
export interface MetadataQueryParams {
  filter?: Record<string, unknown>;
  with?: string[];
  app_id?: number;
}

/** user.profile —— 取单个用户/设备画像、设备信息、最新属性。 */
export interface UserProfileParams {
  query_type: string;
  query_id: string;
  include_tags?: boolean;
  include_device_info?: boolean;
  app_id?: number;
}

/** user.behavior_flow —— 重建某用户在锚点时间附近的事件序列。 */
export interface UserBehaviorFlowParams {
  query_type: string;
  query_id: string;
  timestamp: number;
  orientation: string;
  count: number;
  current_earliest_timestamp?: number;
  app_id?: number;
}

/** user.query_create —— 由用户分析定义创建用户名单查询，返回 query_id。 */
export interface UserQueryCreateParams {
  query_type: string;
  profile_names?: string[];
  id_types?: string[];
  analysis?: Record<string, unknown>;
  cohort?: Record<string, unknown>;
  limit?: number;
  app_id?: number;
}

/** user.query_result —— 取之前创建的用户名单结果。 */
export interface UserQueryResultParams {
  query_id: string;
  app_id?: number;
}

/** segment.query —— 取某分群/cohort 的样本用户。 */
export interface SegmentQueryParams {
  cohort_id: number;
  count: number;
  app_id?: number;
}

/** tag.v1 —— 查询/计算/导出用户标签（Tag V1.0）。 */
export interface TagV1Params {
  tag_name: string;
  type: string;
  condition: Record<string, unknown>;
  period?: Record<string, unknown>;
  app_id?: number;
}

/** tag.v2 —— 查询用户标签（Tag V2.0，需租户/项目头）。 */
export interface TagV2Params {
  tenant_id: string;
  id: number;
  showNum: number;
  startDate: string;
  endDate: string;
}

/** raw_event.export —— 列出/创建原始事件离线导出任务。 */
export interface RawEventExportParams {
  begin_date?: string;
  end_date?: string;
  app_id?: number;
}

/** usage.stats —— 查 DataFinder 用量/计费统计。 */
export interface UsageStatsParams {
  app_ids: number[];
  start_time: number;
  end_time: number;
  org_id?: string;
}
