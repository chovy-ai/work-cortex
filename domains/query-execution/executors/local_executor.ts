/**
 * Local file query executor for Path B raw_analysis (local_file source).
 *
 * Used when the user provides a local CSV or NDJSON file extracted from
 * DataFinder or Kafka, and the CompiledQuery source is "local_file".
 *
 * The SQL query received from CompiledQuery.local_sql.sql runs against
 * a DuckDB in-memory database where the file is mounted as a view named
 * "events".
 *
 * Requires:
 *     npm install duckdb
 */

// ── Result type ────────────────────────────────────────────────────────────────

/** Normalised result from a local file DuckDB query. */
export interface LocalQueryResult {
  status: string; // "success" | "error"
  columns: string[];
  rows: any[][];
  row_count: number;
  error_code: string | null;
  error_message: string | null;
  warnings: string[];
}

// ── Public entry points ────────────────────────────────────────────────────────

/**
 * Path B Step 10B (local CSV): Run a DuckDB SQL query over a local CSV file.
 *
 * The file is mounted as a view named "events".
 * sql comes from CompiledQuery.local_sql.sql.
 *
 * Example:
 *     query_local_csv(
 *         "./events.csv",
 *         "SELECT date_trunc('day', event_time) AS day, " +
 *         "COUNT(DISTINCT device_id) AS dau FROM events " +
 *         "GROUP BY 1 ORDER BY 1"
 *     )
 */
export async function query_local_csv(file_path: string, sql: string): Promise<LocalQueryResult> {
  return _run_duckdb(file_path, sql, "csv");
}

/**
 * Path B Step 10B (local NDJSON): Run a DuckDB SQL query over a local
 * NDJSON (newline-delimited JSON) file.
 *
 * The file is mounted as a view named "events".
 * sql comes from CompiledQuery.local_sql.sql.
 *
 * Note: confirm the actual message shape from a sample before finalising
 * the SQL — DataFinder raw export schemas can vary by SDK/platform/path.
 *
 * Example:
 *     query_local_ndjson(
 *         "./events.ndjson",
 *         "SELECT date_trunc('day', to_timestamp(local_time_ms / 1000)) AS day, " +
 *         "COUNT(DISTINCT device_id) AS dau FROM events " +
 *         "WHERE header_app_id = 20004134 GROUP BY 1 ORDER BY 1"
 *     )
 */
export async function query_local_ndjson(file_path: string, sql: string): Promise<LocalQueryResult> {
  return _run_duckdb(file_path, sql, "ndjson");
}

// ── Internal ───────────────────────────────────────────────────────────────────

type DuckDbModule = typeof import("duckdb");

function _error_result(error_code: string, error_message: string, warnings: string[] = []): LocalQueryResult {
  return {
    status: "error",
    columns: [],
    rows: [],
    row_count: 0,
    error_code,
    error_message,
    warnings,
  };
}

/**
 * node-duckdb returns BIGINT columns as BigInt; Python duckdb returns plain
 * int. Convert to Number (or a decimal string beyond the safe range) so
 * results stay JSON-serialisable like the Python version's.
 */
function _normalise_value(value: any): any {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return value;
}

/** Mount file_path as a DuckDB view named 'events' and execute sql. */
async function _run_duckdb(file_path: string, sql: string, fmt: string): Promise<LocalQueryResult> {
  let duckdb: DuckDbModule;
  try {
    // Lazy-load so a missing optional dependency degrades into an error result.
    const mod: any = await import("duckdb");
    duckdb = (mod?.default ?? mod) as DuckDbModule;
  } catch {
    return _error_result("local_query_failed", "duckdb not installed. Run: npm install duckdb");
  }

  const warnings: string[] = [];

  try {
    const conn = await new Promise<InstanceType<DuckDbModule["Database"]>>((resolve, reject) => {
      const db = new duckdb.Database(":memory:", (err) => (err ? reject(err) : resolve(db)));
    });

    const exec = (text: string) =>
      new Promise<void>((resolve, reject) =>
        conn.run(text, (err: Error | null) => (err ? reject(err) : resolve()))
      );

    // node-duckdb cannot prepare CREATE VIEW statements with parameters, so
    // the file path is inlined as an escaped SQL string literal instead.
    const quoted = `'${file_path.replaceAll("'", "''")}'`;

    if (fmt === "csv") {
      await exec(`CREATE VIEW events AS SELECT * FROM read_csv_auto(${quoted})`);
    } else if (fmt === "ndjson") {
      await exec(`CREATE VIEW events AS SELECT * FROM read_json_auto(${quoted})`);
    } else {
      return _error_result("local_query_failed", `Unsupported file format: ${fmt}`);
    }

    const stmt = conn.prepare(sql);
    const table = await new Promise<Record<string, any>[]>((resolve, reject) =>
      stmt.all((err, res) => (err ? reject(err) : resolve(res)))
    );
    const columns = stmt.columns().map((col) => col.name);
    const rows = table.map((row) => columns.map((name) => _normalise_value(row[name])));
    await new Promise<void>((resolve) => stmt.finalize(() => resolve()));

    if (rows.length === 0) {
      warnings.push("empty_result: query returned no rows.");
    }

    await new Promise<void>((resolve, reject) => conn.close((err) => (err ? reject(err) : resolve())));
    return {
      status: "success",
      columns,
      rows,
      row_count: rows.length,
      error_code: null,
      error_message: null,
      warnings,
    };
  } catch (exc) {
    // Equivalent of Python's FileNotFoundError branch.
    if ((exc as NodeJS.ErrnoException)?.code === "ENOENT") {
      return _error_result("local_file_not_found", `File not found: ${file_path}`);
    }
    const message = exc instanceof Error ? exc.message : String(exc);
    const ec = message.toLowerCase().includes("parse") ? "local_parse_failed" : "local_query_failed";
    return _error_result(ec, message, warnings);
  }
}
