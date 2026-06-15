# Review Protocol

The Review Protocol applies exclusively to `query_path: raw_analysis` requests. It inserts a two-stage gate between QueryIntent and QueryPlan to prevent incorrect event selection, wrong metric definitions, or misleading calculation logic from reaching execution.

---

## Stage 1 — Subagent Review (Automated)

### Purpose

An independent review agent validates the QueryIntent before any plan is built. It must derive its judgment entirely from the QueryIntent, `capabilities.json`, and the application data model — it has no access to prior conversation history.

### When to Run

Trigger Stage 1 when:

- `QueryIntent.status = matched` AND `query_path = raw_analysis`

Do not trigger for `needs_clarification` or `unsupported` intents.

### Inputs

- `QueryIntent` (status = matched, query_path = raw_analysis)
- `domains/intent-routing/capabilities.json`
- `domains/metric-semantics/data-model-protocol.md`

### Review Checks

| Check | What to Validate |
|-------|-----------------|
| `event_semantics` | Are the selected events (or the absence of event filters) semantically correct for the requested metric? e.g., DAU should not be computed from server-side synthetic events. |
| `identity_key` | Is the identity key (`device_id` / `user_unique_id` / `ssid`) appropriate for the metric type and population? e.g., DAU uses `device_id`; user-level retention must use a stable cross-session key. |
| `aggregation_logic` | Does the aggregation method (`count_distinct`, `count`, `sum`) match the business intent? e.g., "number of users" requires `count_distinct`, not `count`. |
| `filter_safety` | Do filters correctly narrow to the intended population without accidentally excluding valid data or double-filtering? |
| `breakdown_validity` | Are breakdown dimensions known DataFinder fields? If unknown, flag for metadata lookup before plan compilation. |
| `known_risks` | Are there known data quality issues, ingestion delays, field ambiguities, or application SDK behaviors (e.g., the reporter service stripping renderer params) that could affect result accuracy? |

### SubagentReviewResult Shape

```json
{
  "review_status": "approved",
  "checks": {
    "event_semantics":    { "passed": true,  "notes": "" },
    "identity_key":       { "passed": true,  "notes": "" },
    "aggregation_logic":  { "passed": true,  "notes": "" },
    "filter_safety":      { "passed": true,  "notes": "" },
    "breakdown_validity": { "passed": true,  "notes": "" },
    "known_risks":        { "passed": false, "notes": "app_version is a reporter-service-injected field; renderer-supplied app_version values are stripped. Breakdown result is reliable." }
  },
  "revision_notes": [],
  "block_reason": null
}
```

### Review Status Rules

| Status | Meaning | Next Action |
|--------|---------|-------------|
| `approved` | All checks pass (failed `known_risks` alone does not block; it surfaces as a warning). | Proceed to Stage 2. |
| `requires_revision` | One or more checks (`event_semantics`, `identity_key`, `aggregation_logic`, `filter_safety`) found a correctable error. | Revise the QueryIntent and re-run Stage 1. Max 2 retries; if still failing, escalate `revision_notes` to the user. |
| `blocked` | A fundamental problem exists that cannot be resolved without user input (e.g., required breakdown field is not a registered DataFinder field and metadata lookup is needed). | Surface `block_reason` to the user before proceeding. |

---

## Stage 2 — User Review Card (Human Confirmation)

### Purpose

Present the proposed calculation methodology to the user in plain language so they can confirm or correct the approach before any query is executed. This is the explicit human checkpoint.

### When to Run

Always run Stage 2 after Stage 1 returns `approved`, unless the review is explicitly bypassed (see Review Bypass below).

### ReviewCard Format

Render as a structured Markdown block. Include all sections. Do not omit warnings even if the list is empty.

```markdown
## 📊 查询方案确认

**分析目标**：{one-line description of the metric and analysis goal}

**数据来源**：{DataFinder OpenAPI / DataFinder Kafka / 本地文件} — {capability_id}

**计算公式**
> {metric_name} = {aggregation_function}({identity_field})
> 事件范围：{event_set, comma-separated, or "全部事件（不限制）"}
> 过滤条件：{human-readable filter list, or "无"}
> 拆分维度：{breakdowns, or "无"}

**时间范围**：{resolved start} ～ {resolved end}（{timezone}，按{granularity}聚合）

**默认值说明**
{For each item in defaults_applied: "· {slot}：使用默认值 {value}（来源：{source}）"}

**注意事项**
{For each warning from SubagentReviewResult.checks where passed=false: "⚠ {notes}"}
{If no warnings: "无"}

---
请确认方案后开始查询，或告知需要调整的地方。
```

