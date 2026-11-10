import fp from "fastify-plugin";
import type { z } from "zod";
import { looseWireFields, MAX_LIST_ITEMS } from "@meridian/shared";
import { HttpError } from "../lib/errors.js";

export { MAX_LIST_ITEMS };

/**
 * Checks every request passes before any route logic runs. None of them needs the database.
 *
 * onRequest (before authentication and before the body is read):
 *   - a change (any method but GET/HEAD/OPTIONS) must come from the app's own origin;
 *   - a change may only carry JSON, so an HTML form can never be a valid request.
 * preValidation (after the body is parsed, before its contract is checked):
 *   - no list or map longer than `MAX_LIST_ITEMS`, so a contract never validates more items
 *     than any route accepts (Zod 3 checks every element of an over-long array);
 *   - no NUL character in any text, which Postgres cannot store.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** A request that cannot change anything (and may be sent cross-site by a plain link). */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

export interface RequestProvenance {
  method: string;
  /** `Sec-Fetch-Site`: the browser's own verdict; scripts cannot set it. */
  secFetchSite: string | undefined;
  origin: string | undefined;
  /** The host the browser addressed: `Host`, or `X-Forwarded-Host` from a trusted proxy. */
  host: string;
}

/**
 * True when a state-changing request comes from another site or another origin.
 *
 * The session cookie is SameSite=Lax, which already keeps cross-site POSTs from carrying it,
 * but "site" is the registrable domain: a sibling host (another machine on the same tailnet
 * name, another service on the same home domain) is same-site and would pass. So changes
 * are also tied to the origin: `Sec-Fetch-Site` when the browser sends it (same-origin, or
 * none for a user-typed request), otherwise `Origin` against the request's own host. A
 * client that sends neither header is not a browser and is not exposed to cross-site forgery.
 */
export function isCrossSiteChange({ method, secFetchSite, origin, host }: RequestProvenance): boolean {
  if (isSafeMethod(method)) return false;
  if (secFetchSite !== undefined) {
    const site = secFetchSite.trim().toLowerCase();
    return site !== "same-origin" && site !== "none";
  }
  if (origin === undefined) return false;
  let from: URL;
  let own: URL;
  try {
    from = new URL(origin);
    // Parsing the host with the origin's scheme drops a default port on both sides alike.
    own = new URL(`${from.protocol}//${host}`);
  } catch {
    return true; // "null" (an opaque origin) or anything unparsable
  }
  return host === "" || from.host !== own.host;
}

/** True when a Content-Type header names something other than JSON. */
export function isNonJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
  return mediaType !== "application/json";
}

export type InputProblem = { kind: "too_many_items"; count: number } | { kind: "nul_character" };

/** Walks parsed input (a JSON body, the query string, path parameters) without recursion. */
export function findInputProblem(root: unknown, maxItems: number = MAX_LIST_ITEMS): InputProblem | null {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (value.includes("\u0000")) return { kind: "nul_character" };
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      if (value.length > maxItems) return { kind: "too_many_items", count: value.length };
      for (const item of value) stack.push(item);
      continue;
    }
    let keys = 0;
    for (const key in value) {
      if (key.includes("\u0000")) return { kind: "nul_character" };
      stack.push((value as Record<string, unknown>)[key]);
      keys++;
    }
    if (keys > maxItems) return { kind: "too_many_items", count: keys };
  }
  return null;
}

export const requestGuardsPlugin = fp(async (app) => {
  // A programming error, caught the first time the app is built (every API test builds it):
  // what a caller sends must use the bounded wire shapes (wire.ts), never the loose ones.
  app.addHook("onRoute", (route) => {
    const schema = route.schema as { body?: z.ZodTypeAny; querystring?: z.ZodTypeAny; params?: z.ZodTypeAny } | undefined;
    for (const part of ["body", "querystring", "params"] as const) {
      const loose = looseWireFields(schema?.[part]);
      if (loose.length > 0) {
        throw new Error(`${String(route.method)} ${route.url}: the request ${part} uses unbounded wire shapes at ${loose.join(", ")}; use CentsInput, IsoDateInput or MonthInput`);
      }
    }
  });

  app.addHook("onRequest", async (request) => {
    if (isSafeMethod(request.method)) return;
    const header = (name: string): string | undefined => {
      const value = request.headers[name];
      return Array.isArray(value) ? value.join(",") : value;
    };
    if (isCrossSiteChange({ method: request.method, secFetchSite: header("sec-fetch-site"), origin: header("origin"), host: request.host })) {
      throw new HttpError(403, "Cross-site request refused", "cross_site_request");
    }
    if (isNonJsonContentType(header("content-type"))) {
      throw new HttpError(415, "Send changes as application/json", "unsupported_media_type");
    }
  });

  app.addHook("preValidation", async (request) => {
    for (const part of [request.body, request.query, request.params]) {
      const problem = findInputProblem(part);
      if (problem?.kind === "too_many_items") {
        throw new HttpError(413, `A list in the request has too many items (${problem.count}, at most ${MAX_LIST_ITEMS})`, "too_many_items");
      }
      if (problem?.kind === "nul_character") {
        throw new HttpError(400, "Text in the request contains a NUL character (a file saved as UTF-16? Save it as UTF-8)", "validation");
      }
    }
  });
});
