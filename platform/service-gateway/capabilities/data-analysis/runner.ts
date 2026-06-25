import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResultChart, ResultTable, RunnerFn, Task, TaskEventDraft } from "../../core/contracts.js";
import type { Logger } from "../../core/log.js";

// persona / 沉淀的表情用法与编译产物同级的源码目录（不参与编译）：
// dist/capabilities/data-analysis/runner.js → 上 3 层到包根 → capabilities/data-analysis/
const CAP_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "capabilities", "data-analysis");
const PERSONA_PATH = join(CAP_DIR, "persona.md");
const EMOJI_LEARNED_PATH = join(CAP_DIR, "emoji-learned.md");

/** 读 bot 嗓音/口吻（persona.md + 机器沉淀的表情用法），注入调度器上下文供报告叙述用。缺失返回空串。 */
function loadPersona(): string {
  let text = "";
  try {
    text = readFileSync(PERSONA_PATH, "utf-8").trim();
  } catch {
    return "";
  }
  try {
    text += "\n\n" + readFileSync(EMOJI_LEARNED_PATH, "utf-8").trim();
  } catch {
    /* 还没沉淀过，正常 */
  }
  return text;
}

export interface SchedulerRunnerOpts {
  /** 分析能力本体根目录（含 build/ 与 outputs/）。 */
  abilityRoot: string;
  log: Logger;
}

// —— 被驱动的 scheduler 的最小结构（进程内动态 import，故在此本地声明类型）——

interface SchedulerState {
  run_id: string;
  current_step: string;
  context: Record<string, any>;
  status: string; // running | awaiting_input | completed | failed
  awaiting_step: string | null;
  await_payload: Record<string, any>;
  history: Record<string, any>[];
}

interface StepInfo {
  step_id: string;
  label: string;
  kind: string;
}

interface SchedulerInstance {
  new_state(context?: Record<string, any> | null, run_id?: string | null): SchedulerState;
  resume(run_id: string): SchedulerState;
  provide_input(state: SchedulerState, payload: Record<string, any>): SchedulerState;
  run(state: SchedulerState, opts?: { onStep?: (info: StepInfo) => void; signal?: AbortSignal }): Promise<SchedulerState>;
}

interface SchedulerModule {
  StepScheduler: new () => SchedulerInstance;
}

/**
 * 06 · data-analysis 能力：进程内驱动查询执行域的声明式 step 调度器。
 *
 * 不再拉起一个自由发挥的 ACP agent 读 SKILL.md——分析流程由 scheduler 的 step 图强制执行，
 * 需要 LLM 的步骤（understand / prepare / 评审 / 叙述）各自经 atomic-abilities 自取 Claude。
 *   - 逐步 onStep → progress（用 workflow.json 的中文 label，讲清「在干嘛」）；
 *   - await_input → ask（人在环 gate，由 gateway 问用户、回复经 task.resume 续跑）；
 *   - 终态 report → result；失败 → error。
 * state 按 run_id 持久化在 outputs/<run_id>/state.json，resume 据此恢复。
 */
