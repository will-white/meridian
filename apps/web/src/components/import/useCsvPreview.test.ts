import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, type QueryObserver as QueryObserverType, type QueryObserverOptions } from "@tanstack/react-query";
import type { CsvMappingInput, CsvPreviewResponse } from "@meridian/shared";
import { bankPreviewBody, type BankPreviewBody } from "../../lib/importMapping.js";
import { nextFileKey } from "./previewQuery.js";
import { useCsvPreview } from "./useCsvPreview.js";

/**
 * `useCsvPreview` itself, run by a minimal hooks runtime (audit b4-import-ui, second round). The
 * web package has no DOM test environment, so React's two hooks the module uses are replaced by
 * a runtime that keeps React's documented rules: state and effects are found by call order; a
 * state update to a value `Object.is` the current one changes nothing; after each render the
 * effects run whose dependencies changed (compared one by one with `Object.is`), and a state
 * update renders again. `useQuery` is a real `QueryObserver` on a real `QueryClient`, as
 * TanStack's own hook is, and a change of its result renders again. What runs is the module's
 * own code: the query, the effect with its dependency list, the kept state, the view.
 */
const runtime = vi.hoisted(() => {
  interface Instance {
    cells: Array<{ value: unknown }>;
    effects: Array<{ deps: readonly unknown[] | undefined; run: (() => void) | null }>;
    observers: unknown[];
    unsubscribes: Array<() => void>;
    dirty: boolean;
  }
  const at = { instance: null as Instance | null, cell: 0, effect: 0, observer: 0, client: null as unknown };
  const current = () => {
    if (!at.instance) throw new Error("a hook was called outside a render");
    return at.instance;
  };
  return {
    at,
    newInstance: (): Instance => ({ cells: [], effects: [], observers: [], unsubscribes: [], dirty: false }),
    useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
      const instance = current();
      const i = at.cell++;
      if (instance.cells.length <= i) instance.cells.push({ value: typeof initial === "function" ? (initial as () => T)() : initial });
      const cell = instance.cells[i]!;
      const set = (next: T | ((prev: T) => T)) => {
        const value = typeof next === "function" ? (next as (prev: T) => T)(cell.value as T) : next;
        if (Object.is(value, cell.value)) return;
        cell.value = value;
        instance.dirty = true;
      };
      return [cell.value as T, set];
    },
    useEffect(run: () => void, deps?: readonly unknown[]) {
      const instance = current();
      const i = at.effect++;
      const prev = instance.effects[i];
      const changed = prev === undefined || deps === undefined || prev.deps === undefined || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps![k]));
      instance.effects[i] = { deps, run: changed ? run : null };
    },
    useQuery(Observer: new (client: never, options: never) => QueryObserverType, options: QueryObserverOptions) {
      const instance = current();
      const i = at.observer++;
      if (instance.observers.length <= i) {
        const observer = new Observer(at.client as never, options as never);
        instance.unsubscribes.push(observer.subscribe(() => (instance.dirty = true)));
        instance.observers.push(observer);
      }
      const observer = instance.observers[i] as QueryObserverType;
      observer.setOptions(options);
      return observer.getCurrentResult();
    },
  };
});

vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useState: runtime.useState, useEffect: runtime.useEffect }));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => runtime.at.client, useQuery: (options: QueryObserverOptions) => runtime.useQuery(actual.QueryObserver as never, options) };
});


