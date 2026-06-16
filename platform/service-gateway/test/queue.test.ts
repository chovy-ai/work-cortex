import test from "node:test";
import assert from "node:assert/strict";
import { EnvelopeQueue } from "../core/queue.js";
import { silentLogger } from "../core/log.js";
import type { Envelope } from "../core/contracts.js";

function env(id: string): Envelope {
  return {
    v: 1,
    event_id: id,
    dedup_key: `lark:${id}`,
    channel: "lark",
    received_at: new Date().toISOString(),
    conversation: { id: "oc_1", thread_id: null, type: "p2p", source_message_id: "om_1" },
    principal: { channel_user_id: "ou_1" },
    kind: "message",
    message: { text: "hi" },
    raw_ref: null,
  };
}

test("dedup: same dedup_key pushed twice → second is duplicate, not consumed", async () => {
  const q = new EnvelopeQueue({ maxSize: 10, dedupCapacity: 100 }, silentLogger);
  assert.equal(q.push(env("a")), "accepted");
  assert.equal(q.push(env("a")), "duplicate");
  assert.equal(q.size, 1);
});

test("overflow: push beyond maxSize rejected with counter", () => {
  const q = new EnvelopeQueue({ maxSize: 2, dedupCapacity: 100 }, silentLogger);
  assert.equal(q.push(env("a")), "accepted");
  assert.equal(q.push(env("b")), "accepted");
  assert.equal(q.push(env("c")), "overflow");
  assert.equal(q.overflowCount, 1);
});

test("dedup happens before capacity: duplicate does not count as overflow", () => {
  const q = new EnvelopeQueue({ maxSize: 1, dedupCapacity: 100 }, silentLogger);
  q.push(env("a"));
  assert.equal(q.push(env("a")), "duplicate");
  assert.equal(q.overflowCount, 0);
});

test("FIFO order preserved; stop drains then ends iterator", async () => {
  const q = new EnvelopeQueue({ maxSize: 100, dedupCapacity: 1000 }, silentLogger);
  const n = 50;
  for (let i = 0; i < n; i++) q.push(env(`e${i}`));
  q.stop();
  assert.equal(q.push(env("late")), "overflow"); // stop 后拒新
  const seen: string[] = [];
  for await (const e of q.consume()) seen.push(e.event_id);
  assert.equal(seen.length, n);
  assert.deepEqual(
    seen,
    Array.from({ length: n }, (_, i) => `e${i}`),
  );
});

test("consumer wakes when item arrives after waiting", async () => {
  const q = new EnvelopeQueue({ maxSize: 10, dedupCapacity: 100 }, silentLogger);
  const got: string[] = [];
  const loop = (async () => {
    for await (const e of q.consume()) {
      got.push(e.event_id);
      if (got.length === 2) q.stop();
    }
  })();
  setTimeout(() => q.push(env("x")), 10);
  setTimeout(() => q.push(env("y")), 20);
  await loop;
  assert.deepEqual(got, ["x", "y"]);
});

test("dedup LRU evicts oldest beyond capacity", () => {
  const q = new EnvelopeQueue({ maxSize: 100, dedupCapacity: 2 }, silentLogger);
  q.push(env("a"));
  q.push(env("b"));
  q.push(env("c")); // 挤掉 a
  assert.equal(q.push(env("a")), "accepted"); // a 已被遗忘 → 重复执行一次（已知失效模式）
});
