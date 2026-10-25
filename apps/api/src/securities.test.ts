import { count, eq } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, job, security } from "@meridian/db";
import type { AllocationTargetsView, ResolveSecurityResponse, SecurityRef, SecurityView } from "@meridian/shared";
import { TEST_DATABASE_URL } from "./test/helpers.js";
import { freshInvestmentApp, viewerCookies, type InvestmentApp } from "./test/investments.js";

/**
 * Securities routes on the INV seed (imports design §4 and test 19/21; plan decisions 16–17,
 * 19): list and filters, the read-only resolver, create/patch/alias/merge/delete with their
 * error codes, the per-security allocation (seams C46), the household targets, and the
 * viewer matrix. PRICE_PROVIDER is unset in tests, so no pricing change queues a fetch.
 */

describe.skipIf(!TEST_DATABASE_URL)("securities routes", () => {
  let A: InvestmentApp;

  beforeAll(async () => {
    A = await freshInvestmentApp();
  });
  afterAll(async () => {
    await A?.t.cleanup();
  });

  const auditCount = async (): Promise<number> => (await A.t.db.db.select({ n: count() }).from(auditLog))[0]!.n;
  const securityCount = async (): Promise<number> => (await A.t.db.db.select({ n: count() }).from(security))[0]!.n;
  const getSecurity = async (id: string) => (await A.t.call({ method: "GET", url: `/api/investments/securities/${id}` })).json() as SecurityView;

  it("lists the seed's securities with held counts, latest prices and filters", async () => {
    const res = await A.t.call({ method: "GET", url: "/api/investments/securities" });
    expect(res.statusCode).toBe(200);
    const list = res.json() as SecurityView[];
    expect(list).toHaveLength(6);
    const byId = new Map(list.map((s) => [s.id, s]));
    // VTI is held in B (snapshot) and R (snapshot); its latest close is the 10-13 provider row.
    expect(byId.get(A.S.securities.vti)).toMatchObject({
      ticker: "VTI",
      type: "etf",
      assetClass: "us_stock",
      expenseRatioPpm: 300,
      priceMode: "provider",
      held: true,
      heldInAccounts: 2,
      needsReview: false,
      aliases: [],
      latestPrice: { date: "2026-10-13", close: "312.5", source: "provider" },
    });
    expect(byId.get(A.S.securities.bnd)).toMatchObject({ ticker: "BND", heldInAccounts: 1, latestPrice: { date: "2026-10-13", close: "74.8", source: "provider" } });
    expect(byId.get(A.S.securities.tr2050)).toMatchObject({ ticker: null, priceMode: "implied", heldInAccounts: 1, latestPrice: { date: "2026-10-09", close: "42", source: "implied" } });
    expect(byId.get(A.S.securities.cash)).toMatchObject({ type: "cash", assetClass: "cash", held: true, heldInAccounts: 1, latestPrice: null });

    const stocks = (await A.t.call({ method: "GET", url: "/api/investments/securities?type=stock" })).json() as SecurityView[];
    expect(stocks.map((s) => s.ticker)).toEqual(["AAPL"]);
    const review = (await A.t.call({ method: "GET", url: "/api/investments/securities?needsReview=true" })).json() as SecurityView[];
    expect(review).toEqual([]);
    const held = (await A.t.call({ method: "GET", url: "/api/investments/securities?held=true" })).json() as SecurityView[];
    expect(held).toHaveLength(6);
  });

  it("resolves a key without creating anything", async () => {
    const before = await securityCount();
    const byTicker = (await A.t.call({ method: "GET", url: "/api/investments/securities/resolve?ticker=vti" })).json() as ResolveSecurityResponse;
    expect(byTicker.status).toBe("resolved");
    if (byTicker.status === "resolved") {
      expect(byTicker.matchedBy).toBe("ticker");
      expect(byTicker.security.id).toBe(A.S.securities.vti);
    }
    const cash = (await A.t.call({ method: "GET", url: "/api/investments/securities/resolve?name=Cash" })).json() as ResolveSecurityResponse;
    expect(cash.status).toBe("resolved");
    if (cash.status === "resolved") expect(cash).toMatchObject({ matchedBy: "cash", security: { id: A.S.securities.cash } });
    const unknown = (await A.t.call({ method: "GET", url: "/api/investments/securities/resolve?ticker=ZZZZ&name=Unknown%20Co" })).json() as ResolveSecurityResponse;
    expect(unknown.status).toBe("unresolved");
    if (unknown.status === "unresolved") expect(unknown.suggestion).toMatchObject({ ticker: "ZZZZ", type: "stock", assetClass: "other" });
    expect((await A.t.call({ method: "GET", url: "/api/investments/securities/resolve" })).statusCode).toBe(400);
    expect(await securityCount()).toBe(before);
  });

  it("creates, patches (pricing fields through updateSecurityPricing), aliases, merges and deletes", async () => {
    const audits = await auditCount();
    const created = await A.t.call({
      method: "POST",
      url: "/api/investments/securities",
      payload: { ticker: "voo", name: "Vanguard S&P 500 ETF", type: "etf", assetClass: "us_stock", expenseRatioPercent: "0.03" },
    });
    expect(created.statusCode).toBe(200);
    const voo = created.json() as SecurityView;
    // The owner typed it: normalized ticker, 300 ppm, provider-priced, never needing review, not held.
    expect(voo).toMatchObject({ ticker: "VOO", expenseRatioPpm: 300, priceMode: "provider", needsReview: false, held: false, heldInAccounts: 0, latestPrice: null, alwaysPrice: false });
    expect(await auditCount()).toBe(audits + 1);

    const dupe = await A.t.call({ method: "POST", url: "/api/investments/securities", payload: { ticker: "VTI", name: "Dupe", type: "etf", assetClass: "us_stock" } });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().code).toBe("duplicate_ticker");
    const cash = await A.t.call({ method: "POST", url: "/api/investments/securities", payload: { ticker: null, name: "Cash", type: "cash", assetClass: "cash" } });
    expect(cash.statusCode).toBe(400);
    expect(cash.json().code).toBe("cash_security_reserved");

    // A non-pricing field goes through updateSecurity (one audit row).
    const notes = await A.t.call({ method: "PATCH", url: `/api/investments/securities/${voo.id}`, payload: { notes: "index fund" } });
    expect(notes.statusCode).toBe(200);
    expect(notes.json().notes).toBe("index fund");
    expect(await auditCount()).toBe(audits + 2);

    // Pricing-only bodies go through updateSecurityPricing; without a provider no fetch is queued.
    const implied = await A.t.call({ method: "PATCH", url: `/api/investments/securities/${voo.id}`, payload: { priceMode: "implied" } });
    expect(implied.json().priceMode).toBe("implied");
    const provider = await A.t.call({ method: "PATCH", url: `/api/investments/securities/${voo.id}`, payload: { priceMode: "provider", providerSymbol: "VOO" } });
    expect(provider.json()).toMatchObject({ priceMode: "provider", providerSymbol: "VOO" });
    expect(await auditCount()).toBe(audits + 4);
    const fetches = await A.t.db.db.select({ n: count() }).from(job).where(eq(job.type, "prices.fetch"));
    expect(fetches[0]!.n).toBe(0);

    const noTicker = await A.t.call({ method: "PATCH", url: `/api/investments/securities/${A.S.securities.tr2050}`, payload: { priceMode: "provider" } });
    expect(noTicker.statusCode).toBe(400);
    expect(noTicker.json().code).toBe("ticker_required");
    // TR2050 is split 54/36/10 across us_stock, intl_stock and bonds: the primary class must be one of them (C46).
    const primary = await A.t.call({ method: "PATCH", url: `/api/investments/securities/${A.S.securities.tr2050}`, payload: { assetClass: "cash" } });
    expect(primary.statusCode).toBe(400);
    expect(primary.json().code).toBe("split_primary");
    expect((await A.t.call({ method: "PATCH", url: "/api/investments/securities/00000000-0000-4000-8000-000000000000", payload: { notes: "x" } })).statusCode).toBe(404);

    // Aliases: learned on VTI, refused on VXUS.
    const alias = await A.t.call({ method: "POST", url: `/api/investments/securities/${A.S.securities.vti}/aliases`, payload: { kind: "ticker", value: "VTIX" } });
    expect(alias.statusCode).toBe(200);
    expect(alias.json().aliases).toEqual([{ kind: "ticker", value: "VTIX" }]);
    const taken = await A.t.call({ method: "POST", url: `/api/investments/securities/${A.S.securities.vxus}/aliases`, payload: { kind: "ticker", value: "VTIX" } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe("alias_taken");
    const resolved = (await A.t.call({ method: "GET", url: "/api/investments/securities/resolve?ticker=VTIX" })).json() as ResolveSecurityResponse;
    expect(resolved.status === "resolved" && resolved.matchedBy).toBe("alias");

    // Merge: VOO folds into VTI; its ticker becomes an alias; the loser is gone.
    const self = await A.t.call({ method: "POST", url: `/api/investments/securities/${A.S.securities.vti}/merge`, payload: { fromId: A.S.securities.vti } });
    expect(self.statusCode).toBe(400);
    expect(self.json().code).toBe("merge_self");
    const merged = await A.t.call({ method: "POST", url: `/api/investments/securities/${A.S.securities.vti}/merge`, payload: { fromId: voo.id } });
    expect(merged.statusCode).toBe(200);
    expect((merged.json() as SecurityView).aliases).toEqual(expect.arrayContaining([{ kind: "ticker", value: "VOO" }]));
    expect((await A.t.call({ method: "GET", url: `/api/investments/securities/${voo.id}` })).statusCode).toBe(404);

    // Delete: a referenced security is kept; an unreferenced one goes.
    const inUse = await A.t.call({ method: "DELETE", url: `/api/investments/securities/${A.S.securities.vti}` });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().code).toBe("security_in_use");
    const tmp = (await A.t.call({ method: "POST", url: "/api/investments/securities", payload: { ticker: "TMP", name: "Temporary", type: "stock", assetClass: "other" } })).json() as SecurityView;
    expect((await A.t.call({ method: "DELETE", url: `/api/investments/securities/${tmp.id}` })).json()).toEqual({ ok: true });
    expect((await A.t.call({ method: "GET", url: `/api/investments/securities/${tmp.id}` })).statusCode).toBe(404);
    expect((await getSecurity(A.S.securities.vti)).ticker).toBe("VTI");
  });

  it("sets a security's primary class and splits", async () => {
    const url = `/api/investments/securities/${A.S.securities.tr2050}/allocation`;
    const half = await A.t.call({ method: "PUT", url, payload: { assetClass: "bonds", splits: [{ assetClass: "bonds", weightBp: 5000 }, { assetClass: "us_stock", weightBp: 5000 }] } });
    expect(half.statusCode).toBe(200);
    // Splits come back in enum order.
    expect(half.json() as SecurityRef).toMatchObject({ securityId: A.S.securities.tr2050, assetClass: "bonds", splits: [{ assetClass: "us_stock", weightBp: 5000 }, { assetClass: "bonds", weightBp: 5000 }] });
    const sum = await A.t.call({ method: "PUT", url, payload: { assetClass: "us_stock", splits: [{ assetClass: "us_stock", weightBp: 6000 }, { assetClass: "bonds", weightBp: 3000 }] } });
    expect(sum.statusCode).toBe(400);
    expect(sum.json().code).toBe("split_sum");
    const primary = await A.t.call({ method: "PUT", url, payload: { assetClass: "cash", splits: [{ assetClass: "us_stock", weightBp: 5000 }, { assetClass: "bonds", weightBp: 5000 }] } });
    expect(primary.statusCode).toBe(400);
    expect(primary.json().code).toBe("split_primary");
    const none = await A.t.call({ method: "PUT", url, payload: { assetClass: "us_stock", splits: null } });
    expect(none.json()).toMatchObject({ assetClass: "us_stock", splits: [] });
    const cash = await A.t.call({ method: "PUT", url: `/api/investments/securities/${A.S.securities.cash}/allocation`, payload: { assetClass: "bonds", splits: null } });
    expect(cash.statusCode).toBe(400);
    expect(cash.json().code).toBe("cash_security_reserved");
  });

  it("replaces the household allocation targets as a whole set", async () => {
    const seeded = (await A.t.call({ method: "GET", url: "/api/investments/allocation-targets" })).json() as AllocationTargetsView;
    expect(seeded.targets.filter((t) => t.targetBp > 0)).toEqual([
      { assetClass: "us_stock", targetBp: 5000 },
      { assetClass: "intl_stock", targetBp: 2500 },
      { assetClass: "bonds", targetBp: 2000 },
      { assetClass: "cash", targetBp: 500 },
    ]);
    const audits = await auditCount();
    const body = { targets: [{ assetClass: "us_stock", targetBp: 6000 }, { assetClass: "intl_stock", targetBp: 2000 }, { assetClass: "bonds", targetBp: 1500 }, { assetClass: "cash", targetBp: 500 }] };
    const set = await A.t.call({ method: "PUT", url: "/api/investments/allocation-targets", payload: body });
    expect(set.statusCode).toBe(200);
    expect((set.json() as AllocationTargetsView).targets.filter((t) => t.targetBp > 0)).toEqual(body.targets);
    expect(await auditCount()).toBe(audits + 1);
    await A.t.call({ method: "PUT", url: "/api/investments/allocation-targets", payload: body });
    expect(await auditCount()).toBe(audits + 1);
    const short = await A.t.call({ method: "PUT", url: "/api/investments/allocation-targets", payload: { targets: [{ assetClass: "us_stock", targetBp: 6000 }, { assetClass: "bonds", targetBp: 3000 }] } });
    expect(short.statusCode).toBe(400);
    expect(short.json().code).toBe("allocation_sum");
    const dupe = await A.t.call({ method: "PUT", url: "/api/investments/allocation-targets", payload: { targets: [{ assetClass: "us_stock", targetBp: 5000 }, { assetClass: "us_stock", targetBp: 5000 }] } });
    expect(dupe.statusCode).toBe(400);
    expect(dupe.json().code).toBe("validation");
    const cleared = await A.t.call({ method: "PUT", url: "/api/investments/allocation-targets", payload: { targets: [] } });
    expect((cleared.json() as AllocationTargetsView).targets.filter((t) => t.targetBp > 0)).toEqual([]);
  });

  it("lets a viewer read and refuses every mutation", async () => {
    const cookies = await viewerCookies(A.t);
    const reads = ["/api/investments/securities", `/api/investments/securities/${A.S.securities.vti}`, "/api/investments/securities/resolve?ticker=VTI", "/api/investments/allocation-targets"];
    for (const url of reads) expect((await A.t.app.inject({ method: "GET", url, cookies })).statusCode).toBe(200);
    const writes: Array<{ method: "POST" | "PATCH" | "PUT" | "DELETE"; url: string; payload?: Record<string, unknown> }> = [
      { method: "POST", url: "/api/investments/securities", payload: { ticker: "NEW", name: "New", type: "stock", assetClass: "other" } },
      { method: "PATCH", url: `/api/investments/securities/${A.S.securities.vti}`, payload: { notes: "x" } },
      { method: "DELETE", url: `/api/investments/securities/${A.S.securities.vti}` },
      { method: "POST", url: `/api/investments/securities/${A.S.securities.vti}/merge`, payload: { fromId: A.S.securities.vxus } },
      { method: "POST", url: `/api/investments/securities/${A.S.securities.vti}/aliases`, payload: { kind: "ticker", value: "X" } },
      { method: "PUT", url: `/api/investments/securities/${A.S.securities.vti}/allocation`, payload: { assetClass: "us_stock", splits: null } },
      { method: "PUT", url: "/api/investments/allocation-targets", payload: { targets: [] } },
    ];
    for (const w of writes) {
      const opts: InjectOptions = { method: w.method, url: w.url, cookies };
      if (w.payload !== undefined) opts.payload = w.payload;
      const res = await A.t.app.inject(opts);
      expect(res.statusCode, `${w.method} ${w.url}`).toBe(403);
      expect(res.json().code).toBe("viewer");
    }
  });
});
