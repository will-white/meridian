import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adoptPreviewMapping, previewQueryOptions, previewView, settledPreview, type PreviewView } from "./previewQuery.js";

/**
 * The preview of one Import flow (bank, positions or trades): the query keyed
 * by the page's request, the mapping taken from the server when the page has
 * none, and the last response of the file kept on screen when a change is
 * refused. The rules are the pure functions of `previewQuery.ts` (tested
 * there); this hook only connects them to React state.
 *
 * `bodyFor(m)` is the page's request with mapping `m` (the builders of
 * `lib/importMapping.ts`); `onMapping` stores the mapping in the page's state.
 */
export function useCsvPreview<TBody extends { csvText: string }, M, TResponse extends { mapping: M | null }>(args: {
  path: string;
  /** `nextFileKey()` of the chosen file. */
  fileKey: number;
  mapping: M | null;
  onMapping: (mapping: M) => void;
  bodyFor: (mapping: M | null) => TBody | null;
}): PreviewView<TResponse> {
  const { path, fileKey, mapping, onMapping, bodyFor } = args;
  const qc = useQueryClient();
  const query = useQuery(previewQueryOptions<TBody, TResponse>(path, bodyFor(mapping), fileKey));
  const settled = settledPreview(query);
  const [kept, setKept] = useState<{ fileKey: number; response: TResponse } | null>(null);

  useEffect(() => {
    if (settled === undefined) return;
    setKept((prev) => (prev !== null && prev.fileKey === fileKey && prev.response === settled ? prev : { fileKey, response: settled }));
    // Runs when a response settles or the page's mapping is cleared (a new file, another profile): never per render.
    const adopted = adoptPreviewMapping(qc, path, fileKey, { data: settled, isPlaceholderData: false }, mapping, bodyFor);
    if (adopted !== null) onMapping(adopted);
    // `bodyFor` and `onMapping` are new functions on every render; the values they close over are the render's own.
  }, [settled, mapping, fileKey, path, qc]);

  return previewView(query, kept !== null && kept.fileKey === fileKey ? kept.response : undefined);
}
