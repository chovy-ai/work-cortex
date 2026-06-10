# DataFinder OpenAPI module

The single, self-contained module for calling 火山引擎 DataFinder OpenAPI.
It bundles three things in one place:

1. **Complete interface definitions** — `manifest.json` declares every callable
   endpoint with its method, path, required/optional params, response shape,
   limits, and official **doc URL**.
2. **Calling logic** — `client.ts` reads the manifest, signs requests
   (Volcengine V4 HMAC-SHA256), and exposes both a generic `call()` and typed
   wrappers.
3. **A self-update path** — `UPDATE.md` is the procedure for refreshing the
   manifest from the latest official docs when an endpoint is missing or stale.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Canonical interface definitions + doc URLs. Source of truth. |
| `client.ts` | `DataFinderClient` (signing, generic `call()`, typed wrappers), `loadConfigFromEnv`. |
| `cli.ts` | `npm run datafinder -- list / describe / call` for discovery and ad-hoc calls. |
| `UPDATE.md` | How the agent extends/verifies the manifest from the latest docs. |

## Discover the interface

```
npm run datafinder -- list                 # every endpoint + summary
npm run datafinder -- describe analysis.query
```

From TypeScript:

```ts
import { DataFinderClient, loadConfigFromEnv } from "./client.ts";

const client = new DataFinderClient(loadConfigFromEnv());
client.listEndpoints();          // [{id, summary, doc_url, path_verified}, ...]
client.describe("report.query"); // full interface spec
client.docUrl("report.query");   // official doc link
```

## Call an endpoint

Typed wrapper (preferred for the common ones):

```ts
const result = await client.queryReport("123");
```

Generic, manifest-validated (works for every endpoint, including ones with no wrapper):

```ts
const result = await client.call("report.query", {
  report_id: "123",
  period: { start_time: "2026-06-01", end_time: "2026-06-07" }
});
```

`result` is an `APIResult` with `status`, `data`, `errorCode`, `warnings`, `endpointId`.

## When an endpoint is missing

`call()` on an unknown id returns `error_code: "endpoint_not_in_manifest"` (and
`describe()` raises `EndpointNotFound`). Both point to the doc root and to
`UPDATE.md`. The agent should then look up the latest interface in the official
docs and register it in `manifest.json` per `UPDATE.md` — after which it is
immediately callable via `call()`.

Entries with `"path_verified": false` were inferred and emit a warning on call.
Verify them against the docs before trusting empty/error results.

## Credentials

Never stored here. `loadConfigFromEnv()` reads `.env.local` at the project
root (`DATAFINDER_BASE_URL`, `DATAFINDER_ACCESS_KEY`, `DATAFINDER_SECRET_KEY`,
`DATAFINDER_APP_ID`, `DATAFINDER_REGION`, `DATAFINDER_SERVICE`).
