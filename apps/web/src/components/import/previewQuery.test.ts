import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { CsvMapping, guessCsvMapping, mapCsvRows, parseCsv, previewCells } from "@meridian/shared";
import type { CsvMappingInput, CsvPreviewResponse, PositionsCsvMapping, PositionsPreviewBody, PositionsPreviewResponse } from "@meridian/shared";
import { api, ApiError } from "../../lib/api.js";
import { bankColumnOptions, bankFirstRow, bankPreviewBody, handBuiltBankMapping, positionsPreviewBody, setBankColumn, setBankHasHeader, type BankPreviewBody } from "../../lib/importMapping.js";
import { adoptPreviewMapping, keptFor, nextFileKey, nextKept, PREVIEW_KEY, previewQueryOptions, previewView, settledPreview, type KeptPreview } from "./previewQuery.js";

interface Body {
  csvText: string;
  accountId: string;
  n: number;
}
interface Res {
  echo: number;
}

/** A fetch stub that answers each preview with `{ echo: body.n }` once `release(n)` is called. */
function stubFetch() {
  const pending = new Map<number, () => void>();
  const released = new Set<number>();
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    if (!released.has(body.n)) await new Promise<void>((resolve) => pending.set(body.n, resolve));
    return new Response(JSON.stringify({ echo: body.n }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  const release = (n: number) => {
    released.add(n);
    pending.get(n)?.();
  };
  return { fetch, release };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("previewQueryOptions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the last response on screen while a changed body re-previews (no unmount between previews)", async () => {
    const { release } = stubFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const body1: Body = { csvText: "a,b\n1,2\n", accountId: "acct", n: 1 };
    const observer = new QueryObserver(qc, previewQueryOptions<Body, Res>("/import/trades/preview", body1, 1));
    const unsubscribe = observer.subscribe(() => undefined);
    release(1);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual({ echo: 1 }));

    // A choice changes: the body (and the key) change, the re-preview is pending.
    observer.setOptions(previewQueryOptions<Body, Res>("/import/trades/preview", { ...body1, n: 2 }, 1));
    await tick();
    const during = observer.getCurrentResult();
    expect(during.isFetching).toBe(true);
    expect(during.isPlaceholderData).toBe(true);
    expect(during.data).toEqual({ echo: 1 });

    release(2);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual({ echo: 2 }));
    expect(observer.getCurrentResult().isPlaceholderData).toBe(false);
    unsubscribe();
    qc.clear();
  });

  it("is disabled without a body and keys by file and body, never by the CSV text itself", () => {
    const body: Body = { csvText: "x".repeat(1000), accountId: "acct", n: 3 };
    const off = previewQueryOptions<Body, Res>("/import/positions/preview", null, 2);
    expect(off.enabled).toBe(false);
    expect(off.queryKey).toEqual(["import", "preview", "/import/positions/preview", 2, null]);
    const on = previewQueryOptions<Body, Res>("/import/positions/preview", body, 2);
    expect(on.enabled).toBe(true);
    expect(on.queryKey).toEqual(["import", "preview", "/import/positions/preview", 2, { csvText: 1000, accountId: "acct", n: 3 }]);
    expect(JSON.stringify(on.queryKey)).not.toContain("xxxx");
  });

  it("documents why: a mutation's data is undefined while its re-run is pending", async () => {
    const { release } = stubFetch();
    const qc = new QueryClient();
    const mutation = new MutationObserver(qc, { mutationFn: (body: Body) => api<Res>("/import/trades/preview", { method: "POST", body }) });
    const body1: Body = { csvText: "a,b\n1,2\n", accountId: "acct", n: 1 };
    const first = mutation.mutate(body1);
    release(1);
    await first;
    expect(mutation.getCurrentResult().data).toEqual({ echo: 1 });
    const second = mutation.mutate({ ...body1, n: 2 });
    await tick();
    expect(mutation.getCurrentResult().data).toBeUndefined();
    release(2);
    await second;
    qc.clear();
  });
});

