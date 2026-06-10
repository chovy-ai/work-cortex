# Updating the DataFinder OpenAPI manifest

`manifest.json` is the single source of truth for every DataFinder OpenAPI
endpoint this module can call. Official docs change over time and some endpoint
paths here are marked `"path_verified": false` because they were inferred rather
than confirmed against a live doc page. This file tells the agent how to refresh
the manifest from the latest official documentation.

When to run this:
- A `call()` returned `error_code: "endpoint_not_in_manifest"`.
- A result carried a warning that the endpoint path is unverified.
- The user asks to refresh / verify the DataFinder interface.
- An API call fails with `openapi_http_error` 404 (path likely changed).

## Procedure

### 1. Identify the target

- To **add** a missing endpoint: note the capability the user needs (e.g. "create a funnel analysis", "list virtual events").
- To **verify** an existing one: pick the endpoint entry whose `path_verified` is `false`, or the one that errored.

### 2. Fetch the latest official doc

Use WebFetch on the endpoint's `doc_url` (or, for a new endpoint, start from
`global.doc_root` = https://www.volcengine.com/docs/84129 and navigate the API
reference tree). Extract:

- exact HTTP **method** and request **path**
- **required** request parameters (name + type + meaning)
- **optional** request parameters
- response **shape** and any **limits** (row caps, count maxima, async result_id flow)
- the canonical **doc URL** for that specific endpoint

Always confirm against the **calling method** doc for signing/base-URL rules:
https://www.volcengine.com/docs/84129/1261794?lang=zh

If a page returns a cross-host redirect, call WebFetch again with the redirect URL.

### 3. Edit manifest.json

Add or update the endpoint entry. Use this exact shape (keep keys consistent
with the existing entries):

```json
{
  "id": "area.action",
  "summary": "One-line description of what it does.",
  "capability_id": "datafinder.openapi.<name>",
  "wrapper": "<python_wrapper_name_or_null>",
  "method": "POST",
  "path": "/datafinder/openapi/v1/...",
  "path_verified": true,
  "doc_url": "https://www.volcengine.com/docs/84129/<id>",
  "required_params": { "app_id": "int", "...": "type" },
  "optional_params": { "...": "type" },
  "response": { "output": "<output_kind>", "notes": "..." },
  "limits": { "...": 0 },
  "use_when": "When to choose this endpoint."
}
```

Rules:
- Set `"path_verified": true` **only** when the path came from a current doc page.
- Keep `id` as `area.action` (e.g. `analysis.funnel`, `metadata.query`).
- Param type notation must use the keys in `manifest.param_types` (int, string, bool, object, array, date, ts_ms).
- Update `global.last_verified_against_docs_at` to today's date when you verify entries.

### 4. (Optional) Add a typed wrapper

For frequently used endpoints, add a thin wrapper method to `client.py` that
calls `self.call("<id>", {...})`, and set the manifest entry's `wrapper` field
to its name. The generic `call()` already works without a wrapper, so this is
ergonomics only.

### 5. Verify

```
python3 domains/datafinder-interface/cli.py describe <id>     # confirm the entry reads back
python3 domains/datafinder-interface/cli.py list              # confirm it appears, no [UNVERIFIED] flag
```

Then, if credentials are configured, do a minimal live call to confirm the path
resolves (a 404 means the path is still wrong; a business error with code != 0
means the path is right but params need work).

## Provenance

Record where each fact came from. If you could not confirm a path from docs,
leave `path_verified: false` and add a note in `response.notes` — do not claim
verification you did not perform.
