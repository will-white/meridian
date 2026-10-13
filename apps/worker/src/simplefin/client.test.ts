import { describe, expect, it } from "vitest";
import { claimAccessUrl, fetchAccounts, SimplefinError } from "./client.js";

const ACCESS = "https://alice:s3cret@bridge.example.test/simplefin";

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
}

describe("claimAccessUrl", () => {
  const token = btoa("https://bridge.example.test/simplefin/claim/abc123");

  it("POSTs the decoded claim URL with an empty body and returns the access URL", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetch = mockFetch((url, init) => {
      seen = { url, init };
      return new Response(ACCESS, { status: 200 });
    });
    expect(await claimAccessUrl(token, { fetch })).toBe(ACCESS);
    expect(seen?.url).toBe("https://bridge.example.test/simplefin/claim/abc123");
    expect(seen?.init.method).toBe("POST");
    expect((seen?.init.headers as Record<string, string>)["Content-Length"]).toBe("0");
  });

  it("reports a 403 as a possibly compromised token and marks it permanent", async () => {
    const fetch = mockFetch(() => new Response("forbidden", { status: 403 }));
    const err = await claimAccessUrl(token, { fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimplefinError);
    expect((err as SimplefinError).kind).toBe("claim_forbidden");
    expect((err as SimplefinError).permanent).toBe(true);
    expect((err as SimplefinError).message).toMatch(/compromised/);
  });

  it("refuses a token whose claim URL is not https", async () => {
    await expect(claimAccessUrl(btoa("http://bridge.example.test/claim/x"), { fetch: mockFetch(() => new Response("")) })).rejects.toThrow(/https/);
  });

  it("rejects a non-URL claim response", async () => {
    const fetch = mockFetch(() => new Response("not a url", { status: 200 }));
    await expect(claimAccessUrl(token, { fetch })).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("fetchAccounts", () => {
  const body = {
    errors: [],
    errlist: [{ code: "act.missingdata", msg: "partial", account_id: "ACT-2" }],
    accounts: [
      {
        org: { domain: "bank.test", name: "Bank" },
        id: "ACT-1",
        name: "Checking",
        currency: "USD",
        balance: "10.00",
        "balance-date": 1760000000,
        transactions: [{ id: "T1", posted: 1759900000, amount: "-1.00", description: "COFFEE" }],
      },
    ],
  };

  it("builds the v2 query with the window, pending flag, balances-only and account filters, using basic auth", async () => {
    let seen: { url: URL; init: RequestInit } | undefined;
    const fetch = mockFetch((url, init) => {
      seen = { url: new URL(url), init };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await fetchAccounts(ACCESS, { startDate: "2026-07-01", endDate: "2026-10-02", pending: true, balancesOnly: true, accounts: ["ACT-1", "ACT-2"] }, { fetch });
    expect(`${seen!.url.origin}${seen!.url.pathname}`).toBe("https://bridge.example.test/simplefin/accounts");
    expect(seen?.url.searchParams.get("version")).toBe("2");
    expect(seen?.url.searchParams.get("start-date")).toBe(String(Date.UTC(2026, 6, 1) / 1000));
    expect(seen?.url.searchParams.get("end-date")).toBe(String(Date.UTC(2026, 9, 2) / 1000));
    expect(seen?.url.searchParams.get("pending")).toBe("1");
    expect(seen?.url.searchParams.get("balances-only")).toBe("1");
    expect(seen?.url.searchParams.getAll("account")).toEqual(["ACT-1", "ACT-2"]);
    expect((seen?.init.headers as Record<string, string>)["Authorization"]).toBe(`Basic ${Buffer.from("alice:s3cret").toString("base64")}`);
    expect(seen?.url.username).toBe("");
    expect(result.set.errlist[0]?.code).toBe("act.missingdata");
    expect(result.set.accounts[0]?.transactions[0]?.id).toBe("T1");
    expect(result.raw).toEqual(body);
  });

  it("maps 403 and 402 to permanent failures", async () => {
    const forbidden = await fetchAccounts(ACCESS, {}, { fetch: mockFetch(() => new Response("", { status: 403 })) }).catch((e: unknown) => e as SimplefinError);
    expect(forbidden).toMatchObject({ kind: "forbidden", permanent: true });
    const payment = await fetchAccounts(ACCESS, {}, { fetch: mockFetch(() => new Response("", { status: 402 })) }).catch((e: unknown) => e as SimplefinError);
    expect(payment).toMatchObject({ kind: "payment_required", permanent: true });
  });

  it("treats other HTTP errors and network failures as retryable", async () => {
    const http = await fetchAccounts(ACCESS, {}, { fetch: mockFetch(() => new Response("", { status: 503 })) }).catch((e: unknown) => e as SimplefinError);
    expect(http).toMatchObject({ kind: "http", status: 503, permanent: false });
    const net = await fetchAccounts(ACCESS, {}, {
      fetch: mockFetch(() => {
        throw new Error("ECONNRESET");
      }),
    }).catch((e: unknown) => e as SimplefinError);
    expect(net).toMatchObject({ kind: "network", permanent: false });
  });

  it("rejects a response that is not an account set", async () => {
    const bad = await fetchAccounts(ACCESS, {}, { fetch: mockFetch(() => new Response(JSON.stringify({ accounts: [{ id: 1 }] }), { status: 200 })) }).catch(
      (e: unknown) => e as SimplefinError,
    );
    expect(bad).toMatchObject({ kind: "invalid_response" });
  });

  it("refuses a non-https access URL before making any request", async () => {
    await expect(fetchAccounts("http://a:b@bridge.example.test/simplefin", {}, { fetch: mockFetch(() => new Response("")) })).rejects.toThrow(/https/);
  });
});
