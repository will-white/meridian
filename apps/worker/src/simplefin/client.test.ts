import { describe, expect, it } from "vitest";
import { claimAccessUrl, DEFAULT_SIMPLEFIN_HOSTS, fetchAccounts, readAccounts, SimplefinError } from "./client.js";

const ACCESS = "https://alice:s3cret@bridge.example.test/simplefin";
// The suites' Bridge; the default list is the real Bridge's hosts (a4-sync-parse-15).
const allowedHosts = ["bridge.example.test"];

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
    expect(await claimAccessUrl(token, { fetch, allowedHosts })).toBe(ACCESS);
    expect(seen?.url).toBe("https://bridge.example.test/simplefin/claim/abc123");
    expect(seen?.init.method).toBe("POST");
    expect((seen?.init.headers as Record<string, string>)["Content-Length"]).toBe("0");
  });

  it("reports a 403 as a possibly compromised token and marks it permanent", async () => {
    const fetch = mockFetch(() => new Response("forbidden", { status: 403 }));
    const err = await claimAccessUrl(token, { fetch, allowedHosts }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimplefinError);
    expect((err as SimplefinError).kind).toBe("claim_forbidden");
    expect((err as SimplefinError).permanent).toBe(true);
    expect((err as SimplefinError).message).toMatch(/compromised/);
  });

  it("refuses a token whose claim URL is not https", async () => {
    await expect(claimAccessUrl(btoa("http://bridge.example.test/claim/x"), { fetch: mockFetch(() => new Response("")), allowedHosts })).rejects.toThrow(/https/);
  });

  it("rejects a non-URL claim response", async () => {
    const fetch = mockFetch(() => new Response("not a url", { status: 200 }));
    await expect(claimAccessUrl(token, { fetch, allowedHosts })).rejects.toMatchObject({ kind: "invalid_response" });
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
    const result = await fetchAccounts(ACCESS, { startDate: "2026-07-01", endDate: "2026-10-02", pending: true, balancesOnly: true, accounts: ["ACT-1", "ACT-2"] }, { fetch, allowedHosts });
    expect(`${seen!.url.origin}${seen!.url.pathname}`).toBe("https://bridge.example.test/simplefin/accounts");
    expect(seen?.url.searchParams.get("version")).toBe("2");
    expect(seen?.url.searchParams.get("start-date")).toBe(String(Date.UTC(2026, 6, 1) / 1000));
    expect(seen?.url.searchParams.get("end-date")).toBe(String(Date.UTC(2026, 9, 2) / 1000));
    expect(seen?.url.searchParams.get("pending")).toBe("1");
    expect(seen?.url.searchParams.get("balances-only")).toBe("1");
    expect(seen?.url.searchParams.getAll("account")).toEqual(["ACT-1", "ACT-2"]);
    expect((seen?.init.headers as Record<string, string>)["Authorization"]).toBe(`Basic ${Buffer.from("alice:s3cret").toString("base64")}`);
    expect(seen?.url.username).toBe("");
    expect(result.raw).toEqual(body);
    const { set } = readAccounts(result.raw);
    expect(set.errlist[0]?.code).toBe("act.missingdata");
    expect(set.accounts[0]?.transactions[0]?.id).toBe("T1");
  });

  it("maps 403 and 402 to permanent failures", async () => {
    const forbidden = await fetchAccounts(ACCESS, {}, { fetch: mockFetch(() => new Response("", { status: 403 })), allowedHosts }).catch((e: unknown) => e as SimplefinError);
    expect(forbidden).toMatchObject({ kind: "forbidden", permanent: true });
    const payment = await fetchAccounts(ACCESS, {}, { fetch: mockFetch(() => new Response("", { status: 402 })), allowedHosts }).catch((e: unknown) => e as SimplefinError);
    expect(payment).toMatchObject({ kind: "payment_required", permanent: true });
  });

  it("treats other HTTP errors and network failures as retryable", async () => {
    const http = await fetchAccounts(ACCESS, {}, { fetch: mockFetch(() => new Response("", { status: 503 })), allowedHosts }).catch((e: unknown) => e as SimplefinError);
    expect(http).toMatchObject({ kind: "http", status: 503, permanent: false });
    const net = await fetchAccounts(ACCESS, {}, {
      allowedHosts,
      fetch: mockFetch(() => {
        throw new Error("ECONNRESET");
      }),
    }).catch((e: unknown) => e as SimplefinError);
    expect(net).toMatchObject({ kind: "network", permanent: false });
  });

  it("says why the server could not be reached: a certificate problem does not read as an outage, and the access URL is never quoted", async () => {
    const failure = (run: Promise<unknown>): Promise<SimplefinError> => run.then(() => new SimplefinError("http", "the request was expected to fail")).catch((e: unknown) => e as SimplefinError);
    const failing = (cause: unknown) =>
      failure(
        fetchAccounts(ACCESS, {}, {
          allowedHosts,
          fetch: mockFetch(() => {
            throw new TypeError("fetch failed", { cause });
          }),
        }),
      );
    const certificate = await failing(Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }));
    expect(certificate).toMatchObject({ kind: "network", permanent: false });
    expect(certificate.message).toBe("Could not reach the SimpleFIN server: its certificate was not accepted: self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)");
    const refused = await failing(Object.assign(new Error("connect ECONNREFUSED 203.0.113.7:443"), { code: "ECONNREFUSED" }));
    expect(refused.message).toBe("Could not reach the SimpleFIN server: connect ECONNREFUSED 203.0.113.7:443");
    const timedOut = await failure(
      fetchAccounts(ACCESS, {}, {
        allowedHosts,
        timeoutMs: 60_000,
        fetch: mockFetch(() => {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }),
      }),
    );
    expect(timedOut.message).toBe("Could not reach the SimpleFIN server: timeout (no answer within 60 seconds)");
    const quoting = await failing(new Error(`request to ${ACCESS}/accounts?version=2 failed`));
    expect(quoting.message).toBe("Could not reach the SimpleFIN server: request to https://bridge.example.test failed");
    expect(quoting.message).not.toContain("s3cret");
  });

  it("reads an account set entry by entry and refuses only a body that is not one", async () => {
    // An account it cannot read is skipped and reported; the response as a whole is fine.
    expect(readAccounts({ accounts: [{ id: 1 }] }).problems).toHaveLength(1);
    expect(() => readAccounts({ accounts: "none" })).toThrow(SimplefinError);
    expect(() => readAccounts([])).toThrow(/did not match protocol v2: the response is not an account set/);
  });

  it("refuses a non-https access URL before making any request", async () => {
    await expect(fetchAccounts("http://a:b@bridge.example.test/simplefin", {}, { fetch: mockFetch(() => new Response("")), allowedHosts })).rejects.toThrow(/https/);
  });
});

