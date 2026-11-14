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
import { defaultPlanner, type Planner } from "./planner.js";
import { registerErrorHandler } from "./lib/errors.js";
import { BODY_LIMIT } from "./lib/limits.js";
import { authPlugin } from "./plugins/auth.js";
import { requestGuardsPlugin } from "./plugins/requestGuards.js";
import { accountRoutes } from "./routes/accounts.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { cashflowRoutes } from "./routes/cashflow.js";
import { categoryRoutes } from "./routes/categories.js";
import { connectionRoutes } from "./routes/connections.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { goalRoutes } from "./routes/goals.js";
import { importRoutes } from "./routes/import.js";
import { investmentTxnRoutes } from "./routes/investmentTxns.js";
import { investmentViewRoutes } from "./routes/investmentViews.js";
import { performanceRoutes } from "./routes/performance.js";
import { planRoutes } from "./routes/plan.js";
import { priceRoutes } from "./routes/prices.js";
import { reconcileRoutes } from "./routes/reconcile.js";
import { recurringRoutes } from "./routes/recurring.js";
import { retirementRoutes } from "./routes/retirement.js";
import { ruleRoutes } from "./routes/rules.js";
import { securityRoutes } from "./routes/securities.js";
import { settingsRoutes } from "./routes/settings.js";
import { transactionRoutes } from "./routes/transactions.js";
import { userRoutes } from "./routes/users.js";
import { valuationRoutes } from "./routes/valuation.js";

export interface BuildAppOptions {
  db: Db;
  config: ApiConfig;
  logger?: FastifyServerOptions["logger"];
  /** Injectable clock; routes derive the server's "today" from it. */
  now?: () => Date;
  /** Injectable clock for sign-in only (session lifetimes, authenticator codes); the real time unless a test moves it. */
  authNow?: () => Date;
  /** The retirement planner's engine (`app.planner`, planner.ts); the engine package itself unless a test injects a fake. */
  planner?: Planner;
}

export async function buildApp({ db, config, logger, now, authNow, planner }: BuildAppOptions) {
  const app = Fastify({
    logger: logger ?? config.nodeEnv !== "test",
    // Only the listed reverse proxy may state the client address and the public host
    // (X-Forwarded-For / -Host / -Proto); from any other peer those headers are ignored.
    trustProxy: config.trustProxy.length > 0 ? config.trustProxy : false,
    bodyLimit: BODY_LIMIT.default,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate("db", db);
  app.decorate("config", config);
  app.decorate("now", now ?? (() => new Date()));
  app.decorate("authNow", authNow ?? (() => new Date()));
  app.decorate("planner", planner ?? defaultPlanner());
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
  await app.register(requestGuardsPlugin);
  await app.register(authPlugin);

  app.get("/api/health", { config: { auth: "public" }, schema: { response: { 200: z.object({ ok: z.literal(true) }) } } }, async () => ({ ok: true as const }));

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(userRoutes);
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
      // Phase 3
      await api.register(securityRoutes);
      await api.register(investmentTxnRoutes);
      await api.register(performanceRoutes);
      await api.register(priceRoutes);
      await api.register(valuationRoutes);
      await api.register(reconcileRoutes);
      await api.register(investmentViewRoutes);
      // Phase 4: the retirement planner (docs/design/phase-4/inputs-and-data.md §4.7, tax-rmd-ss §4.4).
      await api.register(retirementRoutes, { prefix: "/retirement" });
    },
    { prefix: "/api" },
  );

  // Production: the API also serves the built PWA with an SPA fallback. The shell (HTML,
  // scripts, styles, service worker, manifest, icon) holds no household data and has to load
  // for a browser with no session, or the setup and sign-in screens could never render. So
  // every file route registered in this scope is marked `static` (no session, no database);
  // all data stays under /api behind the default guard.
  const webDistDir = config.webDistDir;
  if (webDistDir && existsSync(path.join(webDistDir, "index.html"))) {
    await app.register(async (ui) => {
      ui.addHook("onRoute", (route) => {
        route.config = { ...route.config, auth: "static" };
      });
      // wildcard: false registers one exact route per file found at boot; nothing else is reachable.
      await ui.register(fastifyStatic, { root: webDistDir, wildcard: false, index: false });
      ui.setNotFoundHandler(async (request, reply) => {
        if (servesShell(request.method, request.url)) return reply.sendFile("index.html");
        return reply.status(404).send({ error: "Not found", code: "not_found" });
      });
    });
  } else {
    app.setNotFoundHandler(async (_request, reply) => reply.status(404).send({ error: "Not found", code: "not_found" }));
  }

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

/** The prefix itself or a path below it: `/api` and `/api/...`, not `/apiary`. */
const isUnder = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * Whether a request no route answered gets the app's shell (index.html) under the SPA fallback:
 * only a GET or HEAD of a client-side route. Everything else gets the JSON 404: the API's own
 * paths (`/api`, `/api?x=1` and `/api/...`), and any file the build does not have, which is
 * anything under `/assets/` or with an extension in its last segment (a previous build's hashed
 * chunk asked for by an open tab, `/favicon.ico`). HTML under a script's URL fails under
 * `nosniff` with a MIME-type error that hides the cause; a 404 says what happened. Client-side
 * routes have no dot in their last segment (App.tsx). The path is judged decoded, as the router
 * matches it (`/%61pi/x` is under /api). The service worker's navigation fallback follows the
 * same rule (apps/web/src/lib/shellRoutes.ts; audit a1-serve-and-guard, second round).
 */
function servesShell(method: string, url: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const raw = url.split("?", 1)[0] ?? "";
  let pathname = raw;
  try {
    pathname = decodeURIComponent(raw);
  } catch {
    // A malformed escape: judge the path as sent.
  }
  if (isUnder(pathname, "/api") || isUnder(pathname, "/assets")) return false;
  return !pathname.slice(pathname.lastIndexOf("/") + 1).includes(".");
}
