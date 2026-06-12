export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = (level: LogLevel, module: string, msg: string, extra?: Record<string, unknown>) => void;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON 行日志写 stdout；launchd 重定向到文件。字段：ts / level / module / msg / ...extra */
export function createLogger(minLevel: LogLevel = "info"): Logger {
  const min = ORDER[minLevel];
  return (level, module, msg, extra) => {
    if (ORDER[level] < min) return;
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, module, msg, ...extra }) + "\n");
  };
}

export const silentLogger: Logger = () => {};
