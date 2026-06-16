import type { Envelope } from "./contracts.js";
import type { Logger } from "./log.js";

export type PushResult = "accepted" | "duplicate" | "overflow";

/**
 * 03 · 内存队列与幂等。
 * push：先去重（LRU，重推不占溢出名额）→ 再查容量 → 入队。
 * consume：单消费者全局 FIFO。stop()：拒新 → 排空存量 → 迭代器结束。
 */
export class EnvelopeQueue {
  private items: Envelope[] = [];
  private dedup = new Set<string>();
  private waiter: (() => void) | null = null;
  private stopped = false;
  overflowCount = 0;

  constructor(
    private opts: { maxSize: number; dedupCapacity: number },
    private log: Logger,
  ) {}

  get size(): number {
    return this.items.length;
  }

  push(env: Envelope): PushResult {
    if (this.dedup.has(env.dedup_key)) {
      this.log("debug", "queue", "duplicate dropped", { dedup_key: env.dedup_key });
      return "duplicate";
    }
    if (this.stopped || this.items.length >= this.opts.maxSize) {
      this.overflowCount++;
      this.log("error", "queue", this.stopped ? "rejected: stopped" : "overflow: rejected", {
        dedup_key: env.dedup_key,
        overflow_count: this.overflowCount,
      });
      return "overflow";
    }
    this.remember(env.dedup_key);
    this.items.push(env);
    this.wake();
    return "accepted";
  }

  /** 单消费者；for await 驱动。 */
  consume(): AsyncIterable<Envelope> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<Envelope> {
        return {
          async next(): Promise<IteratorResult<Envelope>> {
            for (;;) {
              const item = self.items.shift();
              if (item) return { value: item, done: false };
              if (self.stopped) return { value: undefined, done: true };
              await new Promise<void>((res) => (self.waiter = res));
            }
          },
        };
      },
    };
  }

  stop(): void {
    this.stopped = true;
    this.wake();
  }

  private remember(key: string): void {
    this.dedup.add(key);
    if (this.dedup.size > this.opts.dedupCapacity) {
      const oldest = this.dedup.values().next().value as string;
      this.dedup.delete(oldest);
    }
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
}
