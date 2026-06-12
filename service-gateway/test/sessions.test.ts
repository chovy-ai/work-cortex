import test from "node:test";
import assert from "node:assert/strict";
import { Sessions } from "../core/sessions.js";
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
  const replies = () => sent.filter((m) => !m.body.startsWith("\u2705") && !m.body.startsWith("\u23f3"));
  return { sessions, submitted, sent, replies, resultEvent, errorEvent };
}

const tick = () => new Promise((r) => setImmediate(r));

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

test("unexpected ask in M0 fails the run", async () => {
  const h = harness();
  h.sessions.handleEnvelope(env("e1"));
  const runId = h.submitted[0].run_id;
  h.sessions.handleEvent({
    v: 1, run_id: runId, seq: 1, at: new Date().toISOString(), kind: "ask", prompt: "确认?", options: ["confirm"],
  });
  await tick();
  assert.equal(h.replies().length, 1);
  assert.equal(h.replies()[0].kind, "text");
  assert.match(h.replies()[0].body, /不支持/);
});
