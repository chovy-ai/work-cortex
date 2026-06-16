import test from "node:test";
import assert from "node:assert/strict";
import { isValid } from "../core/validate.js";
import { translate } from "../connectors/lark/translate.js";

const validEnvelope = {
  v: 1,
  event_id: "evt_1",
  dedup_key: "lark:evt_1",
  channel: "lark",
  received_at: "2026-06-12T10:00:00.000Z",
  conversation: { id: "oc_x", thread_id: null, type: "p2p", source_message_id: "om_x" },
  principal: { channel_user_id: "ou_x" },
  kind: "message",
  message: { text: "昨天 DAU 多少", attachments: [] },
  raw_ref: null,
};

test("envelope: valid message passes; kind=message without message body fails", () => {
  assert.equal(isValid("envelope", validEnvelope), true);
  const { message: _m, ...noBody } = validEnvelope;
  assert.equal(isValid("envelope", noBody), false);
});

test("envelope: action kind requires action body", () => {
  const action = {
    ...validEnvelope,
    kind: "action",
    action: { run_id: "run_1", action_id: "confirm" },
  };
  assert.equal(isValid("envelope", action), true);
  const { action: _a, ...noAction } = action;
  assert.equal(isValid("envelope", noAction), false);
});

test("task: valid passes; missing limits fails", () => {
  const task = {
    v: 1,
    run_id: "run_1",
    capability: "data-analysis",
    input: { text: "hi" },
    context: { principal: { member: "ou_x" }, conversation_ref: "abc", history: [] },
    resume: null,
    limits: { timeout_s: 600 },
  };
  assert.equal(isValid("task", task), true);
  const { limits: _l, ...noLimits } = task;
  assert.equal(isValid("task", noLimits), false);
});

test("taskEvent: each kind validates its payload", () => {
  const base = { v: 1, run_id: "run_1", seq: 0, at: "2026-06-12T10:00:00.000Z" };
  assert.equal(isValid("taskEvent", { ...base, kind: "progress", status: "查询中" }), true);
  assert.equal(isValid("taskEvent", { ...base, kind: "progress" }), false); // 缺 status
  assert.equal(isValid("taskEvent", { ...base, kind: "result", summary: "ok", tables: [], charts: [] }), true);
  assert.equal(isValid("taskEvent", { ...base, kind: "result", summary: "ok" }), false); // 缺 tables/charts
  assert.equal(isValid("taskEvent", { ...base, kind: "error", reason: "boom" }), true);
  assert.equal(isValid("taskEvent", { ...base, kind: "ask", prompt: "确认?", options: ["confirm"] }), true);
  assert.equal(isValid("taskEvent", { ...base, kind: "signal", type: "knowledge_gap" }), true);
});

test("translate: lark im.message.receive_v1 → valid Envelope", () => {
  const raw = {
    schema: "2.0",
    header: { event_id: "evt_abc", event_type: "im.message.receive_v1", create_time: "1760000000000" },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: "ou_zhang" } },
      message: {
        message_id: "om_123",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 昨天 DAU 多少" }),
        mentions: [{ key: "@_user_1", name: "bot" }],
      },
    },
  };
  const env = translate(raw);
  assert.ok(env);
  assert.equal(isValid("envelope", env), true);
  assert.equal(env!.message!.text, "昨天 DAU 多少"); // mention 已剥
  assert.equal(env!.dedup_key, "lark:evt_abc");
  assert.equal(env!.conversation.source_message_id, "om_123");
});

test("translate: bot/app sender and non-message events → null", () => {
  assert.equal(
    translate({ header: { event_id: "e", event_type: "im.message.receive_v1" }, event: { sender: { sender_type: "app" } } }),
    null,
  );
  assert.equal(translate({ header: { event_id: "e", event_type: "card.action.trigger" } }), null);
  assert.equal(translate({ not: "lark" }), null);
});
