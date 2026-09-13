import type { FastifyError, FastifyInstance } from "fastify";
import { AppError, ErrorCode } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      void reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
      return;
    }

    if (error.validation !== undefined) {
      void reply.code(400).send({
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: "Request validation failed",
          details: error.validation,
        },
      });
      return;
    }

    logger.error(
      {
        event: "api.unhandled_error",
        method: request.method,
        url: request.url,
        error,
      },
      "unhandled request error"
    );

    void reply.code(500).send({
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: "Internal server error",
      },
    });
  });
}
