import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { previewQueryOptions } from "./previewQuery.js";

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