describe("the response kept on screen (audit b4-import-ui, second round)", () => {
  const A = { mapping: null, n: 1 };
  const B = { mapping: null, n: 2 };

  it("keeps the last settled response of the file, as the same object while nothing changes", () => {
    expect(nextKept(null, 1, undefined)).toBeNull();
    const kept = nextKept(null, 1, A);
    expect(kept).toEqual({ fileKey: 1, response: A });
    // The same answer again: the same state, so the hook's setState renders nothing more.
    expect(nextKept(kept, 1, A)).toBe(kept);
    // A pending or refused body has no settled response: the last answer stays.
    expect(nextKept(kept, 1, undefined)).toBe(kept);
    expect(nextKept(kept, 1, B)).toEqual({ fileKey: 1, response: B });
  });

  it("shows only the chosen file's answer, never another file's", () => {
    const kept: KeptPreview<typeof A> = { fileKey: 1, response: A };
    expect(keptFor(kept, 1)).toBe(A);
    expect(keptFor(kept, 2)).toBeUndefined();
    expect(keptFor(null, 1)).toBeUndefined();
    // The next file's first preview is refused: nothing of the first file is on screen.
    const refused = { data: undefined, isPlaceholderData: false, isFetching: false, error: new Error("The file is empty") };
    expect(previewView(refused, keptFor(nextKept(kept, 2, settledPreview(refused)), 2))).toMatchObject({ shown: undefined, current: false, reading: false });
    expect(previewView(refused, keptFor(nextKept(kept, 1, settledPreview(refused)), 1)).shown).toBe(A);
  });
});

// ---------------------------------------------------------------------------
// The page's preview flow, without React. The hook (`useCsvPreview`) is
// `useQuery(previewQueryOptions(path, bodyFor(mapping), fileKey))` plus one
// effect that keeps the settled response (`nextKept`) and calls
// `adoptPreviewMapping`; `Page` is that loop. `useCsvPreview.test.ts` runs the
// hook itself.
// ---------------------------------------------------------------------------

class Page<TBody extends { csvText: string }, M, TResponse extends { mapping: M | null }> {
  mapping: M | null = null;
  fileKey = nextFileKey();
  kept: KeptPreview<TResponse> | null = null;
  readonly observer;
  private readonly unsubscribe: () => void;

  constructor(
    readonly qc: QueryClient,
    private readonly path: string,
    private readonly bodyFor: (mapping: M | null) => TBody | null,
  ) {
    this.observer = new QueryObserver(qc, this.options());
    this.unsubscribe = this.observer.subscribe(() => undefined);
  }

  private options() {
    return previewQueryOptions<TBody, TResponse>(this.path, this.bodyFor(this.mapping), this.fileKey);
  }

  /** Render, wait for the request (if any), run the effect; again while the effect changed the state. */
  async settle() {
    for (let pass = 0; pass < 10; pass++) {
      this.observer.setOptions(this.options());
      await vi.waitFor(() => expect(this.observer.getCurrentResult().isFetching).toBe(false));
      const result = this.observer.getCurrentResult();
      this.kept = nextKept(this.kept, this.fileKey, settledPreview(result));
      const adopted = adoptPreviewMapping(this.qc, this.path, this.fileKey, result, this.mapping, this.bodyFor);
      if (adopted === null) return result;
      this.mapping = adopted;
    }
    throw new Error("the preview never settled");
  }

  /** What the page shows: the hook's `previewView(query, keptFor(kept, fileKey))`. */
  view() {
    return previewView(this.observer.getCurrentResult(), keptFor(this.kept, this.fileKey));
  }

