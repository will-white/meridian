/**
 * Navigations the service worker must not answer with its cached shell (vite.config.ts, workbox
 * `navigateFallbackDenylist`; workbox tests each pattern against the URL's pathname plus search).
 * They are the ones the server answers with a JSON 404 instead of the shell (apps/api/src/app.ts,
 * `servesShell`), so both halves of the SPA fallback follow one rule:
 * - the API's own paths: `/api` itself, `/api?…` and `/api/…`;
 * - build files: anything under `/assets/`, and any path whose last segment has an extension
 *   (a previous build's hashed chunk, `/favicon.ico`). Client-side routes have no dot in their
 *   last segment (App.tsx); a dot in the query does not count.
 * Imported by vite.config.ts, so it imports nothing.
 */
export const NAVIGATE_FALLBACK_DENYLIST: RegExp[] = [
  /^\/api(?:[/?]|$)/,
  /^\/assets(?:[/?]|$)/,
  /^[^?]*\/[^/?]*\.[^/?]*(?:\?|$)/,
];
