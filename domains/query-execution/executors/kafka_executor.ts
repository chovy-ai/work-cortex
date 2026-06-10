export interface KafkaConfig {
  broker: string;
  topic: string;
  consumerGroup: string;
  appId: number;
  offsetPolicy?: "latest" | "earliest";
  sampleLimit?: number;
  timeoutMs?: number;
}

export interface KafkaSampleResult {
  status: "success" | "error";
  records: Record<string, unknown>[];
  rowCount: number;
  errorCode?: string;
  errorMessage?: string;
  warnings: string[];
}

export async function sampleKafkaEvents(config: KafkaConfig, eventNameFilter?: string): Promise<KafkaSampleResult> {
  let kafkajs: any;
  try {
    kafkajs = await import("kafkajs");
  } catch {
    return {
      status: "error",
      records: [],
      rowCount: 0,
      errorCode: "kafka_connection_failed",
      errorMessage: "kafkajs not installed. Run: npm install kafkajs",
      warnings: []
    };
  }

  const warnings: string[] = [];
  const records: Record<string, unknown>[] = [];
  const kafka = new kafkajs.Kafka({ brokers: config.broker.split(",") });
  const consumer = kafka.consumer({ groupId: config.consumerGroup });
  const sampleLimit = config.sampleLimit ?? 1000;
  const timeoutMs = config.timeoutMs ?? 5000;

  try {
    await consumer.connect();
    await consumer.subscribe({ topic: config.topic, fromBeginning: (config.offsetPolicy ?? "latest") === "earliest" });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, timeoutMs);
      consumer.run({
        autoCommit: false,
        eachMessage: async ({ message }: any) => {
          if (!message.value) return;
          const record = JSON.parse(message.value.toString()) as Record<string, any>;
          if (record.header?.app_id !== config.appId) return;
          if (eventNameFilter && record.event_name !== eventNameFilter) return;
          if (typeof record.params === "string") {
            try {
              record.params = JSON.parse(record.params);
            } catch {
              warnings.push(`params field on event '${record.event_name}' could not be parsed as JSON; kept as raw string.`);
            }
          }
          records.push(record);
          if (records.length >= sampleLimit) {
            clearTimeout(timeout);
            resolve();
          }
        }
      }).catch(reject);
    });
    await consumer.disconnect();
    return { status: "success", records, rowCount: records.length, warnings };
  } catch (error) {
    try {
      await consumer.disconnect();
    } catch {
      // ignore disconnect errors after a connection failure
    }
    return {
      status: "error",
      records,
      rowCount: records.length,
      errorCode: records.length > 0 ? "kafka_consume_failed" : "kafka_connection_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      warnings
    };
  }
}