export function createSchedulerRunner(opts: SchedulerRunnerOpts): RunnerFn {
  const { abilityRoot, log } = opts;
  const persona = loadPersona(); // 进程级读一次：嗓音很少变，改文件重启即可
  const schedulerUrl = pathToFileURL(
    join(abilityRoot, "build", "domains", "query-execution", "scheduler", "scheduler.js"),
  ).href;
  let modPromise: Promise<SchedulerModule> | null = null;
  const loadModule = (): Promise<SchedulerModule> => (modPromise ??= import(schedulerUrl) as Promise<SchedulerModule>);

  return async (task: Task, emit: (d: TaskEventDraft) => void, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return;

    let mod: SchedulerModule;
    try {
      mod = await loadModule();
    } catch (err) {
      log("error", "runner.scheduler", "cannot load scheduler build", { run_id: task.run_id, error: String(err) });
      emit({ kind: "error", reason: "分析引擎未就绪（build 缺失？先 npm run build）", retriable: false });
      return;
    }
    const scheduler = new mod.StepScheduler();

    // —— 建/恢复 state ——
    let state: SchedulerState;
    if (task.resume) {
      try {
        state = scheduler.resume(task.run_id);
      } catch (err) {
        log("error", "runner.scheduler", "resume failed", { run_id: task.run_id, error: String(err) });
        emit({ kind: "error", reason: "找不到待恢复的分析任务", retriable: false });
        return;
      }
      // 用户取消 gate → 直接收尾，不再续跑
      if (task.resume.action_id === "cancel") {
        emit({ kind: "result", summary: "好的，已取消本次分析。", tables: [], charts: [] });
        return;
      }
      try {
        scheduler.provide_input(state, resumePayload(task, state));
      } catch (err) {
        log("error", "runner.scheduler", "provide_input failed", { run_id: task.run_id, error: String(err) });
        emit({ kind: "error", reason: "无法恢复分析任务状态", retriable: false });
        return;
      }
    } else {
      state = scheduler.new_state({ text: task.input.text, persona }, task.run_id);
    }

    // —— 跑 ——
    emit({ kind: "progress", status: "正在分析…" });
    try {
      state = await scheduler.run(state, {
        signal,
        onStep: (info) => {
          log("debug", "runner.scheduler", "step", { run_id: task.run_id, step: info.step_id });
          emit({ kind: "progress", status: info.label, detail: info.step_id });
        },
      });
    } catch (err) {
      log("error", "runner.scheduler", "scheduler threw", { run_id: task.run_id, error: String(err) });
      emit({ kind: "error", reason: `分析执行出错：${truncate(String(err), 200)}`, retriable: false });
      return;
    }

    if (signal.aborted) return; // 终态由 runtime 补 synthetic error

    // —— 终态映射 ——
    switch (state.status) {
      case "completed":
        emit(buildResult(state, task));
        return;
      case "awaiting_input":
        emit(buildAsk(state));
        return;
      case "failed": {
        const msg = lastMessage(state) ?? "分析未能完成";
        emit({ kind: "error", reason: msg, retriable: false });
        return;
      }
      default:
        // running 但循环退出 = 被 abort（signal 已在上面拦截）；其余视为异常
        emit({ kind: "error", reason: "分析未产出终态", retriable: false });
        return;
    }
  };
}

/** task.resume → scheduler.provide_input 的 payload，依挂起的 step 解释。 */
function resumePayload(task: Task, state: SchedulerState): Record<string, any> {
  const params = task.resume?.params ?? {};
  if (state.awaiting_step === "understand") {
    // 澄清：用户回复的自由文本（连接器放在 params.text）作为补充信息
    return { answer: String(params["text"] ?? "") };
  }
  // 方案确认 gate：confirm → 通过；其余（revise）→ 要求修改，带上用户补充
  return task.resume?.action_id === "confirm" ? { status: "confirmed" } : { status: "changes", ...params };
}

/** completed → result：report 叙述拼 markdown + 图表 + 结果表。 */
function buildResult(state: SchedulerState, task: Task): TaskEventDraft {
  const report = (state.context["report"] ?? {}) as {
    summary?: string | null;
    highlights?: string[];
    caveats?: string | null;
    execution_result?: any;
  };
  const lines: string[] = [];
  if (report.summary) lines.push(report.summary);
  for (const h of report.highlights ?? []) lines.push(`- ${h}`);
  if (report.caveats) lines.push(`\n口径说明：${report.caveats}`);
  const summary = lines.join("\n").trim() || "分析完成，但未生成可读结论。";

  const charts: ResultChart[] = (state.context["charts"] ?? [])
    .map((c: any) => ({ image_path: c?.path ?? c?.image_path }))
    .filter((c: ResultChart) => Boolean(c.image_path));

  return {
    kind: "result",
    summary,
    tables: extractTables(report.execution_result),
    charts,
    artifacts_dir: `outputs/${task.run_id}`,
  };
}