### Confirmation Rules

- Require an explicit confirmation before proceeding to QueryPlan. Accepted signals: "确认"、"没问题"、"ok"、"go"、"是的"、"对"、"✅" or equivalent affirmative.
- A vague response (e.g., "好的") counts as confirmation **only when** `SubagentReviewResult` has no warnings (all checks passed).
- If warnings are present, the user must either acknowledge each warning or request a revision before confirmation is accepted.
- Revision requests return to Step 3 (QueryIntent) with the user's corrections incorporated.

---

## Review Bypass

The following conditions allow skipping Stage 1 (subagent review) while still requiring Stage 2 (user review card):

- The QueryIntent was derived from a user-provided explicit formula or event list (the user already specified the calculation logic).

The following conditions allow skipping **both** stages:

- The user explicitly says "skip review", "不用 review", "直接查", or equivalent.

When either stage is bypassed, add `"review_bypassed": true` to the downstream QueryPlan to preserve auditability. For a full bypass, also add `"bypass_reason": "{user utterance}"`.

---

## Review Loop Limit

If Stage 1 returns `requires_revision` more than **2 consecutive times** for the same QueryIntent:

1. Stop the subagent review loop.
2. Surface all `revision_notes` to the user in a plain-language summary.
3. Ask the user to clarify the intent directly before retrying.

---

## Examples

### Approved Review — DAU Trend

**SubagentReviewResult**
```json
{
  "review_status": "approved",
  "checks": {
    "event_semantics":    { "passed": true,  "notes": "" },
    "identity_key":       { "passed": true,  "notes": "" },
    "aggregation_logic":  { "passed": true,  "notes": "" },
    "filter_safety":      { "passed": true,  "notes": "" },
    "breakdown_validity": { "passed": true,  "notes": "" },
    "known_risks":        { "passed": false, "notes": "server_time 与 client_ts 在该时间段内存在最多 2 小时偏差，建议以 client_ts（local_time_ms）为准。" }
  },
  "revision_notes": [],
  "block_reason": null
}
```

**ReviewCard**
```markdown
## 📊 查询方案确认

**分析目标**：统计最近 14 天目标应用日活用户数（DAU），按 app_version 拆分

**数据来源**：DataFinder OpenAPI — datafinder.openapi.analysis_query

**计算公式**
> DAU = count(distinct device_id)
> 事件范围：全部事件（不限制）
> 过滤条件：app_id = <your-app-id>
> 拆分维度：app_version

**时间范围**：2026-05-26 ～ 2026-06-08（Asia/Shanghai，按天聚合）

**默认值说明**
· app_id：使用默认值 <your-app-id>（来源：应用默认值）
· timezone：使用默认值 Asia/Shanghai（来源：skill default）
· identity：使用默认值 device_id（来源：应用 DAU policy）

**注意事项**
⚠ server_time 与 client_ts 在该时间段内存在最多 2 小时偏差，建议以 client_ts（local_time_ms）为准。

---
请确认方案后开始查询，或告知需要调整的地方。
```

### Requires Revision — Wrong Identity Key

**SubagentReviewResult**
```json
{
  "review_status": "requires_revision",
  "checks": {
    "event_semantics":    { "passed": true,  "notes": "" },
    "identity_key":       { "passed": false, "notes": "用户要求的是跨设备留存率，应使用 user_unique_id 而非 device_id；device_id 会因设备更换导致留存率偏低。" },
    "aggregation_logic":  { "passed": true,  "notes": "" },
    "filter_safety":      { "passed": true,  "notes": "" },
    "breakdown_validity": { "passed": true,  "notes": "" },
    "known_risks":        { "passed": true,  "notes": "" }
  },
  "revision_notes": [
    "将 identity 从 device_id 修改为 user_unique_id 以支持跨设备留存计算。"
  ],
  "block_reason": null
}
```

Action: revise QueryIntent slot `identity` to `user_unique_id` and re-run Stage 1.
