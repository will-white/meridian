import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { PlanError } from "@meridian/db";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (what = "Not found") => new HttpError(404, what, "not_found");
export const badRequest = (message: string, code = "bad_request") => new HttpError(400, message, code);
export const unauthorized = (message = "Sign in required", code = "unauthorized") => new HttpError(401, message, code);
export const forbidden = (message = "Not allowed", code = "forbidden") => new HttpError(403, message, code);

/**
 * Postgres "data exception" (SQLSTATE class 22): a value the database refused as out of
 * range or malformed, e.g. a product of two valid inputs that no longer fits its column.
 * The request contracts stop these at the edge; this is the net under them, so what gets
 * through is still the caller's 400 and not a 500 with a stack trace in the log.
 */
function isDataException(error: unknown): boolean {
  const e = error as { name?: unknown; code?: unknown } | null;
  return typeof e === "object" && e !== null && e.name === "PostgresError" && typeof e.code === "string" && e.code.startsWith("22");
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | HttpError | PlanError | Error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ error: error.message, code: error.code });
    }
    // Typed service failures carry their own status and code (most route plugins also map them through usePlanErrors).
    if (error instanceof PlanError) {
      return reply.status(error.status).send({ error: error.message, code: error.code });
    }
    if (isDataException(error)) {
      request.log.warn({ err: error }, "the database refused a value from the request");
      return reply.status(400).send({ error: "A value in the request is out of range or not valid", code: "invalid_value" });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const first = error.validation[0];
      const where = first?.instancePath ? `${first.instancePath.replace(/^\//, "")}: ` : "";
      return reply.status(400).send({ error: `${where}${first?.message ?? "invalid request"}`, code: "validation" });
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error, issues: error.cause.issues }, "response did not match its schema");
      return reply.status(500).send({ error: "Internal error", code: "serialization" });
    }
    const fastifyError = error as FastifyError;
    if (typeof fastifyError.statusCode === "number" && fastifyError.statusCode < 500) {
      return reply.status(fastifyError.statusCode).send({ error: fastifyError.message, code: fastifyError.code ?? "error" });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: "Internal error", code: "internal" });
  });
}