/** execution_result.result（table / records）→ ResultTable[]。 */
function extractTables(er: any): ResultTable[] {
  const r = er?.result;
  if (!r) return [];
  if (r.kind === "table" && Array.isArray(r.columns) && Array.isArray(r.rows)) {
    return [{ columns: r.columns, rows: r.rows }];
  }
  if (r.kind === "records" && Array.isArray(r.records) && r.records.length) {
    const columns = Object.keys(r.records[0]);
    const rows = r.records.map((rec: Record<string, unknown>) => columns.map((c) => (rec[c] ?? null) as string | number | null));
    return [{ columns, rows }];
  }
  return [];
}

/** awaiting_input → ask：依挂起 step 拼问题与选项。 */
function buildAsk(state: SchedulerState): TaskEventDraft {
  const p = state.await_payload ?? {};
  if (state.awaiting_step === "understand") {
    return { kind: "ask", prompt: String(p["clarification_question"] ?? "需要更多信息才能继续"), options: [] };
  }
  // raw.user_review：把方案卡片摊给用户确认（展示真实取数计划，而非占位）
  const card = (p["review_card"] ?? {}) as {
    metric?: string | null; aggregation?: string | null; identity?: string | null;
    data_source?: string | null; event_set?: unknown; time_range?: string | null;
    granularity?: string | null; breakdowns?: unknown; notes?: string | null; warnings?: string[];
  };
  return { kind: "ask", prompt: renderReviewCard(card), options: ["确认", "修改", "取消"] };
}

/** 把方案卡片渲染成用户能看懂的「打算怎么取数」。空字段省略，未知值原样展示。 */
function renderReviewCard(card: {
  metric?: string | null; aggregation?: string | null; identity?: string | null;
  data_source?: string | null; event_set?: unknown; time_range?: string | null;
  granularity?: string | null; breakdowns?: unknown; notes?: string | null; warnings?: string[];
}): string {
  const SOURCE: Record<string, string> = {
    analysis_query: "DataFinder 分析查询", kafka: "Kafka 原始事件", local: "本地文件",
  };
  const TIME: Record<string, string> = {
    yesterday: "昨天", today: "今天", last_7_days: "最近 7 天", last_30_days: "最近 30 天",
  };
  const GRAN: Record<string, string> = { day: "按天", hour: "按小时", week: "按周", month: "按月" };
  const evs = Array.isArray(card.event_set) ? (card.event_set as string[]) : [];
  const eventText = evs.length === 0 ? null : evs.includes("*") ? "全部事件" : evs.join("、");
  const bds = Array.isArray(card.breakdowns) ? (card.breakdowns as string[]) : [];

  const lines = ["请确认本次分析方案："];
  if (card.metric) {
    // identity 后缀仅在聚合口径未提及它时补充，避免「count(distinct device_id)(device_id)」重复
    const idSuffix = card.identity && !(card.aggregation ?? "").includes(card.identity) ? `（按 ${card.identity}）` : "";
    const agg = card.aggregation ? `，口径 ${card.aggregation}${idSuffix}` : "";
    lines.push(`· 指标：${card.metric}${agg}`);
  }
  if (card.data_source) lines.push(`· 数据源：${SOURCE[card.data_source] ?? card.data_source}`);
  if (eventText) lines.push(`· 事件范围：${eventText}`);
  if (card.time_range || card.granularity) {
    const t = card.time_range ? (TIME[card.time_range] ?? card.time_range) : "";
    const g = card.granularity ? `（${GRAN[card.granularity] ?? card.granularity}）` : "";
    lines.push(`· 时间：${t}${g}`);
  }
  if (bds.length) lines.push(`· 拆分维度：${bds.join("、")}`);
  if (card.notes) lines.push(`· 说明：${card.notes}`);
  if (card.warnings?.length) lines.push(`· 注意：${card.warnings.join("；")}`);
  // 「请回复：确认/修改/取消」由 sessions 的 ask 渲染统一追加，这里不再重复。
  return lines.join("\n");
}

function lastMessage(state: SchedulerState): string | null {
  const last = state.history.at(-1);
  const msg = last?.["message"];
  return typeof msg === "string" && msg.trim() ? msg.trim() : null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
