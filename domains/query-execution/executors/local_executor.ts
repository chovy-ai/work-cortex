export interface LocalQueryResult {
  status: "success" | "error";
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  errorCode?: string;
  errorMessage?: string;
  warnings: string[];
}

export async function queryLocalCsv(filePath: string, sql: string): Promise<LocalQueryResult> {
  return runDuckdb(filePath, sql, "csv");
}

export async function queryLocalNdjson(filePath: string, sql: string): Promise<LocalQueryResult> {
  return runDuckdb(filePath, sql, "ndjson");
}

async function runDuckdb(filePath: string, sql: string, format: "csv" | "ndjson"): Promise<LocalQueryResult> {
  let duckdb: any;
  try {
    duckdb = await import("duckdb");
  } catch {
    return {
      status: "error",
      columns: [],
      rows: [],
      rowCount: 0,
      errorCode: "local_query_failed",
      errorMessage: "duckdb not installed. Run: npm install duckdb",
      warnings: []
    };
  }

  return new Promise((resolveResult) => {
    const db = new duckdb.Database(":memory:");
    const conn = db.connect();
    const reader = format === "csv" ? "read_csv_auto" : "read_json_auto";
    conn.run(`CREATE VIEW events AS SELECT * FROM ${reader}(?)`, [filePath], (createError: Error | null) => {
      if (createError) {
        resolveResult({
          status: "error",
          columns: [],
          rows: [],
          rowCount: 0,
          errorCode: createError.message.includes("No files found") ? "local_file_not_found" : "local_parse_failed",
          errorMessage: createError.message,
          warnings: []
        });
        return;
      }
      conn.all(sql, (queryError: Error | null, rows: Record<string, unknown>[]) => {
        if (queryError) {
          resolveResult({
            status: "error",
            columns: [],
            rows: [],
            rowCount: 0,
            errorCode: queryError.message.toLowerCase().includes("parse") ? "local_parse_failed" : "local_query_failed",
            errorMessage: queryError.message,
            warnings: []
          });
          return;
        }
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        resolveResult({
          status: "success",
          columns,
          rows: rows.map((row) => columns.map((column) => row[column])),
          rowCount: rows.length,
          warnings: rows.length === 0 ? ["empty_result: query returned no rows."] : []
        });
      });
    });
  });
}
