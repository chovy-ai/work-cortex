/**
 * ability 侧 DataFinder 适配层。
 *
 * DataFinder 的 SDK 已抽离为独立包 `@workcortex/datafinder-sdk`（manifest 驱动、自描述、
 * 自带官方文档链接）。本模块只做一件事：把**本应用**的 `.env.local` 凭据注入 SDK，
 * 暴露进程内单例。steps 只从这里取 SDK / 配置，不直接碰包内细节或凭据路径。
 *
 * 发现/调用/类型化方法见 SDK：dataFinder().endpoints()/describe()/docUrl()/help()、
 * dataFinder().call()/raw()、dataFinder().reports.query() 等。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDataFinderSDK,
  loadConfigFromEnv,
  type DataFinderSDK,
  type DataFinderConfig,
} from "@workcortex/datafinder-sdk";

// build/domains/datafinder-interface/index.js → ability 根（上 3 层）；凭据在 ability 根 .env.local
const ABILITY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENV_PATH = join(ABILITY_ROOT, ".env.local");

let _config: DataFinderConfig | null = null;
let _sdk: DataFinderSDK | null = null;

/** 本应用 DataFinder 配置（.env.local），进程内缓存。compile 取 app_id/project_id 用。 */
export function dataFinderConfig(): DataFinderConfig {
  return (_config ??= loadConfigFromEnv(ENV_PATH));
}

/** 配置注入后的 SDK 单例。 */
export function dataFinder(): DataFinderSDK {
  return (_sdk ??= createDataFinderSDK(dataFinderConfig()));
}

export type { DfResult, DataFinderConfig } from "@workcortex/datafinder-sdk";
