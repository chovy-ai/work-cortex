/**
 * 会话历史存储（按会话/线程聚合一个用户的一串问答）。
 *
 * "会话"= 一个对话的上下文容器，不是常驻进程：每条消息仍起一次性 agent，把本会话的历史
 * 回放进 prompt 提供上下文。新对话（不同 convKey）= 新会话、空历史。
 * 仅存文本，故便宜；按会话保留最近 maxTurns 轮、空闲超 idleMs 回收、总数封顶 maxSessions(LRU)。
 */

export interface Turn {
  user: string;
  assistant: string;
}

export interface SessionStoreOpts {
  /** 每会话保留的最近问答轮数。 */
  maxTurns: number;
  /** 会话总数上限（超出按 LRU 淘汰最久未用）。 */
  maxSessions: number;
  /** 空闲多久回收（毫秒）。 */
  idleMs: number;
}

export class SessionStore {
  private sessions = new Map<string, { turns: Turn[]; lastUsed: number }>();

  constructor(private readonly opts: SessionStoreOpts) {}

  /** 取某会话的历史（最近 maxTurns 轮）；顺带刷新 lastUsed 并惰性回收。 */
  history(key: string): Turn[] {
    this.sweep();
    const s = this.sessions.get(key);
    if (!s) return [];
    s.lastUsed = now();
    return s.turns;
  }

  /** 追加一轮问答到会话（超出 maxTurns 截断；新会话即创建）。 */
  append(key: string, user: string, assistant: string): void {
    let s = this.sessions.get(key);
    if (!s) {
      s = { turns: [], lastUsed: now() };
      this.sessions.set(key, s);
    }
    s.turns.push({ user, assistant });
    if (s.turns.length > this.opts.maxTurns) s.turns.splice(0, s.turns.length - this.opts.maxTurns);
    s.lastUsed = now();
    this.evictIfNeeded();
  }

  /** 空闲会话回收。 */
  private sweep(): void {
    const cutoff = now() - this.opts.idleMs;
    for (const [k, s] of this.sessions) {
      if (s.lastUsed < cutoff) this.sessions.delete(k);
    }
  }

  /** 超过总数上限时淘汰最久未用。 */
  private evictIfNeeded(): void {
    while (this.sessions.size > this.opts.maxSessions) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, s] of this.sessions) {
        if (s.lastUsed < oldest) {
          oldest = s.lastUsed;
          oldestKey = k;
        }
      }
      if (oldestKey === null) break;
      this.sessions.delete(oldestKey);
    }
  }
}

function now(): number {
  return Date.now();
}
