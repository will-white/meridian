import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { INVESTMENTS_STALE_MS } from "../investments/queries.js";

/**
 * The CSV previews of the Import page (`POST /import/csv/preview`,
 * `/import/positions/preview`, `/import/trades/preview`; reads that write
 * nothing), run as a query keyed by its body: one request per change of the
 * file, account, profile, mapping, date, filter or choices, however often the
 * page renders and whichever object the mapping happens to be. (The bank flow
 * used a mutation re-run from an effect: each response put a new mapping
 * object in state, the effect saw a change and asked again, without end.)
 *
 * While a changed body re-previews, the last response of the same file stays
 * on screen, so the mapping editor, the security choice cells and the
 * split-ratio inputs keep their state; a mutation's `data` is undefined while
 * its re-run is pending and would unmount them on every keystroke. The key
 * carries `fileKey` (one per chosen file, `nextFileKey`) and the CSV's length
 * in place of the text itself, so a large file is not re-hashed on every render.
 */

/** Every preview's key starts with this. A commit invalidates it: what was stored changes what a preview says. */
export const PREVIEW_KEY = ["import", "preview"] as const;

let lastFileKey = 0;

/**
 * A key for a newly chosen file, unique while the app is open. A counter kept
 * by the page would start again when the page is left and reopened, and two
 * files of the same length could then share a cached preview.
 */
export function nextFileKey(): number {
  lastFileKey += 1;
  return lastFileKey;
}

export function previewQueryOptions<TBody extends { csvText: string }, TResponse>(path: string, body: TBody | null, fileKey: number) {
  const keyBody = body === null ? null : { ...body, csvText: body.csvText.length };
  return queryOptions({
    queryKey: [...PREVIEW_KEY, path, fileKey, keyBody] as const,
    queryFn: () => api<TResponse>(path, { method: "POST", body }),
    enabled: body !== null,
    staleTime: INVESTMENTS_STALE_MS,
    gcTime: 60_000,
    // The previous response of this file only: a new file starts from "Reading file…", never from another file's rows.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[3] === fileKey ? previous : undefined),
    refetchOnWindowFocus: false,
  });
}

/** The parts of a query result the preview logic reads. */
export interface PreviewResult<TResponse> {
  data: TResponse | undefined;
  isPlaceholderData: boolean;
  isFetching: boolean;
  error: Error | null;
}

/** The response that answers the current body: not the previous body's (a placeholder), not a refused one. */
export function settledPreview<TResponse>(result: Pick<PreviewResult<TResponse>, "data" | "isPlaceholderData">): TResponse | undefined {
  return result.isPlaceholderData ? undefined : result.data;
}

/**
 * The mapping the page takes from the server when it has none of its own (the
 * guess, or the saved profile's), or `null` when there is nothing to take: the
 * page already has a mapping (a response carries a new mapping object every
 * time and never replaces the owner's), the response has not settled, or the
 * server could not guess one.
 *
 * The response already answers the body that names that mapping (the server
 * used it to produce the response), so it is filed under that body's key and
 * taking the mapping costs no second request. `bodyFor(m)` must be the page's
 * request with mapping `m`: for `null` it names the saved profile (or nothing),
 * otherwise the mapping itself, and nothing else may differ.
 */
export function adoptPreviewMapping<TBody extends { csvText: string }, M, TResponse extends { mapping: M | null }>(
  qc: QueryClient,
  path: string,
  fileKey: number,
  result: Pick<PreviewResult<TResponse>, "data" | "isPlaceholderData">,
  mapping: M | null,
  bodyFor: (mapping: M | null) => TBody | null,
): M | null {
  const settled = settledPreview(result);
  if (mapping !== null || settled === undefined || settled.mapping === null) return null;
  const next = bodyFor(settled.mapping);
  if (next !== null) qc.setQueryData<TResponse>(previewQueryOptions<TBody, TResponse>(path, next, fileKey).queryKey, settled);
  return settled.mapping;
}

/** What the page shows of a preview. */
export interface PreviewView<TResponse> {
  /**
   * The response on screen: the current body's, else the last one this file
   * got, both while a changed body re-previews and after the server refused
   * it. What the owner needs to answer a refusal (the mapping editor, a choice
   * cell) lives in the cards this fills, so they must not go away with it.
   */
  shown: TResponse | undefined;
  /** `shown` answers the current body: only then may it be committed. */
  current: boolean;
  /** The first preview of a file is on its way and there is nothing to show yet. */
  reading: boolean;
  /** A preview is on its way while an earlier response is on screen. */
  updating: boolean;
  /** The server refused the current body (or could not be reached). */
  error: Error | null;
}

/** `kept` is the last settled response of the same file; a refused query has no data of its own, so the hook remembers it. */
export function previewView<TResponse>(result: PreviewResult<TResponse>, kept: TResponse | undefined): PreviewView<TResponse> {
  const shown = result.data ?? kept;
  return {
    shown,
    current: settledPreview(result) !== undefined,
    reading: shown === undefined && result.isFetching,
    updating: shown !== undefined && result.isFetching,
    error: result.error,
  };
}
