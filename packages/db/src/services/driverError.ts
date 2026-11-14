import { DrizzleQueryError } from "drizzle-orm";

/**
 * The database driver's own error behind a failed query.
 *
 * Since drizzle-orm 0.44 every failed query throws a `DrizzleQueryError` whose message is the SQL
 * text followed by its parameters and whose `cause` is the driver's error (postgres-js
 * `PostgresError`: `code` is the SQLSTATE, `message` the server's own text, e.g. `duplicate key
 * value violates unique constraint "user_username_unique"`). Code that decides by the SQLSTATE
 * looks at the driver's error, and so does any message that is shown, stored or logged: the
 * parameters are the row's values (a password hash, a household's payees and amounts). Anything
 * else, a failed query from drizzle-orm 0.38 included, is returned as it is.
 */
export function driverError(error: unknown): unknown {
  return error instanceof DrizzleQueryError && error.cause !== undefined ? error.cause : error;
}

/**
 * An error's message for a person, a stored record or a log: for a failed query, the driver's
 * (the server's own text, as before drizzle-orm 0.44), never the SQL text and its parameters.
 */
export function errorMessageOf(error: unknown): string {
  const e = driverError(error);
  return e instanceof Error ? e.message : String(e);
}
