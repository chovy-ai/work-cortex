import test from "node:test";
import assert from "node:assert/strict";
import { Sessions, RECEIPT_TEXT, RECEIPT_QUEUED_TEXT, OVERFLOW_TEXT, PROGRESS_PREFIX, RECEIPT_REACTION } from "../core/sessions.js";
import { silentLogger } from "../core/log.js";
import type { ConnectorPort, Conversation, Envelope, Task, TaskEvent } from "../core/contracts.js";

function env(id: string, opts: Partial<{ chatId: string; type: "p2p" | "group"; kind: Envelope["kind"]; text: string }> = {}): Envelope {
  return {
    v: 1,
    event_id: id,
    dedup_key: `lark:${id}`,
    channel: "lark",
    received_at: new Date().toISOString(),
    conversation: { id: opts.chatId ?? "oc_1", thread_id: null, type: opts.type ?? "p2p", source_message_id: `om_${id}` },
    principal: { channel_user_id: "ou_1" },
    kind: opts.kind ?? "message",
    message: opts.kind === undefined || opts.kind === "message" ? { text: opts.text ?? "q" } : undefined,
    action: opts.kind === "action" ? { run_id: "run_x", action_id: "confirm" } : undefined,
    raw_ref: null,
  };
}

function harness(pendingLimit = 10) {
  const submitted: Task[] = [];
  const sent: { kind: "text" | "result"; conv: Conversation; body: string }[] = [];
  const sender: ConnectorPort = {
    async sendText(conv, text) {
      sent.push({ kind: "text", conv, body: text });
    },
    async sendResult(conv, _runId, summary) {
      sent.push({ kind: "result", conv, body: summary });
    },
  };
  const sessions = new Sessions({
    capabilityId: "data-analysis",
    timeoutSec: 600,
    pendingLimit,
    terminalKeep: 512,
    submit: (t) => submitted.push(t),
    sender,
    log: silentLogger,
  });
  const resultEvent = (runId: string, summary = "答案"): TaskEvent => ({
    v: 1, run_id: runId, seq: 1, at: new Date().toISOString(), kind: "result", summary, tables: [], charts: [],
  });
  const errorEvent = (runId: string, reason = "炸了"): TaskEvent => ({
    v: 1, run_id: runId, seq: 1, at: new Date().toISOString(), kind: "error", reason,
  });
  const replies = () =>
    sent.filter(
      (m) =>
        !m.body.startsWith(RECEIPT_TEXT) &&
        !m.body.startsWith(RECEIPT_QUEUED_TEXT) &&
        !m.body.startsWith(OVERFLOW_TEXT) &&
        !m.body.startsWith(PROGRESS_PREFIX),
    );
  return { sessions, submitted, sent, replies, resultEvent, errorEvent };
}

const tick = () => new Promise((r) => setImmediate(r));

