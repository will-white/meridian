import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyServerOptions } from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "@meridian/db";
import type { ApiConfig } from "./config.js";
import { registerErrorHandler } from "./lib/errors.js";
import { authPlugin } from "./plugins/auth.js";
import { accountRoutes } from "./routes/accounts.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { cashflowRoutes } from "./routes/cashflow.js";
import { categoryRoutes } from "./routes/categories.js";
import { connectionRoutes } from "./routes/connections.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { goalRoutes } from "./routes/goals.js";
import { importRoutes } from "./routes/import.js";
import { planRoutes } from "./routes/plan.js";
import { recurringRoutes } from "./routes/recurring.js";
import { ruleRoutes } from "./routes/rules.js";
import { settingsRoutes } from "./routes/settings.js";
import { transactionRoutes } from "./routes/transactions.js";

export interface BuildAppOptions {
  db: Db;
  config: ApiConfig;
  logger?: FastifyServerOptions["logger"];
  /** Injectable clock; routes derive the server's "today" from it. */
  now?: () => Date;
}

export async function buildApp({ db, config, logger, now }: BuildAppOptions) {
  const app = Fastify({
    logger: logger ?? config.nodeEnv !== "test",
    trustProxy: true,
    bodyLimit: 12 * 1024 * 1024, // CSV uploads travel in JSON bodies
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate("db", db);
  app.decorate("config", config);
  app.decorate("now", now ?? (() => new Date()));
  registerErrorHandler(app);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
      },
    },
  });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin);

  app.get("/api/health", { config: { auth: "public" }, schema: { response: { 200: z.object({ ok: z.literal(true) }) } } }, async () => ({ ok: true as const }));

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(connectionRoutes);
      await api.register(accountRoutes);
      await api.register(transactionRoutes);
      await api.register(categoryRoutes);
      await api.register(ruleRoutes);
      await api.register(importRoutes);
      // Phase 2
      await api.register(settingsRoutes);
      await api.register(planRoutes);
      await api.register(goalRoutes);
      await api.register(recurringRoutes);
      await api.register(cashflowRoutes);
      await api.register(dashboardRoutes);
      await api.register(auditRoutes);
    },
    { prefix: "/api" },
  );

  // Production: the API also serves the built PWA with an SPA fallback.
  if (config.webDistDir && existsSync(path.join(config.webDistDir, "index.html"))) {
    await app.register(fastifyStatic, { root: config.webDistDir, wildcard: false, index: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.status(404).send({ error: "Not found", code: "not_found" });
    });
  } else {
    app.setNotFoundHandler(async (_request, reply) => reply.status(404).send({ error: "Not found", code: "not_found" }));
  }

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
