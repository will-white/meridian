import { Writable } from "node:stream";
import { DrizzleQueryError } from "drizzle-orm";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerErrorHandler } from "./errors.js";

/**
 * drizzle-orm 0.44 and later throw every failed query as a `DrizzleQueryError` whose message is
 * the SQL and its parameters, with the driver's `PostgresError` as `cause`. The handler still
 * answers by the SQLSTATE (decisions 11 and 110) and logs the driver's error, never the
 * parameters (here a password hash).
 */

const pgError = (code: string, message: string) => Object.assign(new Error(message), { name: "PostgresError", code, severity: "ERROR" });
const wrapped = (cause: Error) => new DrizzleQueryError('insert into "user" ("username", "password_hash") values ($1, $2)', ["sam", "$argon2id$v=19$secret-hash"], cause);

async function appThrowing(error: unknown) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString("utf8"));
      done();
    },
  });
  const app = Fastify({ logger: { level: "warn", stream } });
  registerErrorHandler(app);
  app.get("/fail", async () => {
    throw error;
  });
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/fail" });
  await app.close();
  return { res, log: lines.join("") };
}

describe("database errors behind drizzle-orm's DrizzleQueryError", () => {
  it("answers a foreign-key violation on an insert as the caller's 400 unknown_reference (decision 110)", async () => {
    const { res, log } = await appThrowing(wrapped(pgError("23503", 'insert or update on table "transaction" violates foreign key constraint "transaction_category_id_category_id_fk"')));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "The request refers to something that does not exist (it may have been deleted)", code: "unknown_reference" });
    expect(log).toContain("violates foreign key constraint");
    expect(log).not.toContain("secret-hash");
  });

  it("answers a data exception (SQLSTATE class 22) as 400 invalid_value (decision 11)", async () => {
    const { res, log } = await appThrowing(wrapped(pgError("22003", "numeric field overflow")));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_value");
    expect(log).toContain("numeric field overflow");
    expect(log).not.toContain("secret-hash");
  });

  it("answers anything else 500 and logs the driver's error without the query's parameters", async () => {
    const { res, log } = await appThrowing(wrapped(pgError("23505", 'duplicate key value violates unique constraint "user_username_unique"')));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Internal error", code: "internal" });
    expect(log).toContain("duplicate key value violates unique constraint");
    expect(log).toContain('"code":"23505"');
    expect(log).not.toContain("secret-hash");
    expect(log).not.toContain("Failed query");
  });

  it("keeps a delete refused by rows that still point at the row a 500, as before", async () => {
    const { res } = await appThrowing(wrapped(pgError("23503", 'update or delete on table "category" violates foreign key constraint "transaction_category_id_category_id_fk" on table "transaction"')));
    expect(res.statusCode).toBe(500);
  });
});
