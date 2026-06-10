# TypeScript Runtime Migration

This repository now uses TypeScript for all first-party executable runtime code and contract tests.

## Runtime Entrypoints

| Area | Entrypoint |
| --- | --- |
| DataFinder discovery/calls | `npm run datafinder -- <list|describe|call>` |
| Knowledge update control plane | `npm run knowledge -- <status|register|update>` |
| Event catalog extraction | `npx tsx domains/event-knowledge/extract_events.ts` |
| Metric semantics extraction | `npx tsx domains/metric-semantics/extract_data_model.ts` |
| Query scheduler | `npx tsx domains/query-execution/scheduler/scheduler.ts` |

## Migrated Surfaces

- `domains/datafinder-interface/client.ts`
- `domains/datafinder-interface/cli.ts`
- `domains/event-knowledge/extract_events.ts`
- `domains/metric-semantics/extract_data_model.ts`
- `domains/knowledge-update/*.ts`
- `domains/query-execution/scheduler/scheduler.ts`
- `domains/query-execution/steps/**/*.ts`
- `domains/query-execution/executors/*.ts`
- `tests/migration-contracts.test.ts`

## Verification

```bash
npm run typecheck
npm test
npm run datafinder -- list
npm run knowledge -- status
```

`npm run knowledge -- status` may return non-zero when local knowledge artifacts are stale or placeholders. That is a data freshness signal, not a TypeScript runtime failure.