  close() {
    this.unsubscribe();
    this.qc.clear();
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sentBodies = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);

const BANK_CSV = "Date,Description,Amount\n11/01/2026,OAKWOOD APTS RENT,-1800.00\n11/02/2026,ACME PAYROLL,2500.00\n";
const BANK_GUESS: CsvMappingInput = { hasHeader: true, skipRows: 0, date: { column: "Date", format: "MM/DD/YYYY" }, description: { column: "Description" }, amount: { mode: "single", column: "Amount", invert: false } };
const BANK_PROFILE: CsvMappingInput = { ...BANK_GUESS, amount: { mode: "single", column: "Amount", invert: true } };
const ACCT = "7f0e1c7e-3a53-4b0e-9a4c-0d6a4f3a1b11";
const PROFILE = "5b0c2f4e-9d1a-4a8e-8c57-2e1f6f0a9c22";

/** The bank preview route as the page sees it: the mapping it used comes back as a new object on every response. */
function bankServer() {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as BankPreviewBody;
    const used = body.mapping ?? (body.profileId ? BANK_PROFILE : BANK_GUESS);
    if (used.hasHeader === false) return json(400, { error: 'Column "Date" referenced by name, but the file has no header row', code: "bad_mapping" });
    const response: CsvPreviewResponse = {
      headers: ["Date", "Description", "Amount"],
      sampleRows: [["Date", "Description", "Amount"]],
      mapping: structuredClone(used) as CsvPreviewResponse["mapping"],
      rows: [],
      totalRows: 2,
      duplicateCount: body.accountId ? 1 : 0,
      errors: [],
    };
    return json(200, response);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function bankPage() {
  const state = { csvText: BANK_CSV, accountId: "", profileId: "" };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = new Page<BankPreviewBody, CsvMappingInput, CsvPreviewResponse>(qc, "/import/csv/preview", (mapping) => bankPreviewBody({ ...state, mapping }));
  return { state, page };
}

describe("the bank preview flow", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("documents the loop it had: a mutation re-run whenever the mapping object changes never settles", async () => {
    const fetch = bankServer();
    const qc = new QueryClient();
    const mutation = new MutationObserver(qc, { mutationFn: (body: BankPreviewBody) => api<CsvPreviewResponse>("/import/csv/preview", { method: "POST", body }) });
    // The old page: `useEffect(() => preview.mutate(body), [csvText, accountId, profileId, mapping])` and `onSuccess: (res) => setMapping(res.mapping)`.
    let mapping: CsvMappingInput | null = null;
    let seenByEffect: unknown = undefined;
    for (let render = 0; render < 6; render++) {
      if (mapping === seenByEffect) break;
      seenByEffect = mapping;
      const res: CsvPreviewResponse = await mutation.mutate({ csvText: BANK_CSV, ...(mapping ? { mapping } : {}) });
      mapping = res.mapping;
    }
    // Six renders, six requests, and the seventh render would ask again: the mapping is equal every time and never the same object.
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(mapping).not.toBe(seenByEffect);
    expect(mapping).toEqual(seenByEffect);
    qc.clear();
  });

  it("previews a chosen file once: the guessed mapping becomes the page's without a second request", async () => {
    const fetch = bankServer();
    const { state, page } = bankPage();
    const result = await page.settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentBodies(fetch)).toEqual([{ csvText: BANK_CSV }]);
    expect(page.mapping).toEqual(BANK_GUESS);
    // The page's request now names the mapping, and the first response is its answer: nothing is pending, nothing is a placeholder.
    expect(bankPreviewBody({ ...state, mapping: page.mapping })).toEqual({ csvText: BANK_CSV, mapping: BANK_GUESS });
    expect(result).toMatchObject({ isFetching: false, isPlaceholderData: false, data: { totalRows: 2, duplicateCount: 0 } });
    expect(previewView(result, undefined)).toMatchObject({ current: true, reading: false, updating: false, error: null });
    // Rendering again asks nothing.
    await page.settle();
    await page.settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    page.close();
  });

  it("previews once per change, and a response's mapping never replaces the page's", async () => {
    const fetch = bankServer();
    const { state, page } = bankPage();
    await page.settle();

    state.accountId = ACCT;
    const withAccount = await page.settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sentBodies(fetch)[1]).toEqual({ csvText: BANK_CSV, accountId: ACCT, mapping: BANK_GUESS });
    expect(withAccount.data?.duplicateCount).toBe(1);

    // The owner flips "outflows are positive": one request, and the object in state is still the owner's.
    const edited: CsvMappingInput = { ...BANK_GUESS, amount: { mode: "single", column: "Amount", invert: true } };
    page.mapping = edited;
    const afterEdit = await page.settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sentBodies(fetch)[2]).toEqual({ csvText: BANK_CSV, accountId: ACCT, mapping: edited });
    expect(afterEdit.data?.mapping).toEqual(edited);
    expect(afterEdit.data?.mapping).not.toBe(edited);
    expect(page.mapping).toBe(edited);
    await page.settle();
    expect(fetch).toHaveBeenCalledTimes(3);

    // Back to the first mapping within the stale time: answered from the cache.
    page.mapping = BANK_GUESS;
    await page.settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    page.close();
  });

  it("asks for a saved profile once and takes its mapping", async () => {
    const fetch = bankServer();
    const { state, page } = bankPage();
    await page.settle();
    // The profile select: `setProfileId(id); setMapping(null)`.
    state.profileId = PROFILE;
    page.mapping = null;
    const result = await page.settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sentBodies(fetch)[1]).toEqual({ csvText: BANK_CSV, profileId: PROFILE });
    expect(page.mapping).toEqual(BANK_PROFILE);
    expect(previewView(result, undefined).current).toBe(true);
    await page.settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    page.close();
  });

  it("keeps the last preview of the file on screen when the server refuses a change, so the change can be undone", async () => {
    const fetch = bankServer();
    const { page } = bankPage();
    const good = await page.settle();
    const kept = good.data;
    // "first row is a header" unchecked: the columns are named by header, so the server answers 400.
    page.mapping = { ...BANK_GUESS, hasHeader: false };
    const refused = await page.settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refused.data).toBeUndefined();
    expect(refused.error).toBeInstanceOf(ApiError);
    const view = previewView(refused, kept);
    expect(view.shown).toBe(kept);
    expect(page.view()).toEqual(view);
    expect(view).toMatchObject({ current: false, reading: false, updating: false });
    expect(view.error?.message).toBe('Column "Date" referenced by name, but the file has no header row');
    // Without a remembered response there would be nothing to show (what the page did before).
    expect(previewView(refused, undefined).shown).toBeUndefined();
    // Checking the box again is the earlier request: its answer is still there.
    page.mapping = BANK_GUESS;
    const undone = await page.settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(previewView(undone, kept)).toMatchObject({ current: true, error: null });
    page.close();
  });

  it("starts a new file from nothing: another file's preview is never shown for it", async () => {
    const fetch = vi.fn(async () => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetch);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = nextFileKey();
    const second = nextFileKey();
    expect(second).not.toBe(first);
    const earlier: CsvPreviewResponse = { headers: ["a"], sampleRows: [], mapping: null, rows: [], totalRows: 9, duplicateCount: 0, errors: [] };
    qc.setQueryData(previewQueryOptions<BankPreviewBody, CsvPreviewResponse>("/import/csv/preview", { csvText: "a\n1\n" }, first).queryKey, earlier);
    const observer = new QueryObserver(qc, previewQueryOptions<BankPreviewBody, CsvPreviewResponse>("/import/csv/preview", { csvText: "a\n1\n" }, first));
    const unsubscribe = observer.subscribe(() => undefined);
    expect(observer.getCurrentResult().data).toBe(earlier);
    // A file of the same length is chosen: a new key, no placeholder, "Reading file…".
    observer.setOptions(previewQueryOptions<BankPreviewBody, CsvPreviewResponse>("/import/csv/preview", { csvText: "b\n2\n" }, second));
    const result = observer.getCurrentResult();
    expect(result.data).toBeUndefined();
    expect(previewView(result, undefined)).toMatchObject({ shown: undefined, current: false, reading: true, updating: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    unsubscribe();
    qc.clear();
  });

  it("files every preview under one key, so a commit can make them all ask again", () => {
    expect(previewQueryOptions<BankPreviewBody, CsvPreviewResponse>("/import/csv/preview", { csvText: "a" }, 7).queryKey.slice(0, 2)).toEqual([...PREVIEW_KEY]);
  });
});

