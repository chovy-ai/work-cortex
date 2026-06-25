/** 归一化结果与错误码。 */

/** 调用结果：成功带归一化 result，失败带 code/message（并尽量附官方文档链接，便于排查）。 */
export type DfResult =
  | { ok: true; result: Record<string, unknown>; warnings: string[] }
  | {
      ok: false;
      code: string;
      message: string;
      retryable: boolean;
      docUrl?: string;
      warnings: string[];
    };

/** client 的 error_code → 归一化 code。 */
export function mapErrorCode(code: string | null | undefined): string {
  switch (code) {
    case "auth_failed":
    case "openapi_auth_failed":
      return "openapi_auth_failed";
    case "http_error":
    case "openapi_http_error":
      return "openapi_http_error";
    case "endpoint_not_in_manifest":
    case "missing_required_params":
    case "business_error":
    case "openapi_business_error":
      return "openapi_business_error";
    default:
      return "unknown_error";
  }
}
