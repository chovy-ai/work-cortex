"""
Local file query executor for Path B raw_analysis (local_file source).

Used when the user provides a local CSV or NDJSON file extracted from
DataFinder or Kafka, and the CompiledQuery source is "local_file".

The SQL query received from CompiledQuery.local_sql.sql runs against
a DuckDB in-memory database where the file is mounted as a view named
"events".

Requires:
    pip install duckdb
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


# ── Result type ────────────────────────────────────────────────────────────────

@dataclass
class LocalQueryResult:
    """Normalised result from a local file DuckDB query."""
    status: str                                         # "success" | "error"
    columns: list[str] = field(default_factory=list)
    rows: list[list[Any]] = field(default_factory=list)
    row_count: int = 0
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    warnings: list[str] = field(default_factory=list)


# ── Public entry points ────────────────────────────────────────────────────────

def query_local_csv(file_path: str, sql: str) -> LocalQueryResult:
    """
    Path B Step 10B (local CSV): Run a DuckDB SQL query over a local CSV file.

    The file is mounted as a view named "events".
    sql comes from CompiledQuery.local_sql.sql.

    Example:
        query_local_csv(
            "./events.csv",
            "SELECT date_trunc('day', event_time) AS day, "
            "COUNT(DISTINCT device_id) AS dau FROM events "
            "GROUP BY 1 ORDER BY 1"
        )
    """
    return _run_duckdb(file_path, sql, fmt="csv")


def query_local_ndjson(file_path: str, sql: str) -> LocalQueryResult:
    """
    Path B Step 10B (local NDJSON): Run a DuckDB SQL query over a local
    NDJSON (newline-delimited JSON) file.

    The file is mounted as a view named "events".
    sql comes from CompiledQuery.local_sql.sql.

    Note: confirm the actual message shape from a sample before finalising
    the SQL — DataFinder raw export schemas can vary by SDK/platform/path.

    Example:
        query_local_ndjson(
            "./events.ndjson",
            "SELECT date_trunc('day', to_timestamp(local_time_ms / 1000)) AS day, "
            "COUNT(DISTINCT device_id) AS dau FROM events "
            "WHERE header_app_id = 20004134 GROUP BY 1 ORDER BY 1"
        )
    """
    return _run_duckdb(file_path, sql, fmt="ndjson")


# ── Internal ───────────────────────────────────────────────────────────────────

def _run_duckdb(file_path: str, sql: str, fmt: str) -> LocalQueryResult:
    """Mount file_path as a DuckDB view named 'events' and execute sql."""
    try:
        import duckdb
    except ImportError:
        return LocalQueryResult(
            status="error",
            error_code="local_query_failed",
            error_message="duckdb not installed. Run: pip install duckdb",
        )

    warnings: list[str] = []

    try:
        conn = duckdb.connect(":memory:")

        if fmt == "csv":
            conn.execute(
                "CREATE VIEW events AS SELECT * FROM read_csv_auto(?)",
                [file_path],
            )
        elif fmt == "ndjson":
            conn.execute(
                "CREATE VIEW events AS SELECT * FROM read_json_auto(?)",
                [file_path],
            )
        else:
            return LocalQueryResult(
                status="error",
                error_code="local_query_failed",
                error_message=f"Unsupported file format: {fmt}",
            )

        rel = conn.execute(sql)
        columns = [desc[0] for desc in rel.description]
        rows = [list(row) for row in rel.fetchall()]

        if not rows:
            warnings.append("empty_result: query returned no rows.")

        conn.close()
        return LocalQueryResult(
            status="success",
            columns=columns,
            rows=rows,
            row_count=len(rows),
            warnings=warnings,
        )

    except FileNotFoundError:
        return LocalQueryResult(
            status="error",
            error_code="local_file_not_found",
            error_message=f"File not found: {file_path}",
        )
    except Exception as exc:
        ec = "local_parse_failed" if "parse" in str(exc).lower() else "local_query_failed"
        return LocalQueryResult(
            status="error",
            error_code=ec,
            error_message=str(exc),
            warnings=warnings,
        )