// ---------------------------------------------------------------------------
// Bank: a file without a header row (audit b4-import-ui, second round)
// ---------------------------------------------------------------------------

const HEADERLESS_CSV = "11/07/2026,OAKWOOD APTS RENT,-1800.00\n11/08/2026,ACME PAYROLL,2500.00\n11/09/2026,KING SOOPERS,-82.13\n";
const HEADERLESS_FIRST_ROW = ["11/07/2026", "OAKWOOD APTS RENT", "-1800.00"];
/** What "Build a mapping by hand" gave this file before: its first row taken as the header. */
const HEADERLESS_BY_NAME: CsvMappingInput = {
  hasHeader: true,
  date: { column: "11/07/2026", format: "MM/DD/YYYY" },
  description: { column: "OAKWOOD APTS RENT" },
  amount: { mode: "single", column: "-1800.00", invert: false },
};

/**
 * The bank preview route as `apps/api/src/routes/import.ts` runs it, with the shared mapper: the
 * guess from the first row, `mapCsvRows`, and a 400 for a mapping the file cannot take.
 */
function mapperServer() {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as BankPreviewBody;
    const rows = parseCsv(body.csvText);
    const headers = previewCells([rows[0]!])[0]!;
    const mapping = body.mapping ?? guessCsvMapping(headers, rows.slice(1, 6));
    const sampleRows = previewCells(rows.slice(0, 6));
    if (!mapping) return json(200, { headers, sampleRows, mapping: null, rows: [], totalRows: Math.max(rows.length - 1, 0), duplicateCount: 0, errors: [] } satisfies CsvPreviewResponse);
    try {
      const mapped = await mapCsvRows(rows, mapping);
      const response: CsvPreviewResponse = {
        headers: mapping.hasHeader === false ? headers.map((_, i) => `Column ${i + 1}`) : headers,
        sampleRows,
        mapping: CsvMapping.parse(mapping),
        rows: mapped.rows.map((m) => ({ rowIndex: m.rowIndex, date: m.date, amountCents: m.amountCents.toString(), description: m.description, ...(m.memo ? { memo: m.memo } : {}), externalId: m.externalId, duplicate: false })),
        totalRows: mapped.rows.length,
        duplicateCount: 0,
        errors: mapped.errors,
      };
      return json(200, response);
    } catch (err) {
      return json(400, { error: (err as Error).message, code: "bad_mapping" });
    }
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function headerlessPage() {
  const state = { csvText: HEADERLESS_CSV, accountId: "", profileId: "" };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return new Page<BankPreviewBody, CsvMappingInput, CsvPreviewResponse>(qc, "/import/csv/preview", (mapping) => bankPreviewBody({ ...state, mapping }));
}

const rowsOf = (p: CsvPreviewResponse | undefined) => p?.rows.map((r) => [r.date, r.description, r.amountCents]);

describe("the bank preview flow for a file without a header row (audit b4-import-ui, second round)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("finds no guess, and the mapping built by hand reads every row by position", async () => {
    const fetch = mapperServer();
    const page = headerlessPage();
    const asked = await page.settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(asked.data?.mapping).toBeNull();
    expect(page.mapping).toBeNull();
    expect(bankFirstRow(asked.data!)).toEqual(HEADERLESS_FIRST_ROW);

    // "Build a mapping by hand".
    page.mapping = handBuiltBankMapping(asked.data!.sampleRows);
    const built = await page.settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(built.error).toBeNull();
    expect(built.data).toMatchObject({ headers: ["Column 1", "Column 2", "Column 3"], mapping: { hasHeader: false }, totalRows: 3, errors: [] });
    expect(rowsOf(built.data)).toEqual([
      ["2026-11-07", "OAKWOOD APTS RENT", "-180000"],
      ["2026-11-08", "ACME PAYROLL", "250000"],
      ["2026-11-09", "KING SOOPERS", "-8213"],
    ]);

    // The editor offers positions, labelled with the first row; a pick is stored as a position the server reads.
    const options = bankColumnOptions(bankFirstRow(built.data!), false);
    expect(options.map((o) => o.value)).toEqual(["0", "1", "2"]);
    page.mapping = setBankColumn(setBankColumn(page.mapping, "date", options[0]!.value), "memo", options[1]!.value);
    expect(page.mapping).toMatchObject({ date: { column: 0 }, memo: { column: 1 } });
    const picked = await page.settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(picked.error).toBeNull();
    expect(picked.data?.totalRows).toBe(3);
    expect(picked.data?.rows[2]).toMatchObject({ description: "KING SOOPERS", memo: "KING SOOPERS" });
    page.close();
  });

  it("turns a mapping by name into one by position when 'first row is a header' is unchecked, and back when it is checked", async () => {
    const fetch = mapperServer();
    const page = headerlessPage();
    await page.settle();
    page.mapping = HEADERLESS_BY_NAME;
    const byName = await page.settle();
    // The first row is taken as the header: two rows, the rent is lost.
    expect(byName.data?.totalRows).toBe(2);

    // The box as it was: the same names with hasHeader false, which the server refuses; no edit could reach a valid mapping.
    page.mapping = { ...HEADERLESS_BY_NAME, hasHeader: false };
    const refused = await page.settle();
    expect(refused.error?.message).toBe('Column "11/07/2026" referenced by name, but the file has no header row');
    expect(page.view().shown).toBe(byName.data);

    // The box now rewrites the columns from the first row of the response on screen.
    page.mapping = setBankHasHeader(HEADERLESS_BY_NAME, false, bankFirstRow(page.view().shown!));
    const byPosition = await page.settle();
    expect(byPosition.error).toBeNull();
    expect(byPosition.data).toMatchObject({ mapping: { hasHeader: false, date: { column: 0 }, description: { column: 1 }, amount: { column: 2 } }, totalRows: 3 });
    expect(page.view()).toMatchObject({ current: true, error: null });

    // Checked again: the names come back, and that preview is still in the cache.
    page.mapping = setBankHasHeader(page.mapping, true, bankFirstRow(byPosition.data!));
    expect(page.mapping).toEqual(HEADERLESS_BY_NAME);
    const back = await page.settle();
    expect(back.data?.totalRows).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(4);
    page.close();
  });
});

