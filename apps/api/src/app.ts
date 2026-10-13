import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

export async function buildApp() {
  const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet);
  await app.register(cookie, { secret: process.env.SESSION_SECRET ?? "dev-only" });

  app.get("/api/health", { schema: { response: { 200: z.object({ ok: z.literal(true) }) } } }, async () => ({
    ok: true as const,
  }));

  // Phase 1 routes land here: auth, connections, accounts, transactions, rules, import.

  return app;
}
