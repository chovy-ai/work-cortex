/**
 * 从 manifest.json 生成 README.md —— 对外的端点总览 + 官方文档链接。
 * 运行：npm run gen:readme（会先 build）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest, ManifestEndpoint } from "../src/client.js";

// dist/scripts/gen-readme.js → 包根
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "manifest.json"), "utf-8")) as Manifest;

function paramsCell(p?: Record<string, string>): string {
  const entries = Object.entries(p ?? {});
  return entries.length ? entries.map(([k, t]) => `\`${k}:${t}\``).join(" ") : "—";
}

function endpointRows(): string {
  return (manifest.endpoints as ManifestEndpoint[])
    .map((e) => {
      const doc = e.doc_url ? `[文档](${e.doc_url})` : "—";
      return `| \`${e.id}\` | ${e.summary ?? ""} | ${e.method ?? ""} \`${e.path}\` | ${paramsCell(e.required_params)} | ${doc} |`;
    })
    .join("\n");
}

const docRoot = manifest.global?.doc_root ?? "https://www.volcengine.com/docs/84129";

const md = `<!-- 本文件由 scripts/gen-readme.ts 从 manifest.json 自动生成，勿手改。 -->
# @workcortex/datafinder-sdk

火山引擎 DataFinder OpenAPI 的灵活 SDK：**manifest 驱动、自描述、每个端点自带官方文档链接**。

- 官方文档根：${docRoot}
- 端点数：${(manifest.endpoints as ManifestEndpoint[]).length}

## 安装与配置（配置注入）

\`\`\`ts
import { createDataFinderSDK, loadConfigFromEnv } from "@workcortex/datafinder-sdk";

// 配置无关：调用方传入 .env.local 路径（或直接构造 DataFinderConfig 对象）
const sdk = createDataFinderSDK(loadConfigFromEnv("/abs/path/.env.local"));
\`\`\`

\`.env.local\` 需含：\`DATAFINDER_BASE_URL\` / \`DATAFINDER_ACCESS_KEY\` / \`DATAFINDER_SECRET_KEY\` / \`DATAFINDER_APP_ID\`（可选 \`DATAFINDER_PROJECT_ID\` / \`DATAFINDER_REGION\` / \`DATAFINDER_SERVICE\`）。

## 三种用法

\`\`\`ts
// 1) 发现 / 自描述（带官方文档链接）
sdk.endpoints();                 // 全部端点摘要 + doc_url
sdk.help("report.query");        // 人话：说明 + 参数 + 官方链接
sdk.docUrl("analysis.query");    // → 官方文档 URL

// 2) 类型化分组方法（参数强类型，JSDoc @see 官方文档）
await sdk.reports.query({ report_id: "123", count: 10 });
await sdk.analysis.query({ dsl });

// 3) 泛化调用（覆盖所有/未来端点）；raw() 取原始响应
await sdk.call("metadata.query", { filter: {} });   // 归一化 DfResult，错误带 docUrl
await sdk.raw("report.query", { report_id: "123" }); // 原始 APIResult
\`\`\`

结果 \`DfResult\`：成功 \`{ ok:true, result }\`（result 为 table/records/scalar/empty），失败 \`{ ok:false, code, message, docUrl, retryable }\` —— 错误自带官方文档链接便于排查。

## 端点一览

| 端点 | 说明 | 方法 路径 | 必填参数 | 官方文档 |
|---|---|---|---|---|
${endpointRows()}

> 加端点：在 \`manifest.json\` 按官方文档登记（见 UPDATE.md），重跑 \`npm run gen:readme\`。
`;

writeFileSync(join(PKG_ROOT, "README.md"), md, "utf-8");
process.stdout.write(`Wrote README.md (${(manifest.endpoints as ManifestEndpoint[]).length} endpoints)\n`);