// ---- Audit batch a4-sync-parse ----

/** The error a call that must fail fails with. */
async function failed(run: Promise<unknown>): Promise<SimplefinError> {
  return run.then(
    () => {
      throw new Error("the call was expected to fail");
    },
    (e: unknown) => e as SimplefinError,
  );
}

const jsonResponse = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

/** A body that sends `first`, then fails the way an aborted fetch does. */
function failingBody(first: string, reason: unknown): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(first));
        return;
      }
      controller.error(reason);
    },
  });
}

describe("fetchAccounts keeps what it could not read (a4-sync-parse-02)", () => {
  it("a 200 that is not JSON fails with the body attached, for the import log", async () => {
    const err = await failed(fetchAccounts(ACCESS, {}, { allowedHosts, fetch: mockFetch(() => new Response("<html>maintenance</html>", { status: 200 })) }));
    expect(err).toMatchObject({ kind: "invalid_response", message: "SimpleFIN returned a response that is not JSON", raw: { notJson: "<html>maintenance</html>" } });
  });
  it("a body that is JSON but not an account set is returned as is; reading it is the job's step, after it is stored", async () => {
    const result = await fetchAccounts(ACCESS, {}, { allowedHosts, fetch: mockFetch(() => jsonResponse({ accounts: { VTI: 1 } })) });
    expect(result.raw).toEqual({ accounts: { VTI: 1 } });
  });
});

describe("response size limit (a4-sync-parse-13)", () => {
  it("refuses an account set larger than the limit, by its declared length or while reading it", async () => {
    const big = JSON.stringify({ errors: [], accounts: [], pad: "x".repeat(5000) });
    const declared = await failed(fetchAccounts(ACCESS, {}, { allowedHosts, maxResponseBytes: 1000, fetch: mockFetch(() => new Response(big, { status: 200, headers: { "content-length": String(big.length) } })) }));
    expect(declared).toMatchObject({ kind: "too_large", permanent: true, pausesSchedule: false });
    expect(declared.message).toBe("The SimpleFIN response is larger than 0.001 MB, so it was not read. If your accounts really need more, raise SIMPLEFIN_MAX_RESPONSE_MB.");
    // No declared length: the reader stops at the limit.
    const streamed = await failed(fetchAccounts(ACCESS, {}, {
      allowedHosts,
      maxResponseBytes: 1000,
      fetch: mockFetch(() => new Response(new Blob([big]).stream(), { status: 200 })),
    }));
    expect(streamed).toMatchObject({ kind: "too_large", permanent: true });
    // At the limit it is read.
    const exact = JSON.stringify({ accounts: [] });
    expect((await fetchAccounts(ACCESS, {}, { allowedHosts, maxResponseBytes: exact.length, fetch: mockFetch(() => new Response(exact)) })).raw).toEqual({ accounts: [] });
  });
  it("refuses a claim answer of more than a few kilobytes", async () => {
    const token = btoa("https://bridge.example.test/simplefin/claim/abc123");
    const err = await failed(claimAccessUrl(token, { allowedHosts, fetch: mockFetch(() => new Response(`${ACCESS}${"x".repeat(70_000)}`)) }));
    expect(err).toMatchObject({ kind: "too_large" });
  });
});

