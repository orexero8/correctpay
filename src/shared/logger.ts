import { pino, type Logger, type LoggerOptions } from "pino";
import { getEnv } from "../config/env.js";

export const pinoOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (getEnv().NODE_ENV === "test" ? "silent" : "info"),
  base: {
    service: "cib-payment-module",
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-api-key']",
      "*.secret",
      "*.token",
      "*.password",
      "*.cardNumber",
      "*.card_number",
      "*.cvv",
      "*.pan",
    ],
    censor: "[REDACTED]",
  },
};

export const logger: Logger = pino(pinoOptions);
