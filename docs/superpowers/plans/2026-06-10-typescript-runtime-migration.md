# TypeScript Runtime Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace all Python executable scripts and tests with TypeScript equivalents while preserving the current domain protocols and behavior.

**Architecture:** Keep the existing `domains/` layout and migrate files in place from `.py` to `.ts`. Add a minimal Node toolchain with `tsx`, TypeScript, and Vitest. Keep Markdown, JSON protocols, schemas, manifests, and knowledge-store artifacts in their existing formats.

**Tech Stack:** TypeScript, Node.js built-ins, `tsx`, Vitest, optional `duckdb`, optional `kafkajs`.

---

### Task 1: Toolchain And Red Contract Tests

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tests/migration-contracts.test.ts`

- [x] Add Node/TypeScript scripts for `typecheck`, `test`, `datafinder`, and `knowledge`.
- [x] Port the Python migration contract tests to Vitest.
- [x] Run `npm test` and confirm it fails because TypeScript runtime files do not exist yet.

### Task 2: DataFinder Runtime

**Files:**
- Create: `domains/datafinder-interface/client.ts`
- Create: `domains/datafinder-interface/cli.ts`
- Delete: `domains/datafinder-interface/client.py`
- Delete: `domains/datafinder-interface/cli.py`
- Delete: `domains/datafinder-interface/__init__.py`
- Modify: `domains/datafinder-interface/README.md`
- Modify: `skills/data-analytics/SKILL.md`

- [x] Implement manifest loading, endpoint discovery, request preparation, Volcengine signing, normalized results, typed wrappers, and env loading in TypeScript.
- [x] Implement the discovery/call CLI in TypeScript.
- [x] Run the DataFinder-focused contract tests until green.

### Task 3: Scheduler And Steps

**Files:**
- Create: `domains/query-execution/scheduler/scheduler.ts`
- Create: `domains/query-execution/steps/**/*.ts`
- Delete: matching Python scheduler and step files.

- [x] Implement `StepOutcome`, `SchedulerState`, and `StepScheduler` with the same state semantics.
- [x] Convert placeholder steps to TypeScript exports.
- [x] Run scheduler-focused contract tests until green.

### Task 4: Knowledge Update And Extractors

**Files:**
- Create: `domains/knowledge-update/*.ts`
- Create: `domains/event-knowledge/extract_events.ts`
- Create: `domains/metric-semantics/extract_data_model.ts`
- Delete: matching Python files.
- Modify: `domains/*/module.json`

- [x] Port freshness checks, capability sync checks, update control plane, event extraction, and data-model extraction.
- [x] Update `module.json` command strings to use `npx tsx`.
- [x] Run knowledge-related contract tests until green.

### Task 5: Executors

**Files:**
- Create: `domains/query-execution/executors/local_executor.ts`
- Create: `domains/query-execution/executors/kafka_executor.ts`
- Delete: matching Python executor files.

- [x] Port normalized result types and missing-dependency behavior.
- [x] Use optional dynamic imports for `duckdb` and `kafkajs` so base tests do not require live services.

### Task 6: Documentation, Cleanup, Verification

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGES.md`
- Modify: `README.md`
- Modify: `.gitignore` if needed.

- [x] Replace Python command references with TypeScript commands.
- [x] Remove all `.py` runtime and test files.
- [x] Run `npm install`, `npm run typecheck`, `npm test`, `npm run datafinder -- list`, and `npm run knowledge -- status`.
- [x] Report any expected stale/unknown knowledge status separately from test/typecheck status.
