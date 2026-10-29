import pino from "pino";
import { getEnv } from "../config/env.js";

let logger: pino.Logger | undefined;
export function getLogger(): pino.Logger {
  logger ??= pino({
    level: getEnv().LOG_LEVEL,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']", "*.password", "*.password_hash", "*.token"],
      censor: "[REDACTED]",
    },
  });
  return logger;
}
