import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, transaction, user } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { auditJsonEqual, listAudit, PlanError, toAuditJson, writeAudit } from "./audit.js";
import { getHouseholdSetting, householdToday, updateHouseholdSetting } from "./settings.js";

describe("audit helpers", () => {
  it("normalizes bigint, Date and undefined into plain JSON", () => {
    expect(toAuditJson({ cents: 1234n, at: new Date("2026-10-13T12:00:00Z"), gone: undefined, list: [1n, null], nested: { x: -1n } })).toEqual({
      cents: "1234",
      at: "2026-10-13T12:00:00.000Z",
      list: ["1", null],
      nested: { x: "-1" },
    });
    expect(toAuditJson(undefined)).toBeNull();
  });

  it("compares structurally, ignoring key order", () => {
    expect(auditJsonEqual({ a: 1, b: [1, { c: "x" }] }, { b: [1, { c: "x" }], a: 1 })).toBe(true);
    expect(auditJsonEqual({ a: 1 }, { a: 1, b: null })).toBe(false);
    expect(auditJsonEqual([1, 2], [2, 1])).toBe(false);
    expect(auditJsonEqual(null, null)).toBe(true);
    expect(auditJsonEqual(null, {})).toBe(false);
  });

  it("PlanError carries status and code", () => {
    const e = new PlanError(409, "in_use", "Category is in use");
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ status: 409, code: "in_use", name: "PlanError" });
    expect(e.message).toBe("Category is in use");
  });

  it("householdToday uses the household time zone", () => {
    const instant = new Date("2026-10-14T03:30:00Z"); // still Oct 13 in Denver
    expect(householdToday({ timezone: "America/Denver" }, instant)).toBe("2026-10-13");
    expect(householdToday({ timezone: "UTC" }, instant)).toBe("2026-10-14");
    expect(householdToday({ timezone: "Not/AZone" }, instant)).toBe("2026-10-13");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("audit log and household settings", () => {
  let t: TestDb;
  let userId: string;

  beforeAll(async () => {
    t = await createTestDb();
    const [u] = await t.db.insert(user).values({ username: "will", passwordHash: "x" }).returning({ id: user.id });
    userId = u!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("creates the settings row on first read with the current month when the ledger is empty", async () => {
    const setting = await getHouseholdSetting(t.db, "2026-10-13");
    expect(setting).toMatchObject({ id: 1, planStartMonth: "2026-10", zeroBased: false, timezone: "America/Denver", projectionDefaultDays: 90, lowBalanceThresholdCents: 0n });
    expect(await getHouseholdSetting(t.db, "2027-01-01")).toMatchObject({ planStartMonth: "2026-10" });
  });

  it("uses the earliest transaction month on a fresh database with history", async () => {
    const fresh = await createTestDb();
    try {
      const [a] = await fresh.db.insert(account).values({ name: "Chk", type: "checking", taxTreatment: "none" }).returning({ id: account.id });
      await fresh.db.insert(transaction).values([
        { accountId: a!.id, source: "manual", date: "2025-03-14", amountCents: -100n, rawDescription: "old" },
        { accountId: a!.id, source: "manual", date: "2026-09-01", amountCents: -100n, rawDescription: "new" },
      ]);
      expect((await getHouseholdSetting(fresh.db, "2026-10-13")).planStartMonth).toBe("2025-03");
    } finally {
      await fresh.cleanup();
    }
  });

  it("writes an entry, skips when before equals after, and records the user", async () => {
    const batchId = randomUUID();
    const base = { userId, batchId, entity: "category" as const, entityId: "cat-1" };
    expect(await writeAudit(t.db, { ...base, action: "create", before: null, after: { name: "A", cents: 5n } })).toBe(true);
    expect(await writeAudit(t.db, { ...base, action: "update", before: { name: "A", cents: 5n }, after: { cents: "5", name: "A" } })).toBe(false);
    expect(await writeAudit(t.db, { ...base, action: "update", before: { name: "A" }, after: { name: "B" } })).toBe(true);
    const { items, nextCursor } = await listAudit(t.db, { entityId: "cat-1", limit: 10 });
    expect(nextCursor).toBeNull();
    expect(items.map((e) => e.action)).toEqual(["update", "create"]);
    expect(items[1]).toMatchObject({ userId, username: "will", batchId, entity: "category", before: null, after: { name: "A", cents: "5" } });
    expect(items[0]!.at).toBeInstanceOf(Date);
  });

  it("filters by entity and batch and pages newest first without overlap", async () => {
    const batchA = randomUUID();
    const batchB = randomUUID();
    for (let i = 0; i < 5; i++) {
      await writeAudit(t.db, { userId: null, batchId: i < 3 ? batchA : batchB, entity: "month_plan", entityId: `2026-1${i}:x`, action: "create", before: null, after: { i } });
    }
    expect((await listAudit(t.db, { batchId: batchA, limit: 10 })).items).toHaveLength(3);
    expect((await listAudit(t.db, { entity: "month_plan", limit: 10 })).items).toHaveLength(5);
    expect((await listAudit(t.db, { entity: "category", limit: 10 })).items).toHaveLength(2);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await listAudit(t.db, { entity: "month_plan", limit: 2, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((e) => e.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const all = await listAudit(t.db, { entity: "month_plan", limit: 10 });
    expect(seen).toEqual(all.items.map((e) => e.id));
    expect(all.items.map((e) => (e.after as { i: number }).i)).toEqual([4, 3, 2, 1, 0]);
    expect((await listAudit(t.db, { entity: "month_plan", limit: 2, cursor: "not-a-cursor" })).items).toHaveLength(2);
  });

  it("updates settings with an audit row and rejects bad values", async () => {
    const batchId = randomUUID();
    const after = await updateHouseholdSetting(t.db, { planStartMonth: "2026-08", timezone: "America/Chicago", projectionDefaultDays: 60 }, { userId, batchId });
    expect(after).toMatchObject({ planStartMonth: "2026-08", timezone: "America/Chicago", projectionDefaultDays: 60 });
    const { items } = await listAudit(t.db, { batchId, limit: 5 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ entity: "household_setting", entityId: "1", action: "update", username: "will" });
    expect(items[0]!.before).toMatchObject({ planStartMonth: "2026-10", timezone: "America/Denver" });
    expect(items[0]!.after).toMatchObject({ planStartMonth: "2026-08", timezone: "America/Chicago", projectionDefaultDays: 60 });
    await expect(updateHouseholdSetting(t.db, { planStartMonth: "2026-13" }, { userId, batchId })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(updateHouseholdSetting(t.db, { projectionDefaultDays: 0 }, { userId, batchId })).rejects.toMatchObject({ status: 400 });
    expect(await updateHouseholdSetting(t.db, {}, { userId, batchId })).toMatchObject({ planStartMonth: "2026-08" });
  });
});
