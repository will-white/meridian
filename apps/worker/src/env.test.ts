import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./env.js";

describe("resolveDatabaseUrl", () => {
  it("assembles the URL from POSTGRES_* inside Docker and escapes the password", () => {
    expect(resolveDatabaseUrl({ MERIDIAN_DB_HOST: "db", POSTGRES_USER: "meridian", POSTGRES_PASSWORD: "p@ss/word", POSTGRES_DB: "meridian" })).toBe(
      "postgres://meridian:p%40ss%2Fword@db:5432/meridian",
    );
  });
  it("uses DATABASE_URL otherwise and fails loudly when nothing is set", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://x" })).toBe("postgres://x");
    expect(() => resolveDatabaseUrl({})).toThrow(/DATABASE_URL/);
  });
});
