import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFixed8 } from "@meridian/shared";
import { holdingSnapshot, householdSetting, job, security, securityAlias } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, type InvestmentSeed } from "../test/investmentSeed.js";
import { listAudit } from "./audit.js";
import {
  addSecurityAlias,
  cashSecurity,
  createSecurity,
  deleteSecurity,
  getSecurity,
  learnAliases,
  listHeldSecurityIds,
  listSecurities,
  mergeSecurities,
  resolveSecurity,
  setManualPrice,
  updateSecurity,
  updateSecurityPricing,
} from "./securities.js";

const ctx = (batchId = randomUUID()) => ({ userId: null, batchId });

describe.skipIf(!TEST_DATABASE_URL)("securities", () => {
  let t: TestDb;
  let S: InvestmentSeed;

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("lists the seed with held counts, aliases and the latest price", async () => {
    const held = await listHeldSecurityIds(t.db);
    expect(held).toEqual(new Set(Object.values(S.securities)));
    const vti = (await getSecurity(t.db, S.securities.vti))!;
    expect(vti).toMatchObject({ ticker: "VTI", held: true, heldInAccounts: 2, aliases: [], priceMode: "provider", expenseRatioPpm: 300, needsReview: false });
    expect(vti.latestPrice).toEqual({ date: "2026-10-13", close: parseFixed8("312.5"), source: "provider" });
    const all = await listSecurities(t.db);
    expect(all.map((s) => s.ticker ?? s.name)).toEqual(["AAPL", "BND", "VTI", "VXUS", "Cash (USD)", "Vanguard Target Retirement 2050 Trust"]);
    expect(all.find((s) => s.id === S.securities.tr2050)).toMatchObject({ held: true, heldInAccounts: 1, latestPrice: { date: "2026-10-09", close: parseFixed8("42"), source: "implied" } });
    expect(all.find((s) => s.id === S.securities.cash)).toMatchObject({ held: true, heldInAccounts: 1, latestPrice: null });
    expect((await listSecurities(t.db, { q: "bond" })).map((s) => s.ticker)).toEqual(["BND"]);
    expect((await listSecurities(t.db, { type: "stock" })).map((s) => s.ticker)).toEqual(["AAPL"]);
  });

  it("resolves by ticker, name and alias; a ticker key never matches by name (imports test 19)", async () => {
    // A Fidelity core position: the ** marker makes it a sweep fund; seams decision 16 keeps it implied.
    const spaxx = await resolveSecurity(t.db, { ticker: "spaxx**" }, { createIfMissing: true });
    expect(spaxx).toMatchObject({ created: true, matchedBy: "created" });
    const [spaxxRow] = await t.db.select().from(security).where(eq(security.id, spaxx.id!));
    expect(spaxxRow).toMatchObject({ ticker: "SPAXX", name: "SPAXX", type: "fund", assetClass: "cash", needsReview: true, priceMode: "implied" });
    expect(await resolveSecurity(t.db, { ticker: "$SPAXX" }, { createIfMissing: true })).toEqual({ id: spaxx.id, created: false, matchedBy: "ticker" });

    const pool = await resolveSecurity(t.db, { name: "Fidelity 500 Index Pool Class K" }, { createIfMissing: true });
    expect(pool.created).toBe(true);
    const [poolRow] = await t.db.select().from(security).where(eq(security.id, pool.id!));
    expect(poolRow).toMatchObject({ ticker: null, name: "Fidelity 500 Index Pool Class K", priceMode: "implied", type: "fund", assetClass: "us_stock", needsReview: true });
    expect(await resolveSecurity(t.db, { name: "FIDELITY 500 INDEX POOL - CLASS K" }, { createIfMissing: true })).toEqual({ id: pool.id, created: false, matchedBy: "name" });

    const fnilx = await resolveSecurity(t.db, { ticker: "FNILX", name: "Fidelity 500 Index Pool Class K" }, { createIfMissing: true });
    expect(fnilx.created).toBe(true);
    expect(fnilx.id).not.toBe(pool.id);

    // A fund name in a symbol column is not a ticker: it resolves (and creates) by name.
    const trust = await resolveSecurity(t.db, { ticker: "VANGUARD TARGET 2045 TRUST" }, { createIfMissing: true });
    expect(trust.created).toBe(true);
    const [trustRow] = await t.db.select().from(security).where(eq(security.id, trust.id!));
    expect(trustRow).toMatchObject({ ticker: null, name: "VANGUARD TARGET 2045 TRUST", type: "fund", priceMode: "implied" });
    expect(await resolveSecurity(t.db, { name: "Vanguard Target 2045 Trust" }, { createIfMissing: true })).toEqual({ id: trust.id, created: false, matchedBy: "name" });

    // The preview's "link to existing" learns the pool's name as an alias of FXAIX.
    const fxaix = await createSecurity(t.db, { ticker: "FXAIX", name: "Fidelity 500 Index Fund", type: "fund", assetClass: "us_stock" }, ctx());
    expect(fxaix).toMatchObject({ ticker: "FXAIX", priceMode: "provider", needsReview: false, aliases: [] });
    expect(await learnAliases(t.db, fxaix.id, { name: "Fidelity 500 Index Pool Class K" })).toBe(1);
    expect(await learnAliases(t.db, fxaix.id, { name: "Fidelity 500 Index Pool Class K" })).toBe(0);
    expect(await resolveSecurity(t.db, { name: "Fidelity 500 Index Pool Class K" }, { createIfMissing: false })).toEqual({ id: fxaix.id, created: false, matchedBy: "alias" });
    expect((await getSecurity(t.db, fxaix.id))!.aliases).toEqual([{ kind: "name", value: "FIDELITY 500 INDEX POOL CLASS K" }]);
    await expect(addSecurityAlias(t.db, S.securities.vti, { kind: "name", value: "Fidelity 500 Index Pool Class K" }, ctx())).rejects.toMatchObject({ status: 409, code: "alias_taken" });
    await expect(addSecurityAlias(t.db, S.securities.vxus, { kind: "ticker", value: "VTI" }, ctx())).rejects.toMatchObject({ status: 409, code: "alias_taken" });
    const withAlias = await addSecurityAlias(t.db, S.securities.vti, { kind: "ticker", value: "vti.old" }, ctx());
    expect(withAlias.aliases).toEqual([{ kind: "ticker", value: "VTI.OLD" }]);
    expect(await resolveSecurity(t.db, { ticker: "VTI.OLD" }, { createIfMissing: false })).toEqual({ id: S.securities.vti, created: false, matchedBy: "alias" });

    // Without createIfMissing the preview gets a suggestion.
    expect(await resolveSecurity(t.db, { ticker: "ZZZZ", name: "UNKNOWN CO" }, { createIfMissing: false })).toEqual({
      id: null,
      created: false,
      matchedBy: "unresolved",
      suggestion: { ticker: "ZZZZ", cusip: null, isin: null, name: "UNKNOWN CO", type: "stock", assetClass: "other" },
    });

    // Merge FXAIX <- pool: same (account, date) rows combine, the benchmark follows, one audit batch.
    await t.db.insert(holdingSnapshot).values([
      { accountId: S.accounts.roth, securityId: fxaix.id, date: "2026-10-13", quantity: "10", price: "210.123", valueCents: 210123n, source: "csv" },
      { accountId: S.accounts.roth, securityId: pool.id!, date: "2026-10-13", quantity: "5", price: "210.124", valueCents: 105062n, source: "manual" },
      { accountId: S.accounts.brokerage, securityId: pool.id!, date: "2026-10-13", quantity: "1", price: "210", valueCents: 21000n, source: "simplefin" },
    ]);
    await t.db.update(householdSetting).set({ benchmarkSecurityId: pool.id! }).where(eq(householdSetting.id, 1));
    await t.db.update(security).set({ cusip: "315911750" }).where(eq(security.id, pool.id!));
    await expect(mergeSecurities(t.db, fxaix.id, fxaix.id, ctx())).rejects.toMatchObject({ status: 400, code: "merge_self" });
    await expect(mergeSecurities(t.db, fxaix.id, S.securities.cash, ctx())).rejects.toMatchObject({ status: 400, code: "cash_security_reserved" });
    const batch = randomUUID();
    const merged = await mergeSecurities(t.db, fxaix.id, pool.id!, ctx(batch));
    expect(merged).toMatchObject({ snapshotsMerged: 1, snapshotsRepointed: 1, txnsRepointed: 0, lotsRepointed: 0, accountsRebuilt: [] });
    const rows = await t.db.select().from(holdingSnapshot).where(eq(holdingSnapshot.securityId, fxaix.id));
    const rothRow = rows.find((r) => r.accountId === S.accounts.roth)!;
    expect(parseFixed8(rothRow.quantity!)).toBe(parseFixed8("15"));
    expect(rothRow.valueCents).toBe(315185n);
    expect(parseFixed8(rothRow.price!)).toBe(parseFixed8("210.12333333"));
    expect(rothRow.source).toBe("manual");
    expect(rows.find((r) => r.accountId === S.accounts.brokerage)!.valueCents).toBe(21000n);
    expect(await t.db.select().from(security).where(eq(security.id, pool.id!))).toEqual([]);
    expect((await t.db.select().from(householdSetting).where(eq(householdSetting.id, 1)))[0]!.benchmarkSecurityId).toBe(fxaix.id);
    // The loser's CUSIP and name are now the survivor's aliases; the merge is one batch (update + delete).
    expect((await getSecurity(t.db, fxaix.id))!.aliases).toEqual([
      { kind: "cusip", value: "315911750" },
      { kind: "name", value: "FIDELITY 500 INDEX POOL CLASS K" },
    ]);
    expect(await resolveSecurity(t.db, { cusip: "315911750" }, { createIfMissing: false })).toEqual({ id: fxaix.id, created: false, matchedBy: "alias" });
    const audit = await listAudit(t.db, { batchId: batch, limit: 10 });
    expect(audit.items.map((a) => [a.entity, a.entityId, a.action])).toEqual([
      ["security", pool.id, "delete"],
      ["security", fxaix.id, "update"],
    ]);
    expect(audit.items[1]!.after).toMatchObject({ aliases: ["cusip:315911750", "name:FIDELITY 500 INDEX POOL CLASS K"] });
    await t.db.update(householdSetting).set({ benchmarkSecurityId: S.securities.vti }).where(eq(householdSetting.id, 1));
    await t.db.delete(holdingSnapshot).where(eq(holdingSnapshot.securityId, fxaix.id));
  });

  it("keeps one cash security per currency and never creates, deletes or merges it by hand", async () => {
    const a = await cashSecurity(t.db, "USD");
    const b = await cashSecurity(t.db, "usd");
    expect(a.row.id).toBe(S.securities.cash);
    expect(b).toEqual({ row: a.row, created: false });
    const eur = await cashSecurity(t.db, "EUR");
    expect(eur).toMatchObject({ created: true, row: { ticker: null, name: "Cash (EUR)", type: "cash", assetClass: "cash", priceMode: "manual", needsReview: false } });
    expect(await resolveSecurity(t.db, { ticker: "CASH & CASH INVESTMENTS" }, { createIfMissing: false })).toEqual({ id: S.securities.cash, created: false, matchedBy: "cash" });
    await expect(createSecurity(t.db, { name: "Cash", type: "cash", assetClass: "cash" }, ctx())).rejects.toMatchObject({ status: 400, code: "cash_security_reserved" });
    await expect(deleteSecurity(t.db, S.securities.cash, ctx())).rejects.toMatchObject({ status: 400, code: "cash_security_reserved" });
    await expect(setManualPrice(t.db, S.securities.cash, { date: "2026-10-13", close: parseFixed8("1") }, ctx())).rejects.toMatchObject({ status: 400, code: "cash_security_reserved" });
    await expect(updateSecurity(t.db, S.securities.cash, { ticker: "USD" }, ctx())).rejects.toMatchObject({ status: 400, code: "cash_security_reserved" });
    await expect(updateSecurity(t.db, S.securities.vti, { type: "cash" }, ctx())).rejects.toMatchObject({ status: 400, code: "cash_security_reserved" });
  });

  it("deletes only unreferenced securities", async () => {
    await expect(deleteSecurity(t.db, S.securities.vti, ctx())).rejects.toMatchObject({ status: 409, code: "security_in_use" });
    const spaxx = (await listSecurities(t.db, { q: "SPAXX" }))[0]!;
    const batch = randomUUID();
    await deleteSecurity(t.db, spaxx.id, ctx(batch));
    expect(await getSecurity(t.db, spaxx.id)).toBeUndefined();
    const audit = await listAudit(t.db, { batchId: batch, limit: 5 });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ entity: "security", entityId: spaxx.id, action: "delete", after: null });
    await expect(deleteSecurity(t.db, randomUUID(), ctx())).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("creates and updates with validation, duplicates and the split-primary rule", async () => {
    const voo = await createSecurity(t.db, { ticker: "voo", name: "Vanguard S&P 500 ETF", type: "etf", assetClass: "us_stock", expenseRatioPercent: "0.03" }, ctx());
    expect(voo).toMatchObject({ ticker: "VOO", expenseRatioPpm: 300, priceMode: "provider", needsReview: false, held: false, latestPrice: null });
    await expect(createSecurity(t.db, { ticker: "VTI", name: "Dupe", type: "etf", assetClass: "us_stock" }, ctx())).rejects.toMatchObject({ status: 409, code: "duplicate_ticker" });
    await expect(createSecurity(t.db, { ticker: "A B", name: "Bad ticker", type: "stock", assetClass: "other" }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(createSecurity(t.db, { name: "No ticker", type: "fund", assetClass: "other", priceMode: "provider" }, ctx())).rejects.toMatchObject({ status: 400, code: "ticker_required" });
    await expect(createSecurity(t.db, { ticker: "ERX", name: "Odd ratio", type: "fund", assetClass: "other", expenseRatioPercent: "0.00001" }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });

    // Review is cleared when the owner saves; an unchanged save writes nothing.
    await t.db.update(security).set({ needsReview: true }).where(eq(security.id, voo.id));
    const batch = randomUUID();
    const saved = await updateSecurity(t.db, voo.id, { notes: "index core" }, ctx(batch));
    expect(saved.security).toMatchObject({ needsReview: false, notes: "index core" });
    expect(saved.backfillJobId).toBeNull();
    expect((await listAudit(t.db, { batchId: batch, limit: 5 })).items).toHaveLength(1);
    const again = randomUUID();
    await updateSecurity(t.db, voo.id, { notes: "index core" }, ctx(again));
    expect((await listAudit(t.db, { batchId: again, limit: 5 })).items).toHaveLength(0);

    // A provider-priced security needs a ticker; the primary class must be one of the splits.
    await expect(updateSecurity(t.db, voo.id, { ticker: null }, ctx())).rejects.toMatchObject({ status: 400, code: "ticker_required" });
    const implied = await updateSecurity(t.db, voo.id, { ticker: null, priceMode: "implied" }, ctx());
    expect(implied.security).toMatchObject({ ticker: null, priceMode: "implied" });
    await expect(updateSecurity(t.db, S.securities.tr2050, { assetClass: "cash" }, ctx())).rejects.toMatchObject({ status: 400, code: "split_primary" });
    const tr = await updateSecurity(t.db, S.securities.tr2050, { assetClass: "bonds" }, ctx());
    expect(tr.security.assetClass).toBe("bonds");
    await updateSecurity(t.db, S.securities.tr2050, { assetClass: "us_stock" }, ctx());
    await expect(updateSecurity(t.db, S.securities.tr2050, { priceMode: "provider" }, ctx())).rejects.toMatchObject({ status: 400, code: "ticker_required" });
    await expect(updateSecurity(t.db, randomUUID(), { name: "x" }, ctx())).rejects.toMatchObject({ status: 404 });
  });

  it("pricing patch: provider needs a ticker; a symbol change resets the fetch state and queues a backfill (prices test 25)", async () => {
    await expect(updateSecurityPricing(t.db, S.securities.tr2050, { priceMode: "provider" }, ctx())).rejects.toMatchObject({ status: 400, code: "ticker_required" });
    await expect(updateSecurityPricing(t.db, S.securities.cash, { alwaysPrice: true }, ctx())).rejects.toMatchObject({ status: 400, code: "cash_security_reserved" });

    await t.db
      .update(security)
      .set({ priceFetchStatus: "error", priceFetchMessage: "tiingo: 503", priceFetchFailures: 2, priceNextAttemptAt: new Date("2026-10-15T00:00:00Z"), priceBackfilledFrom: "2025-01-01", priceFetchedAt: INV_SEED_NOW })
      .where(eq(security.id, S.securities.vxus));
    const unchanged = await updateSecurityPricing(t.db, S.securities.vxus, { alwaysPrice: false }, ctx());
    expect(unchanged.backfillJobId).toBeNull();

    const batch = randomUUID();
    const patched = await updateSecurityPricing(t.db, S.securities.vxus, { providerSymbol: "VXUS.X", alwaysPrice: true }, ctx(batch), { now: INV_SEED_NOW });
    expect(patched.security).toMatchObject({ providerSymbol: "VXUS.X", alwaysPrice: true, priceMode: "provider" });
    const [row] = await t.db.select().from(security).where(eq(security.id, S.securities.vxus));
    expect(row).toMatchObject({ priceFetchStatus: null, priceFetchMessage: null, priceFetchFailures: 0, priceNextAttemptAt: null, priceBackfilledFrom: null });
    expect(patched.backfillJobId).not.toBeNull();
    const [queued] = await t.db.select().from(job).where(eq(job.id, patched.backfillJobId!));
    expect(queued).toMatchObject({ type: "prices.fetch", status: "queued", payload: { reason: "refill", securityIds: [S.securities.vxus], dedupeKey: `prices:refill:${S.securities.vxus}` } });
    expect(queued!.runAt.getTime()).toBe(INV_SEED_NOW.getTime());
    const audit = await listAudit(t.db, { batchId: batch, limit: 5 });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]!.after).toMatchObject({ providerSymbol: "VXUS.X", alwaysPrice: true });

    // The same symbol again: nothing to do, no second job.
    const same = await updateSecurityPricing(t.db, S.securities.vxus, { providerSymbol: "VXUS.X" }, ctx(), { now: INV_SEED_NOW });
    expect(same.backfillJobId).toBeNull();
    // Clearing the symbol is a symbol change too, but the caller may refuse the backfill (no provider configured).
    const cleared = await updateSecurityPricing(t.db, S.securities.vxus, { providerSymbol: null }, ctx(), { queueBackfill: false });
    expect(cleared).toMatchObject({ backfillJobId: null, security: { providerSymbol: null } });
    await t.db.delete(securityAlias).where(eq(securityAlias.securityId, S.securities.vti));
    expect(INV_SEED_TODAY).toBe("2026-10-14");
  });
});
