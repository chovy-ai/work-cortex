/**
 * 中心化应用配置加载器。
 *
 * 所有「接入一个新应用时需要改的非密配置」都集中在仓库根的 `app.config.json`，
 * 由本模块统一读取/校验/解析路径。知识抽取链路（extract_events / extract_data_model /
 * check_freshness / sync_*.sh）都从这里取值，不再各自硬编码应用仓库路径与目录。
 *
 * 凭据（AK/SK/app_id 等）仍单独放在 `.env.local`，不进本文件。
 * 字段说明见仓库根的 `app.config.md`。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AppConfig {
  app: {
    /** 被分析应用的名字，例如 "your-app"，用于日志/产物标识。 */
    name: string;
    repo: {
      /** 应用 monorepo 的 git 地址，sync 脚本在本地不存在时用它 clone。 */
      url: string;
      /** 应用 monorepo 的本地路径；相对路径相对 data-analysis 根目录解析。 */
      localPath: string;
    };
  };
  sources: {
    /** 事件目录抽取（extract_events）需要扫描的源码位置，均相对应用 repo 根。 */
    events: {
      tsReporters: string;
      goEvents: string;
      mainAnalytics: string;
      /** 反向符号索引时扫描的顶层目录（相对应用 repo 根）。 */
      scope: { ts: string[]; go: string[] };
    };
    /** 数据模型抽取（extract_data_model）读取的文件，均相对应用 repo 根。 */
    dataModel: {
      defaults: string;
      reporter: string;
      trackingDoc: string;
    };
  };
  /** 生成产物的落盘路径，均相对 data-analysis 根目录。 */
  output: {
    eventCatalog: string;
    dataModel: string;
  };
}

/** "~" / "~/..." 展开为绝对路径。 */
function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * 从给定目录向上查找 data-analysis 根：以含有 `app.config.json`（本地配置）
 * 或 `app.config.example.json`（提交的模板）为准，
 * 兼容从源码（domains/…）和编译产物（build/domains/…）两种运行位置，
 * 也兼容刚 clone、还没 cp 出 app.config.json 的情况。
 */
export function dataAnalysisRoot(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (
      fs.existsSync(path.join(dir, "app.config.json"))
      || fs.existsSync(path.join(dir, "app.config.example.json"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        "找不到 app.config.json / app.config.example.json（data-analysis 根）。请在仓库内运行。",
      );
    }
    dir = parent;
  }
}

let cached: { root: string; config: AppConfig } | null = null;

/** 读取并校验 app.config.json。重复调用走缓存。 */
export function loadAppConfig(root: string = dataAnalysisRoot()): AppConfig {
  if (cached && cached.root === root) {
    return cached.config;
  }
  const file = path.join(root, "app.config.json");
  if (!fs.existsSync(file)) {
    throw new Error(
      `缺少 ${file}。请先复制模板：cp app.config.example.json app.config.json，再按 app.config.md 填写。`,
    );
  }
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`读取/解析 ${file} 失败：${String(err)}`);
  }
  for (const keyPath of [
    "app.name",
    "app.repo.url",
    "app.repo.localPath",
    "sources.events.tsReporters",
    "sources.events.goEvents",
    "sources.events.mainAnalytics",
    "sources.dataModel.defaults",
    "sources.dataModel.reporter",
    "sources.dataModel.trackingDoc",
    "output.eventCatalog",
    "output.dataModel",
  ]) {
    let cur = raw;
    for (const seg of keyPath.split(".")) cur = cur?.[seg];
    if (cur === undefined || cur === null) {
      throw new Error(`app.config.json 缺少必填字段 "${keyPath}"`);
    }
  }
  cached = { root, config: raw as AppConfig };
  return cached.config;
}

/**
 * 解析被分析应用 repo 的绝对路径。优先级：
 *   显式 override > 环境变量 APP_REPO_PATH > app.config.json 的 repo.localPath。
 */
export function resolveTargetRepo(
  override: string | null = null,
  root: string = dataAnalysisRoot(),
): string {
  const fromEnv = process.env["APP_REPO_PATH"];
  const raw = override ?? fromEnv ?? loadAppConfig(root).app.repo.localPath;
  const expanded = expandUser(raw);
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/** data-analysis 根下的产物/资源绝对路径。 */
export function resolveOutput(relFromRoot: string, root: string = dataAnalysisRoot()): string {
  return path.join(root, relFromRoot);
}

/** 从 .env.local 读单个键（缺文件/缺键返回 null）。只为占位符替换取非密标识，不暴露 AK/SK。 */
function readEnvValue(root: string, key: string): string | null {
  try {
    for (const rawLine of fs.readFileSync(path.join(root, ".env.local"), "utf-8").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const idx = line.indexOf("=");
      if (line.slice(0, idx).trim() === key) return line.slice(idx + 1).trim();
    }
  } catch {
    /* 没有 .env.local：保持占位符原样 */
  }
  return null;
}

/**
 * 把协议/提示词里的应用占位符替换成真实配置值，让 LLM（及面向用户的方案卡片）看到真值
 * 而非 `<your-app-id>`。取不到对应配置时保持占位符原样（不抛错、不伪造）。
 *   `<your-app-id>`   → .env.local 的 DATAFINDER_APP_ID
 *   `<your-app-name>` → app.config.json 的 app.name
 */
export function fillAppPlaceholders(text: string, root: string = dataAnalysisRoot()): string {
  let out = text;
  const appId = readEnvValue(root, "DATAFINDER_APP_ID");
  if (appId) out = out.replaceAll("<your-app-id>", appId);
  try {
    const name = loadAppConfig(root).app.name;
    if (name) out = out.replaceAll("<your-app-name>", name);
  } catch {
    /* app.config.json 不可读：保持占位符原样 */
  }
  return out;
}