test("receipt reaction lifecycle: 💪 only when processing starts (first progress), removed before reply", async () => {
  // 带 react/unreact 的 sender：收到不贴 → 首个 progress 才贴 → 回复前撤掉 → 再发结果
  const order: string[] = [];
  const submitted: Task[] = [];
  const sender = {
    async sendText(_c: Conversation, t: string) {
      order.push(`text:${t.slice(0, 6)}`);
    },
    async sendResult() {
      order.push("result");
    },
    async react(_c: Conversation, emoji: string) {
      order.push(`react:${emoji}`);
      return "rid_1";
    },
    async unreact(_c: Conversation, handle: string) {
      order.push(`unreact:${handle}`);
    },
  };
  const s1 = new Sessions({
    capabilityId: "data-analysis", timeoutSec: 600, pendingLimit: 10, terminalKeep: 512,
    submit: (t) => submitted.push(t), sender, log: silentLogger,
  });
  s1.handleEnvelope(env("r1"));
  await tick();
  assert.equal(order.length, 0, "收到时不贴表情");
  // 真正开跑：首个 progress → 贴表情
  s1.handleEvent({ v: 1, run_id: submitted[0].run_id, seq: 0, at: new Date().toISOString(), kind: "progress", status: "正在分析…" });
  await tick();
  assert.ok(order.some((o) => o === `react:${RECEIPT_REACTION}`), "首个 progress 才贴表情");
  // 结果：撤表情 → 再发结果（撤在回复之前）
  s1.handleEvent({ v: 1, run_id: submitted[0].run_id, seq: 1, at: new Date().toISOString(), kind: "result", summary: "答案", tables: [], charts: [] });
  await tick();
  await tick();
  assert.deepEqual(order.slice(-2), ["unreact:rid_1", "result"]);

  // 不带 react 的 sender（harness 默认）：降级文本回执也延迟到首个 progress
  const h = harness();
  h.sessions.handleEnvelope(env("r2"));
  await tick();
  assert.equal(h.sent.filter((m) => m.body.startsWith(RECEIPT_TEXT)).length, 0, "收到时无文本回执");
  h.sessions.handleEvent({ v: 1, run_id: h.submitted[0].run_id, seq: 0, at: new Date().toISOString(), kind: "progress", status: "正在分析…" });
  await tick();
  assert.equal(h.sent.filter((m) => m.body.startsWith(RECEIPT_TEXT)).length, 1, "首个 progress 发文本回执");
});

test("p2p message starts run; valid Task submitted", () => {
  const h = harness();
  h.sessions.handleEnvelope(env("e1", { text: "昨天 DAU 多少" }));
  assert.equal(h.submitted.length, 1);
  assert.equal(h.submitted[0].input.text, "昨天 DAU 多少");
  assert.equal(h.submitted[0].capability, "data-analysis");
});

test("same conversation serializes: second message queues, pops after terminal", async () => {
  const h = harness();
  h.sessions.handleEnvelope(env("e1"));
  h.sessions.handleEnvelope(env("e2"));
  h.sessions.handleEnvelope(env("e3"));
  assert.equal(h.submitted.length, 1); // 仅第一条开跑
  h.sessions.handleEvent(h.resultEvent(h.submitted[0].run_id));
  assert.equal(h.submitted.length, 2); // 终态后弹出第二条
  h.sessions.handleEvent(h.errorEvent(h.submitted[1].run_id));
  assert.equal(h.submitted.length, 3); // error 同样推进
  await tick();
  assert.equal(h.replies().filter((s) => s.kind === "result").length, 1);
  assert.equal(h.replies().filter((s) => s.kind === "text").length, 1); // 失败提示
});

test("different conversations run independently", () => {
  const h = harness();
  h.sessions.handleEnvelope(env("a", { chatId: "oc_A" }));
  h.sessions.handleEnvelope(env("b", { chatId: "oc_B" }));
  assert.equal(h.submitted.length, 2);
});

test("pending limit: overflow dropped", () => {
  const h = harness(2);
  h.sessions.handleEnvelope(env("e1"));
  h.sessions.handleEnvelope(env("e2"));
  h.sessions.handleEnvelope(env("e3"));
  h.sessions.handleEnvelope(env("e4")); // 超过 pendingLimit=2，丢弃
  h.sessions.handleEvent(h.resultEvent(h.submitted[0].run_id));
  h.sessions.handleEvent(h.resultEvent(h.submitted[1].run_id));
  h.sessions.handleEvent(h.resultEvent(h.submitted[2].run_id));
  assert.equal(h.submitted.length, 3); // e4 永不出现
});

test("group / action / system ignored", () => {
  const h = harness();
  h.sessions.handleEnvelope(env("g1", { type: "group" }));
  h.sessions.handleEnvelope(env("a1", { kind: "action" }));
  h.sessions.handleEnvelope(env("s1", { kind: "system" }));
  assert.equal(h.submitted.length, 0);
});

test("result delivers summary to origin conversation", async () => {
  const h = harness();
  h.sessions.handleEnvelope(env("e1", { chatId: "oc_origin" }));
  h.sessions.handleEvent(h.resultEvent(h.submitted[0].run_id, "**DAU 1234**"));
  await tick();
  assert.equal(h.replies()[0].kind, "result");
  assert.equal(h.replies()[0].conv.id, "oc_origin");
  assert.equal(h.replies()[0].body, "**DAU 1234**");
});