const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** One mounted component calling the hook: `render` runs it and its effects until nothing changes, `settle` also waits for the requests. */
function mount<R>(hook: () => R, client: QueryClient) {
  const instance = runtime.newInstance();
  let result: R | undefined;
  let renders = 0;
  const render = () => {
    for (let pass = 0; pass < 20; pass++) {
      instance.dirty = false;
      runtime.at.instance = instance;
      runtime.at.client = client;
      runtime.at.cell = runtime.at.effect = runtime.at.observer = 0;
      try {
        result = hook();
      } finally {
        runtime.at.instance = null;
      }
      renders += 1;
      for (const effect of instance.effects) {
        const run = effect.run;
        effect.run = null;
        run?.();
      }
      if (!instance.dirty) return;
    }
    throw new Error("the component never stopped rendering");
  };
  const fetching = () => instance.observers.some((o) => (o as QueryObserverType).getCurrentResult().isFetching);
  return {
    get result() {
      return result!;
    },
    get renders() {
      return renders;
    },
    render,
    /** A state change outside the hook (the page's own `setState`): the component renders again. */
    invalidate() {
      instance.dirty = true;
    },
    /** Renders, waits for the request it started, and renders again for each change, until the page is still. */
    async settle() {
      for (let pass = 0; pass < 20; pass++) {
        render();
        await vi.waitFor(() => expect(fetching()).toBe(false));
        await tick();
        if (!instance.dirty) return result!;
      }
      throw new Error("the preview never settled");
    },
    unmount() {
      for (const unsubscribe of instance.unsubscribes) unsubscribe();
      client.clear();
    },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CSV_A = "Date,Description,Amount\n11/01/2026,OAKWOOD APTS RENT,-1800.00\n11/02/2026,ACME PAYROLL,2500.00\n";
const CSV_B = "Date,Description,Amount\n12/01/2026,OAKWOOD APTS RENT,-1800.00\n";
const GUESS: CsvMappingInput = { hasHeader: true, skipRows: 0, date: { column: "Date", format: "MM/DD/YYYY" }, description: { column: "Description" }, amount: { mode: "single", column: "Amount", invert: false } };
const PROFILE_MAPPING: CsvMappingInput = { ...GUESS, amount: { mode: "single", column: "Amount", invert: true } };
const ACCT = "7f0e1c7e-3a53-4b0e-9a4c-0d6a4f3a1b11";
const PROFILE = "5b0c2f4e-9d1a-4a8e-8c57-2e1f6f0a9c22";

/**
 * The bank preview route: the mapping it used comes back as a new object on every response; a
 * mapping without a header row is refused (the names cannot be found), and so is file B once
 * `refuseB` is set.
 */
function server() {
  const control = { refuseB: false, holdB: false };
  const held: Array<() => void> = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as BankPreviewBody;
    const isB = body.csvText === CSV_B;
    if (isB && control.holdB) await new Promise<void>((resolve) => held.push(resolve));
    if (isB && control.refuseB) return json(400, { error: "The file is empty", code: "empty_csv" });
    const used = body.mapping ?? (body.profileId ? PROFILE_MAPPING : GUESS);
    if (used.hasHeader === false) return json(400, { error: 'Column "Date" referenced by name, but the file has no header row', code: "bad_mapping" });
    const response: CsvPreviewResponse = {
      headers: ["Date", "Description", "Amount"],
      sampleRows: [["Date", "Description", "Amount"]],
      mapping: structuredClone(used) as CsvPreviewResponse["mapping"],
      rows: [],
      totalRows: isB ? 1 : 2,
      duplicateCount: body.accountId ? 1 : 0,
      errors: [],
    };
    return json(200, response);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, control, release: () => held.splice(0).forEach((resolve) => resolve()) };
}

const sent = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);

/** The bank page's state and its call of the hook, as `BankImport` in pages/ImportPage.tsx makes it. */
function bankPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = { csvText: CSV_A, accountId: "", profileId: "", mapping: null as CsvMappingInput | null, fileKey: nextFileKey() };
  // The page's `setMapping`: the state changes and the page renders again.
  const onMapping = vi.fn((m: CsvMappingInput) => {
    page.mapping = m;
    rendered.invalidate();
  });
  const rendered = mount(
    () =>
      useCsvPreview<BankPreviewBody, CsvMappingInput, CsvPreviewResponse>({
        path: "/import/csv/preview",
        fileKey: page.fileKey,
        mapping: page.mapping,
        onMapping,
        bodyFor: (m) => bankPreviewBody({ csvText: page.csvText, accountId: page.accountId, profileId: page.profileId, mapping: m }),
      }),
    client,
  );
  return { page, onMapping, rendered };
}

