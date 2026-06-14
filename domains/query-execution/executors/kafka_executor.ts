/**
 * Kafka raw event sampler for Path B raw_analysis.
 *
 * Used when DataFinder OpenAPI cannot express the required logic:
 *   - raw event field inspection before DataFinder aggregation
 *   - custom metric logic outside DataFinder DSL
 *   - near-real-time event stream monitoring
 *   - ingestion / delivery diagnostics
 *
 * Reference: https://www.volcengine.com/docs/84129/1261811?lang=zh
 *            domains/query-execution/protocols/raw-analysis/datafinder-kafka-raw-events.md
 */

import type { Consumer, ConsumerCrashEvent } from "kafkajs";

// ── Config & result types ──────────────────────────────────────────────────────

/**
 * Runtime configuration for Kafka raw event sampling.
 * Never store broker credentials in skill files; pass at call time.
 *
 * consumer_group: use a unique name per analysis task to avoid
 *                 interfering with production consumers.
 * offset_policy:  "latest" for near-real-time; "earliest" for replay.
 */
export interface KafkaConfig {
  /** "host:port" or comma-separated "host1:port,host2:port" */
  broker: string;
  /** "behavior_event" | "user_profile" | "item_profile" */
  topic: string;
  consumer_group: string;
  app_id: number;
  /** default "latest" */
  offset_policy?: string;
  /** default 1000 */
  sample_limit?: number;
  /** stop consuming after this many ms of silence; default 5000 */
  timeout_ms?: number;
}

/** Normalised result from a Kafka sampling run. */
export interface KafkaSampleResult {
  status: string; // "success" | "error"
  records: Record<string, any>[];
  row_count: number;
  error_code: string | null;
  error_message: string | null;
  warnings: string[];
}

// ── Sampler ────────────────────────────────────────────────────────────────────

function _error_message(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * Path B Step 10B (Kafka path): Consume up to config.sample_limit raw
 * behavior events from the configured Kafka topic, filtered to config.app_id.
 *
 * Applies app_id filtering on `header.app_id` before accumulating records.
 * Parses `params` from JSON string when it is not already a dict.
 * Stops after sample_limit matching records or after timeout_ms of silence.
 *
 * Requires:
 *     npm install kafkajs
 */
export async function sample_kafka_events(
  config: KafkaConfig,
  event_name_filter: string | null = null
): Promise<KafkaSampleResult> {
  let KafkaCtor: typeof import("kafkajs").Kafka;
  let kafkaLogLevel: typeof import("kafkajs").logLevel;
  try {
    // Lazy-load so a missing dependency degrades into an error result.
    ({ Kafka: KafkaCtor, logLevel: kafkaLogLevel } = await import("kafkajs"));
  } catch {
    return {
      status: "error",
      records: [],
      row_count: 0,
      error_code: "kafka_connection_failed",
      error_message: "kafkajs not installed. Run: npm install kafkajs",
      warnings: [],
    };
  }

  const offset_policy = config.offset_policy ?? "latest";
  const sample_limit = config.sample_limit ?? 1000;
  const timeout_ms = config.timeout_ms ?? 5000;

  const warnings: string[] = [];

  let consumer: Consumer | null = null;
  try {
    const kafka = new KafkaCtor({
      clientId: config.consumer_group,
      brokers: config.broker.split(","),
      // Fail fast like kafka-python's constructor instead of kafkajs's
      // long default retry cycle; keep the client silent on stdio.
      retry: { retries: 1, initialRetryTime: 300 },
      logLevel: kafkaLogLevel.NOTHING,
    });
    consumer = kafka.consumer({ groupId: config.consumer_group });
    await consumer.connect();
    // auto_offset_reset → fromBeginning mapping.
    await consumer.subscribe({ topic: config.topic, fromBeginning: offset_policy === "earliest" });
  } catch (exc) {
    if (consumer !== null) {
      try {
        await consumer.disconnect();
      } catch {
        // ignore disconnect errors
      }
    }
    return {
      status: "error",
      records: [],
      row_count: 0,
      error_code: "kafka_connection_failed",
      error_message: _error_message(exc),
      warnings: [],
    };
  }

  const records: Record<string, any>[] = [];
  let consumeError: unknown = null;
  try {
    await new Promise<void>((resolve) => {
      let finished = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        timer = null;
        resolve();
      };

      // consumer_timeout_ms equivalent: stop after timeout_ms of silence.
      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(finish, timeout_ms);
      };

      consumer!.on(consumer!.events.CRASH, (event: ConsumerCrashEvent) => {
        consumeError = event.payload?.error ?? new Error("kafka consumer crashed");
        finish();
      });

      resetTimer();

      consumer!
        .run({
          autoCommit: false, // read-only sampling — do not commit offsets
          eachMessage: async ({ message }) => {
            if (finished) return;
            resetTimer();
            try {
              const record: Record<string, any> = JSON.parse(message.value!.toString("utf-8"));

              // Filter by app_id first — always required
              if ((record["header"] ?? {})["app_id"] !== config.app_id) {
                return;
              }

              // Optional event name filter
              if (event_name_filter && record["event_name"] !== event_name_filter) {
                return;
              }

              // Normalise params: DataFinder may encode params as a JSON string
              const raw_params = record["params"];
              if (typeof raw_params === "string") {
                try {
                  record["params"] = JSON.parse(raw_params);
                } catch {
                  warnings.push(
                    `params field on event '${record["event_name"]}' ` +
                      "could not be parsed as JSON; kept as raw string."
                  );
                }
              }

              records.push(record);
              if (records.length >= sample_limit) {
                finish();
              }
            } catch (exc) {
              consumeError = exc;
              finish();
            }
          },
        })
        .catch((exc) => {
          consumeError = exc;
          finish();
        });
    });
  } finally {
    try {
      await consumer.disconnect();
    } catch {
      // ignore disconnect errors
    }
  }

  if (consumeError !== null) {
    return {
      status: "error",
      records,
      row_count: records.length,
      error_code: "kafka_consume_failed",
      error_message: _error_message(consumeError),
      warnings,
    };
  }

  return {
    status: "success",
    records,
    row_count: records.length,
    error_code: null,
    error_message: null,
    warnings,
  };
}
