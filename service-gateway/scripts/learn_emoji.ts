#!/usr/bin/env node
/**
 * 表情用法学习器：从指定飞书群聊拉取近期消息，统计表情短代码使用频率，
 * 沉淀到 capabilities/data-analysis/emoji-learned.md（runner 自动追加进提示词）。
 *
 * 用法：
 *   node dist/scripts/learn_emoji.js --chat-id oc_xxx [--chat-id oc_yyy ...] [--page-limit 5]
 *
 * 学习是累积的：新统计与已有沉淀合并（频次相加），按频次排序保留 Top 20。
 * 人工修订：直接编辑 emoji-learned.md 的「场景」列——脚本只更新频次，不覆盖场景描述。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEARNED_PATH = join(sgRoot, "capabilities", "data-analysis", "emoji-learned.md");

// 飞书消息占位符，不是表情，排除
const PLACEHOLDERS = new Set([
  "图片", "文件", "视频", "语音", "表情包", "红包", "位置", "名片", "链接",
  "卡片消息", "合并转发", "日程", "任务", "投票", "群名片", "动图",
]);

function parseArgs(): { chatIds: string[]; pageLimit: number } {
  const argv = process.argv.slice(2);
  const chatIds: string[] = [];
  let pageLimit = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--chat-id") chatIds.push(argv[++i]);
    else if (argv[i] === "--page-limit") pageLimit = Number(argv[++i]);
  }
  if (chatIds.length === 0) {
    process.stderr.write("usage: learn_emoji --chat-id oc_xxx [--chat-id ...] [--page-limit N]\n");
    process.exit(2);
  }
  return { chatIds, pageLimit };
}

function fetchMessages(chatId: string, _pageLimit: number): string {
  // lark-cli 1.0.6 的该子命令不支持 --page-all；默认页足够学习用，升级后可加分页
  return execFileSync(
    "lark-cli",
    ["im", "+chat-messages-list", "--chat-id", chatId],
    { encoding: "utf-8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
  );
}

/** 从原始输出的所有 content 字符串里提取 [表情] 短代码并计数 */
function countEmojis(raw: string, counts: Map<string, number>): number {
  // 消息文本在 JSON 的 content 字段里（转义过的 {"text":"..."}）；
  // 直接对全文做短代码匹配，再用占位符表过滤
  let total = 0;
  for (const m of raw.matchAll(/\[([一-龥A-Za-z]{1,8})\]/g)) {
    const name = m[1];
    if (PLACEHOLDERS.has(name)) continue;
    if (/^[a-z]+$/.test(name)) continue; // 纯小写英文多为 markdown 链接文本，跳过
    counts.set(name, (counts.get(name) ?? 0) + 1);
    total++;
  }
  return total;
}

interface LearnedRow {
  emoji: string;
  count: number;
  scene: string;
}

function loadExisting(): Map<string, LearnedRow> {
  const rows = new Map<string, LearnedRow>();
  if (!existsSync(LEARNED_PATH)) return rows;
  for (const line of readFileSync(LEARNED_PATH, "utf-8").split("\n")) {
    const m = line.match(/^\|\s*\[([^\]]+)\]\s*\|\s*(\d+)\s*\|\s*(.*?)\s*\|$/);
    if (m) rows.set(m[1], { emoji: m[1], count: Number(m[2]), scene: m[3] });
  }
  return rows;
}

function render(rows: LearnedRow[]): string {
  const lines = [
    "# 已学习的飞书表情用法（机器沉淀，runner 自动注入提示词）",
    "",
    "以下表情来自团队群聊的真实使用统计。使用规则见 persona.md 第三节；",
    "「场景」列可人工修订（脚本只更新频次，不覆盖场景描述）。",
    "",
    "| 表情 | 频次 | 场景 |",
    "|---|---|---|",
    ...rows.map((r) => `| [${r.emoji}] | ${r.count} | ${r.scene} |`),
    "",
    `> 最近学习：${new Date().toISOString().slice(0, 10)}，工具：scripts/learn_emoji.ts`,
    "",
  ];
  return lines.join("\n");
}

function main(): void {
  const { chatIds, pageLimit } = parseArgs();
  const existing = loadExisting();
  const fresh = new Map<string, number>();
  let scanned = 0;

  for (const chatId of chatIds) {
    process.stdout.write(`fetching ${chatId} (page-limit ${pageLimit})...\n`);
    const raw = fetchMessages(chatId, pageLimit);
    scanned += countEmojis(raw, fresh);
  }

  for (const [emoji, count] of fresh) {
    const row = existing.get(emoji);
    if (row) row.count += count;
    else existing.set(emoji, { emoji, count, scene: "（待人工标注场景）" });
  }

  const top = [...existing.values()].sort((a, b) => b.count - a.count).slice(0, 20);
  writeFileSync(LEARNED_PATH, render(top));

  process.stdout.write(`本次提取 ${scanned} 次表情使用，沉淀 ${top.length} 个表情 → ${LEARNED_PATH}\n`);
  for (const r of top.slice(0, 10)) process.stdout.write(`  [${r.emoji}] ×${r.count}  ${r.scene}\n`);
}

main();
