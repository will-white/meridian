import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { INVESTMENTS_STALE_MS } from "../investments/queries.js";

/**
 * A CSV preview (`POST /import/positions/preview`, `POST /import/trades/preview`;
 * reads that write nothing) run as a query keyed by its body, with
 * `placeholderData: keepPreviousData`: while a changed body re-previews, the
 * last response stays on screen, so the mapping editor, the security choice
 * cells and the split-ratio inputs keep their state. A mutation would reset
 * `data` to undefined while the re-run is pending and unmount them on every
 * keystroke. The key carries `fileKey` (bumped per chosen file) and the CSV's
 * length in place of the text itself, so a large file is not re-hashed on
 * every render.
 */
export function previewQueryOptions<TBody extends { csvText: string }, TResponse>(path: string, body: TBody | null, fileKey: number) {
  const keyBody = body === null ? null : { ...body, csvText: body.csvText.length };
  return queryOptions({
    queryKey: ["import", "preview", path, fileKey, keyBody] as const,
    queryFn: () => api<TResponse>(path, { method: "POST", body }),
    enabled: body !== null,
    staleTime: INVESTMENTS_STALE_MS,
    gcTime: 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
}