test("event for unknown or already-terminal run is dropped", async () => {
  const h = harness();
  h.sessions.handleEnvelope(env("e1"));
  const runId = h.submitted[0].run_id;
  h.sessions.handleEvent(h.resultEvent(runId));
  h.sessions.handleEvent(h.resultEvent(runId)); // 终态后重复事件
  h.sessions.handleEvent(h.resultEvent("run_ghost"));
  await tick();
  assert.equal(h.replies().length, 1);
});

test("ask suspends run; 「确认」reply resumes same run_id with confirm payload", async () => {
  const h = harness();
  h.sessions.handleEnvelope(env("e1"));
  const runId = h.submitted[0].run_id;
  // 能力发问（人在环 gate）→ 问题发给用户，run 挂起
  h.sessions.handleEvent({
    v: 1, run_id: runId, seq: 1, at: new Date().toISOString(), kind: "ask", prompt: "确认方案?", options: ["确认", "修改", "取消"],
  });
  await tick();
  assert.equal(h.replies().length, 1);
  assert.match(h.replies()[0].body, /确认方案/);
  assert.match(h.replies()[0].body, /确认 \/ 修改 \/ 取消/); // 选项提示
  // 用户回复「确认」→ 同一 run_id 带 confirm 续跑（不新开 run）
  h.sessions.handleEnvelope(env("e2", { text: "确认" }));
  assert.equal(h.submitted.length, 2);
  assert.equal(h.submitted[1].run_id, runId);
  assert.deepEqual(h.submitted[1].resume, { action_id: "confirm", params: {} });
  // 续跑产出结果 → 正常回复
  h.sessions.handleEvent(h.resultEvent(runId, "**搞定**"));
  await tick();
  assert.ok(h.replies().some((m) => m.kind === "result" && m.body === "**搞定**"));
});

test("clarification (no options): free-text reply resumes as revise with the text", async () => {
  const h = harness();
  h.sessions.handleEnvelope(env("e1"));
  const runId = h.submitted[0].run_id;
  h.sessions.handleEvent({
    v: 1, run_id: runId, seq: 1, at: new Date().toISOString(), kind: "ask", prompt: "你指的是哪个指标?", options: [],
  });
  await tick();
  h.sessions.handleEnvelope(env("e2", { text: "日活" }));
  assert.equal(h.submitted.length, 2);
  assert.equal(h.submitted[1].run_id, runId);
  assert.deepEqual(h.submitted[1].resume, { action_id: "revise", params: { text: "日活" } });
});

test("「取消」reply resumes with cancel", async () => {
  const h = harness();
  h.sessions.handleEnvelope(env("e1"));
  const runId = h.submitted[0].run_id;
  h.sessions.handleEvent({
    v: 1, run_id: runId, seq: 1, at: new Date().toISOString(), kind: "ask", prompt: "确认方案?", options: ["确认", "修改", "取消"],
  });
  await tick();
  h.sessions.handleEnvelope(env("e2", { text: "取消" }));
  assert.equal(h.submitted[1].resume?.action_id, "cancel");
});

