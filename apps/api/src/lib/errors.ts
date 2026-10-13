import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";

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

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | HttpError | Error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ error: error.message, code: error.code });
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