describe("a timeout while the body is read (a4-sync-parse-14)", () => {
  it("is a network failure that says so, not 'not JSON'", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const err = await failed(fetchAccounts(ACCESS, {}, { allowedHosts, timeoutMs: 3000, fetch: mockFetch(() => new Response(failingBody('{"accounts":[', timeout), { status: 200 })) }));
    expect(err).toMatchObject({ kind: "network", permanent: false, message: "Could not reach the SimpleFIN server: timeout (no answer within 3 seconds)" });
    const reset = await failed(fetchAccounts(ACCESS, {}, { allowedHosts, fetch: mockFetch(() => new Response(failingBody("{", new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) })), { status: 200 })) }));
    expect(reset).toMatchObject({ kind: "network" });
    // A body that arrives whole and is not JSON is still that.
    const text = await failed(fetchAccounts(ACCESS, {}, { allowedHosts, fetch: mockFetch(() => new Response("{oops", { status: 200 })) }));
    expect(text).toMatchObject({ kind: "invalid_response", message: "SimpleFIN returned a response that is not JSON" });
  });
});

describe("which hosts the worker talks to (a4-sync-parse-15)", () => {
  it("defaults to the SimpleFIN Bridge's hosts", () => {
    expect(DEFAULT_SIMPLEFIN_HOSTS).toEqual(["bridge.simplefin.org", "beta-bridge.simplefin.org"]);
  });
  it("refuses a setup token whose claim URL is on another host, before any request", async () => {
    let requests = 0;
    const fetch = mockFetch(() => {
      requests++;
      return new Response(ACCESS);
    });
    for (const claimUrl of ["https://192.168.1.1/admin/reboot", "https://localhost:3481/simplefin/claim/ok", "https://evil.example.invalid/claim/x"]) {
      const err = await failed(claimAccessUrl(btoa(claimUrl), { fetch }));
      expect(err).toMatchObject({ kind: "host_not_allowed", permanent: true });
      expect(err.message).toMatch(/is not a SimpleFIN host this server is set up to use/);
      expect(err.message).toMatch(/SIMPLEFIN_ALLOWED_HOSTS/);
    }
    expect(requests).toBe(0);
    // The real Bridge is allowed by default.
    expect(await claimAccessUrl(btoa("https://bridge.simplefin.org/simplefin/claim/abc"), { fetch: mockFetch(() => new Response("https://u:p@bridge.simplefin.org/simplefin")) })).toBe(
      "https://u:p@bridge.simplefin.org/simplefin",
    );
  });
  it("refuses an access URL on a different host than the claim, and does not keep it", async () => {
    const token = btoa("https://bridge.example.test/simplefin/claim/abc123");
    const err = await failed(claimAccessUrl(token, { allowedHosts: [...allowedHosts, "evil.example.invalid"], fetch: mockFetch(() => new Response("https://user:pw@evil.example.invalid/simplefin")) }));
    expect(err).toMatchObject({ kind: "access_url_refused", permanent: true });
    expect(err.message).toBe("The Bridge answered the claim with an access URL on another host (evil.example.invalid), so it was not stored. Create a new setup token at the Bridge and add the connection again.");
    expect(err.message).not.toContain("pw");
  });
  it("refuses to sync from an access URL whose host is not allowed", async () => {
    let requests = 0;
    const err = await failed(fetchAccounts("https://u:p@10.0.0.5/simplefin", {}, {
      fetch: mockFetch(() => {
        requests++;
        return jsonResponse({ accounts: [] });
      }),
    }));
    expect(err).toMatchObject({ kind: "host_not_allowed", permanent: true, pausesSchedule: false });
    expect(requests).toBe(0);
  });
});