test("progress on update-capable channel: first sends a new message, rest update it in place (no spam)", async () => {
  const calls: { op: string; arg: string }[] = [];
  const submitted: Task[] = [];
  const sender = {
    async sendText() {},
    async sendResult() {},
    async sendProgress(_c: Conversation, _r: string, status: string) {
      calls.push({ op: "send", arg: status });
      return "om_progress";
    },
    async updateProgress(_c: Conversation, handle: string, status: string) {
      calls.push({ op: `update:${handle}`, arg: status });
    },
  };
  const s = new Sessions({
    capabilityId: "data-analysis", timeoutSec: 600, pendingLimit: 10, terminalKeep: 512,
    submit: (t) => submitted.push(t), sender, progressIntervalMs: 0, log: silentLogger,
  });
  s.handleEnvelope(env("p1"));
  const runId = submitted[0].run_id;
  const prog = (n: number, status: string): TaskEvent => ({ v: 1, run_id: runId, seq: n, at: new Date().toISOString(), kind: "progress", status });
  s.handleEvent(prog(1, "解析口径"));
  await tick();
  s.handleEvent(prog(2, "执行查询"));
  await tick();
  s.handleEvent(prog(3, "汇总结论"));
  await tick();
  // 仅一条 send（首条），其余原地 update：长任务进度不再每条新增气泡
  assert.equal(calls.filter((c) => c.op === "send").length, 1);
  assert.equal(calls.filter((c) => c.op === "update:om_progress").length, 2);
  assert.equal(calls[0].arg, `${PROGRESS_PREFIX}解析口径`);
  assert.equal(calls[2].arg, `${PROGRESS_PREFIX}汇总结论`);
});

test("follow-up queues, then is reacted only when its turn starts processing (not while queued)", async () => {
  const reacted: string[] = [];
  const submitted: Task[] = [];
  const sender = {
    async sendText() {},
    async sendResult() {},
    async react(c: Conversation, emoji: string) {
      reacted.push(`${c.source_message_id}:${emoji}`);
      return `rid_${c.source_message_id}`;
    },
    async unreact() {},
  };
  const s = new Sessions({
    capabilityId: "data-analysis", timeoutSec: 600, pendingLimit: 10, terminalKeep: 512,
    submit: (t) => submitted.push(t), sender, log: silentLogger,
  });
  s.handleEnvelope(env("q1")); // 开跑
  s.handleEnvelope(env("q2")); // 排队
  await tick();
  assert.equal(submitted.length, 1, "仅 q1 开跑，q2 排队");
  assert.deepEqual(reacted, [], "排队/等槽期间不贴表情");
  // q1 真正开始处理 → 贴 q1 表情
  s.handleEvent({ v: 1, run_id: submitted[0].run_id, seq: 0, at: new Date().toISOString(), kind: "progress", status: "x" });
  await tick();
  assert.deepEqual(reacted, [`om_q1:${RECEIPT_REACTION}`]);
  // q1 完成 → q2 出队开跑
  s.handleEvent({ v: 1, run_id: submitted[0].run_id, seq: 1, at: new Date().toISOString(), kind: "result", summary: "答案", tables: [], charts: [] });
  await tick();
  assert.equal(submitted.length, 2, "q2 接着开跑，未被吞");
  // q2 开始处理 → 贴 q2 表情
  s.handleEvent({ v: 1, run_id: submitted[1].run_id, seq: 0, at: new Date().toISOString(), kind: "progress", status: "x" });
  await tick();
  assert.deepEqual(reacted, [`om_q1:${RECEIPT_REACTION}`, `om_q2:${RECEIPT_REACTION}`], "各自开跑时才贴，q2 未被吞");
});

test("pending overflow notifies the user once per episode", async () => {
  const h = harness(2);
  h.sessions.handleEnvelope(env("e1")); // 开跑
  h.sessions.handleEnvelope(env("e2")); // 队列 [e2]
  h.sessions.handleEnvelope(env("e3")); // 队列 [e2,e3]
  h.sessions.handleEnvelope(env("e4")); // 溢出 → 提示
  h.sessions.handleEnvelope(env("e5")); // 再溢出 → 不重复提示
  const overflowMsgs = h.sent.filter((m) => m.body.startsWith(OVERFLOW_TEXT));
  assert.equal(overflowMsgs.length, 1);
});

test("error reason is humanized for business users", async () => {
  const h = harness();
  h.sessions.handleEnvelope(env("e1"));
  h.sessions.handleEvent(h.errorEvent(h.submitted[0].run_id, "执行超时（600s）"));
  await tick();
  const reply = h.replies()[0];
  assert.equal(reply.kind, "text");
  assert.match(reply.body, /分析失败/);
  assert.doesNotMatch(reply.body, /600s|超时（/); // 工程腔不暴露给用户
});