describe("useCsvPreview (audit b4-import-ui, second round)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("previews a chosen file once and takes the server's guess without a second request", async () => {
    const { fetch } = server();
    const { page, onMapping, rendered } = bankPage();
    const view = await rendered.settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent(fetch)).toEqual([{ csvText: CSV_A }]);
    expect(onMapping).toHaveBeenCalledTimes(1);
    expect(page.mapping).toEqual(GUESS);
    expect(view).toMatchObject({ current: true, reading: false, updating: false, error: null, shown: { totalRows: 2, mapping: GUESS } });

    // Rendering again (the parent re-renders for anything else) asks nothing and adopts nothing.
    const renders = rendered.renders;
    rendered.render();
    rendered.render();
    await rendered.settle();
    expect(rendered.renders - renders).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onMapping).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });

  it("asks once per change, and a response's mapping never replaces the owner's", async () => {
    const { fetch } = server();
    const { page, onMapping, rendered } = bankPage();
    await rendered.settle();

    page.accountId = ACCT;
    expect((await rendered.settle()).shown?.duplicateCount).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent(fetch)[1]).toEqual({ csvText: CSV_A, accountId: ACCT, mapping: GUESS });

    const edited: CsvMappingInput = { ...GUESS, amount: { mode: "single", column: "Amount", invert: true } };
    page.mapping = edited;
    const view = await rendered.settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(view.shown?.mapping).toEqual(edited);
    expect(page.mapping).toBe(edited);
    expect(onMapping).toHaveBeenCalledTimes(1);

    // The saved profile: `setProfileId(id); setMapping(null)`. One request, its mapping taken once.
    page.profileId = PROFILE;
    page.mapping = null;
    await rendered.settle();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sent(fetch)[3]).toEqual({ csvText: CSV_A, accountId: ACCT, profileId: PROFILE });
    expect(onMapping).toHaveBeenCalledTimes(2);
    expect(page.mapping).toEqual(PROFILE_MAPPING);
    await rendered.settle();
    expect(fetch).toHaveBeenCalledTimes(4);
    rendered.unmount();
  });

  it("keeps the file's last answer on screen when the server refuses a change", async () => {
    const { fetch } = server();
    const { page, rendered } = bankPage();
    const good = (await rendered.settle()).shown;
    expect(good).toBeDefined();

    page.mapping = { ...GUESS, hasHeader: false };
    const refused = await rendered.settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refused.shown).toBe(good);
    expect(refused).toMatchObject({ current: false, reading: false, updating: false });
    expect(refused.error?.message).toBe('Column "Date" referenced by name, but the file has no header row');

    // Undone: the earlier answer, current again, with no request.
    page.mapping = GUESS;
    const undone = await rendered.settle();
    expect(undone).toMatchObject({ current: true, error: null });
    expect(undone.shown).toBe(good);
    expect(fetch).toHaveBeenCalledTimes(2);
    rendered.unmount();
  });

  it("never shows another file's answer: a new file starts from 'Reading file…', and its refusal shows nothing of the first file", async () => {
    const { fetch, control, release } = server();
    const { page, onMapping, rendered } = bankPage();
    const first = (await rendered.settle()).shown;
    expect(first?.totalRows).toBe(2);

    // Another file is chosen (`onFile`): new text, no mapping, a new key. Its preview is on its way.
    control.holdB = true;
    control.refuseB = true;
    page.csvText = CSV_B;
    page.mapping = null;
    page.fileKey = nextFileKey();
    rendered.render();
    expect(rendered.result).toMatchObject({ shown: undefined, current: false, reading: true, updating: false });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await tick();
    rendered.render();
    expect(rendered.result).toMatchObject({ shown: undefined, reading: true });

    // It is refused: still nothing of the first file on screen.
    control.holdB = false;
    release();
    const refused = await rendered.settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refused.shown).toBeUndefined();
    expect(refused).toMatchObject({ current: false, reading: false, error: { message: "The file is empty" } });
    expect(onMapping).toHaveBeenCalledTimes(1);
    expect(page.mapping).toBeNull();
    rendered.unmount();
  });
});
