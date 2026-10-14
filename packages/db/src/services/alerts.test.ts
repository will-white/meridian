import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alert, payee, recurring } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { countOpenAlerts, dismissAlert, dismissAllAlerts, getAlert, listAlerts, toAlertView } from "./alerts.js";

const at = (iso: string): Date => new Date(iso);

describe.skipIf(!TEST_DATABASE_URL)("alerts", () => {
  let t: TestDb;
  let ids: Record<string, string>;

  beforeAll(async () => {
    t = await createTestDb();
    const [netflix] = await t.db.insert(payee).values({ name: "Netflix" }).returning({ id: payee.id });
    const [hulu] = await t.db.insert(payee).values({ name: "Hulu" }).returning({ id: payee.id });
    const [item] = await t.db
      .insert(recurring)
      .values({ payeeId: netflix!.id, name: "Netflix", cadence: "monthly", anchorDay: 5, expectedCents: -1549n, toleranceCents: 100n, source: "detected", status: "active" })
      .returning({ id: recurring.id });
    const rows = await t.db
      .insert(alert)
      .values([
        { kind: "missed_charge", recurringId: item!.id, payeeId: netflix!.id, dueDate: "2026-09-05", dedupeKey: "missed:x:2026-09-05", createdAt: at("2026-10-09T08:00:00Z"), dismissedAt: at("2026-10-09T09:00:00Z") },
        { kind: "new_recurring", recurringId: item!.id, payeeId: netflix!.id, dedupeKey: "new:x", createdAt: at("2026-10-10T08:00:00Z"), resolvedAt: at("2026-10-10T09:00:00Z") },
        { kind: "missed_charge", recurringId: item!.id, payeeId: netflix!.id, dueDate: "2026-10-05", dedupeKey: "missed:x:2026-10-05", createdAt: at("2026-10-11T08:00:00Z") },
        { kind: "price_increase", recurringId: item!.id, payeeId: netflix!.id, oldCents: -1549n, newCents: -1799n, dedupeKey: "price:x:t", createdAt: at("2026-10-12T08:00:00Z") },
        { kind: "trial_converted", recurringId: null, payeeId: hulu!.id, newCents: -1799n, dedupeKey: "trial:h:t", createdAt: at("2026-10-13T08:00:00Z") },
      ])
      .returning({ id: alert.id, dedupeKey: alert.dedupeKey });
    ids = Object.fromEntries(rows.map((r) => [r.dedupeKey, r.id]));
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("lists open alerts newest first, with the payee and item names", async () => {
    const open = await listAlerts(t.db);
    expect(open.map((a) => a.id)).toEqual([ids["trial:h:t"], ids["price:x:t"], ids["missed:x:2026-10-05"]]);
    expect(open[0]).toMatchObject({ kind: "trial_converted", recurringId: null, recurringName: null, payeeName: "Hulu", newCents: -1799n, oldCents: null, dismissedAt: null, resolvedAt: null });
    expect(open[1]).toMatchObject({ kind: "price_increase", recurringName: "Netflix", payeeName: "Netflix", oldCents: -1549n, newCents: -1799n });
    expect(open[2]).toMatchObject({ kind: "missed_charge", dueDate: "2026-10-05" });
    expect(await countOpenAlerts(t.db)).toBe(3);

    expect((await listAlerts(t.db, { includeResolved: true })).map((a) => a.id)).toEqual([ids["trial:h:t"], ids["price:x:t"], ids["missed:x:2026-10-05"], ids["new:x"]]);
    expect((await listAlerts(t.db, { includeDismissed: true })).map((a) => a.id)).toEqual([ids["trial:h:t"], ids["price:x:t"], ids["missed:x:2026-10-05"], ids["missed:x:2026-09-05"]]);
    expect((await listAlerts(t.db, { includeDismissed: true, includeResolved: true })).length).toBe(5);
    expect((await listAlerts(t.db, { kind: "missed_charge" })).map((a) => a.id)).toEqual([ids["missed:x:2026-10-05"]]);
    expect((await listAlerts(t.db, { limit: 1 })).map((a) => a.id)).toEqual([ids["trial:h:t"]]);
  });

  it("serializes to the API view", async () => {
    const a = (await getAlert(t.db, ids["price:x:t"]!))!;
    expect(toAlertView(a)).toEqual({
      id: a.id,
      kind: "price_increase",
      recurringId: a.recurringId,
      recurringName: "Netflix",
      payeeId: a.payeeId,
      payeeName: "Netflix",
      transactionId: null,
      dueDate: null,
      oldCents: "-1549",
      newCents: "-1799",
      createdAt: "2026-10-12T08:00:00.000Z",
      dismissedAt: null,
      resolvedAt: null,
    });
  });

  it("dismisses idempotently", async () => {
    const first = at("2026-10-13T10:00:00Z");
    const dismissed = await dismissAlert(t.db, ids["missed:x:2026-10-05"]!, first);
    expect(dismissed?.dismissedAt?.getTime()).toBe(first.getTime());
    const again = await dismissAlert(t.db, ids["missed:x:2026-10-05"]!, at("2026-10-13T11:00:00Z"));
    expect(again?.dismissedAt?.getTime()).toBe(first.getTime());
    expect(await dismissAlert(t.db, "00000000-0000-4000-8000-000000000000")).toBeUndefined();
    expect(await countOpenAlerts(t.db)).toBe(2);
  });

  it("dismisses all open alerts, optionally of one kind", async () => {
    expect(await dismissAllAlerts(t.db, "price_increase")).toBe(1);
    expect(await countOpenAlerts(t.db)).toBe(1);
    expect(await dismissAllAlerts(t.db)).toBe(1);
    expect(await countOpenAlerts(t.db)).toBe(0);
    expect(await dismissAllAlerts(t.db)).toBe(0);
    // Resolved alerts are not touched by dismiss-all.
    const [resolved] = await t.db.select().from(alert).where(eq(alert.id, ids["new:x"]!));
    expect(resolved!.dismissedAt).toBeNull();
    expect(await listAlerts(t.db)).toHaveLength(0);
  });
});