// ---------------------------------------------------------------------------
// Positions: a file without a date column (the Fidelity-style export)
// ---------------------------------------------------------------------------

const POSITIONS_CSV = "Symbol,Description,Quantity,Last Price,Current Value\nVTI,VANGUARD TOTAL STOCK MARKET ETF,22,$318.40,\"$7,004.80\"\n";
const POSITIONS_GUESS: PositionsCsvMapping = { hasHeader: true, skipRows: 0, asOf: { mode: "request" }, symbol: { column: "Symbol" }, name: { column: "Description" }, quantity: { column: "Quantity" }, price: { column: "Last Price" }, value: { column: "Current Value" } };

/** The positions preview route: without a date it answers with the mapping and `asOfRequired`, never a refusal. */
function positionsServer() {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as PositionsPreviewBody;
    const dated = body.asOfDate !== undefined;
    const response: PositionsPreviewResponse = {
      headers: ["Symbol", "Description", "Quantity", "Last Price", "Current Value"],
      sampleRows: [],
      mapping: structuredClone(body.mapping ?? POSITIONS_GUESS),
      asOf: body.asOfDate ?? null,
      asOfRequired: !dated,
      positions: [],
      totalValueCents: dated ? "700480" : "0",
      knownBalanceCents: null,
      differenceCents: null,
      matchesToDollar: null,
      setBalanceDefault: true,
      filterValues: [],
      pendingActivityCents: "0",
      snapshotExists: false,
      existingSource: null,
      willReplace: dated,
      rowsRead: 1,
      errors: [],
      skipped: [],
    };
    return json(200, response);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("the positions preview flow for a file without a date column", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("previews once, shows the guessed mapping, then waits for the statement date and previews once more", async () => {
    const fetch = positionsServer();
    const state = { csvText: POSITIONS_CSV, accountId: ACCT, profileId: "", asOfDate: "", accountFilterValue: "", choices: [] };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = new Page<PositionsPreviewBody, PositionsCsvMapping, PositionsPreviewResponse>(qc, "/import/positions/preview", (mapping) => positionsPreviewBody({ ...state, mapping }));

    const asked = await page.settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentBodies(fetch)[0]).toEqual({ csvText: POSITIONS_CSV, accountId: ACCT, choices: [] });
    // The mapping is on the page (the editor with its date field can render) and the response stays on screen.
    expect(page.mapping).toEqual(POSITIONS_GUESS);
    const waiting = previewView(asked, undefined);
    expect(waiting.shown).toMatchObject({ asOfRequired: true, asOf: null, mapping: POSITIONS_GUESS });
    expect(waiting).toMatchObject({ current: false, reading: false, updating: false, error: null });
    // Nothing is sent while the date is missing.
    expect(positionsPreviewBody({ ...state, mapping: page.mapping })).toBeNull();
    await page.settle();
    expect(fetch).toHaveBeenCalledTimes(1);

    state.asOfDate = "2026-10-30";
    const dated = await page.settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sentBodies(fetch)[1]).toEqual({ csvText: POSITIONS_CSV, accountId: ACCT, choices: [], mapping: POSITIONS_GUESS, asOfDate: "2026-10-30" });
    expect(previewView(dated, undefined)).toMatchObject({ current: true, shown: { asOf: "2026-10-30", asOfRequired: false, totalValueCents: "700480" } });
    await page.settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    page.close();
  });

  it("needs one request when the date was typed before the file was chosen", async () => {
    const fetch = positionsServer();
    const state = { csvText: POSITIONS_CSV, accountId: ACCT, profileId: "", asOfDate: "2026-10-30", accountFilterValue: "", choices: [] };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = new Page<PositionsPreviewBody, PositionsCsvMapping, PositionsPreviewResponse>(qc, "/import/positions/preview", (mapping) => positionsPreviewBody({ ...state, mapping }));
    const result = await page.settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(page.mapping).toEqual(POSITIONS_GUESS);
    expect(previewView(result, undefined)).toMatchObject({ current: true, shown: { asOf: "2026-10-30" } });
    page.close();
  });
});
