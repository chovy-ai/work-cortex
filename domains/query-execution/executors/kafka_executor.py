"""
Kafka raw event sampler for Path B raw_analysis.

Used when DataFinder OpenAPI cannot express the required logic:
  - raw event field inspection before DataFinder aggregation
  - custom metric logic outside DataFinder DSL
  - near-real-time event stream monitoring
  - ingestion / delivery diagnostics

Reference: https://www.volcengine.com/docs/84129/1261811?lang=zh
           domains/query-execution/protocols/raw-analysis/datafinder-kafka-raw-events.md
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Optional


# ── Config & result types ──────────────────────────────────────────────────────

@dataclass
class KafkaConfig:
    """
    Runtime configuration for Kafka raw event sampling.
    Never store broker credentials in skill files; pass at call time.

    consumer_group: use a unique name per analysis task to avoid
                    interfering with production consumers.
    offset_policy:  "latest" for near-real-time; "earliest" for replay.
    """
    broker: str              # "host:port" or comma-separated "host1:port,host2:port"
    topic: str               # "behavior_event" | "user_profile" | "item_profile"
    consumer_group: str
    app_id: int
    offset_policy: str = "latest"
    sample_limit: int = 1000
    timeout_ms: int = 5000   # stop consuming after this many ms of silence


@dataclass
class KafkaSampleResult:
    """Normalised result from a Kafka sampling run."""
    status: str                                         # "success" | "error"
    records: list[dict] = field(default_factory=list)
    row_count: int = 0
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    warnings: list[str] = field(default_factory=list)


# ── Sampler ────────────────────────────────────────────────────────────────────

def sample_kafka_events(
    config: KafkaConfig,
    event_name_filter: Optional[str] = None,
) -> KafkaSampleResult:
    """
    Path B Step 10B (Kafka path): Consume up to config.sample_limit raw
    behavior events from the configured Kafka topic, filtered to config.app_id.

    Applies app_id filtering on `header.app_id` before accumulating records.
    Parses `params` from JSON string when it is not already a dict.
    Stops after sample_limit matching records or after timeout_ms of silence.

    Requires:
        pip install kafka-python
    """
    try:
        from kafka import KafkaConsumer
    except ImportError:
        return KafkaSampleResult(
            status="error",
            error_code="kafka_connection_failed",
            error_message="kafka-python not installed. Run: pip install kafka-python",
        )

    warnings: list[str] = []

    try:
        consumer = KafkaConsumer(
            config.topic,
            bootstrap_servers=config.broker,
            group_id=config.consumer_group,
            auto_offset_reset=config.offset_policy,
            consumer_timeout_ms=config.timeout_ms,
            value_deserializer=lambda v: json.loads(v.decode("utf-8")),
            enable_auto_commit=False,   # read-only sampling — do not commit offsets
        )
    except Exception as exc:
        return KafkaSampleResult(
            status="error",
            error_code="kafka_connection_failed",
            error_message=str(exc),
        )

    records: list[dict] = []
    try:
        for msg in consumer:
            record: dict = msg.value

            # Filter by app_id first — always required
            if record.get("header", {}).get("app_id") != config.app_id:
                continue

            # Optional event name filter
            if event_name_filter and record.get("event_name") != event_name_filter:
                continue

            # Normalise params: DataFinder may encode params as a JSON string
            raw_params = record.get("params")
            if isinstance(raw_params, str):
                try:
                    record["params"] = json.loads(raw_params)
                except json.JSONDecodeError:
                    warnings.append(
                        f"params field on event '{record.get('event_name')}' "
                        "could not be parsed as JSON; kept as raw string."
                    )

            records.append(record)
            if len(records) >= config.sample_limit:
                break
    except Exception as exc:
        return KafkaSampleResult(
            status="error",
            error_code="kafka_consume_failed",
            error_message=str(exc),
            records=records,
            row_count=len(records),
            warnings=warnings,
        )
    finally:
        consumer.close()

    return KafkaSampleResult(
        status="success",
        records=records,
        row_count=len(records),
        warnings=warnings,
    )
