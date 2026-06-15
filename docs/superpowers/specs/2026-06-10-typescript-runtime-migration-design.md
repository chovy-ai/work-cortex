# TypeScript Runtime Migration Design

## Goal

Migrate all executable runtime scripts and tests in `data-analysis` from Python to TypeScript while preserving the existing domain architecture, protocols, JSON schemas, manifests, and generated knowledge-store artifacts.

This is a runtime migration, not a redesign of the analytics architecture.

## Scope

Convert these Python surfaces to TypeScript:

- `domains/datafinder-interface/client.py`
- `domains/datafinder-interface/cli.py`
- `domains/event-knowledge/extract_events.py`
- `domains/metric-semantics/extract_data_model.py`
- `domains/knowledge-update/check_capabilities_sync.py`
- `domains/knowledge-update/check_freshness.py`
- `domains/knowledge-update/update_knowledge.py`
- `domains/query-execution/scheduler/scheduler.py`
- `domains/query-execution/steps/**/*.py`
- `domains/query-execution/executors/kafka_executor.py`
- `domains/query-execution/executors/local_executor.py`
- `tests/test_migration_contracts.py`

Keep these as-is:

- Markdown architecture and protocol docs.
- JSON schema files.
- `manifest.json`, `capabilities.json`, `registry.json`, and `module.json` files, except command strings that must point at TypeScript entrypoints.
- `knowledge-store/*.json` generated artifacts.
- Shell scripts such as `domains/event-knowledge/sync_app.sh`.

## Approach

Keep the domain-first directory structure and replace Python files in place:

```text
domains/datafinder-interface/client.ts
domains/datafinder-interface/cli.ts
domains/query-execution/scheduler/scheduler.ts
domains/query-execution/steps/**.ts
domains/query-execution/executors/**.ts
tests/migration-contracts.test.ts
```

Add a minimal Node/TypeScript toolchain:

- `package.json`
- `tsconfig.json`
- `vitest.config.ts`

Use `tsx` for local execution and Vitest for contract tests. This keeps command strings simple during development:

```bash
npm test
npm run typecheck
npm run datafinder -- list
npm run knowledge -- status
```

## Module Design

### DataFinder Interface

`client.ts` will preserve the current public concepts:

- `DataFinderConfig`
- `APIResult`
- `EndpointNotFound`
- `loadManifest`
- `DataFinderClient`
- `loadConfigFromEnv`

The TypeScript implementation will use Node built-ins:

- `crypto` for Volcengine HMAC-SHA256 signing.
- global `fetch` for HTTP calls.
- `fs/promises` and `path` for config and manifest loading.

The manifest remains the source of truth. The client will continue to validate required params, inject `app_id`, expand path params, split query/body/header params, sign the request, and normalize errors.

### Query Scheduler

`scheduler.ts` will preserve the current state-machine semantics:

- `StepOutcome`
- `SchedulerState`
- `StepScheduler`
- `workflow.json`
- persisted `outputs/<run_id>/state.json`
- dynamic step loading
- `await_input`, `revise`, `failed`, and `completed` statuses

Step files will export:

```ts
export function run(ctx: Record<string, unknown>): StepOutcome
```

### Executors

`local_executor.ts` will use the Node DuckDB package if installed and return the same normalized result shape as the Python executor. If DuckDB is missing, it will return a structured `local_query_failed` error.

`kafka_executor.ts` will use `kafkajs` if installed and return the same normalized result shape. Missing dependency or connection failures will be returned as structured errors.

### Knowledge Update

The control plane scripts will become TypeScript CLIs:

- `check_freshness.ts`
- `check_capabilities_sync.ts`
- `update_knowledge.ts`

`module.json` command strings will be updated from `python3 ...` to `npx tsx ...`.

### Event and Data Model Extraction

The extractors will be rewritten in TypeScript with equivalent behavior:

- Run git and shell commands through `child_process`.
- Preserve output paths under `knowledge-store/`.
- Preserve generated JSON shapes expected by freshness checks and contract tests.

## Testing

Replace Python `unittest` tests with Vitest contract tests that cover the same behaviors:

- Required target files exist and legacy Python files are removed.
- Domain `module.json` contracts are present.
- DataFinder manifest endpoints are verified and discoverable.
- DataFinder client path/query/header/body parameter preparation is correct.
- Capabilities are in sync with the DataFinder manifest.
- Scheduler persists awaiting state.

Validation commands:

```bash
npm install
npm run typecheck
npm test
npm run datafinder -- list
npm run knowledge -- status
```

`npm run knowledge -- status` may report stale or unknown when the local application repo or generated knowledge artifacts are unavailable. That is acceptable if the command runs and reports structured status.

## Risks

- DuckDB and Kafka Node packages may require optional native/runtime setup. The migration will keep structured missing-dependency errors so the base test suite does not depend on live services.
- Dynamic TypeScript step loading must work under `tsx`; tests will cover the scheduler state behavior, and additional end-to-end scheduler tests can be added after the first migration.
- The current Python step implementations are placeholders. The migration will preserve their behavior rather than adding new analytics execution logic.

## Out of Scope

- Building the Feishu bot daemon.
- Reworking query semantics.
- Adding new DataFinder endpoints.
- Changing protocol schemas or query result formats.
